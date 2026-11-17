import { randomUUID, createHash } from 'node:crypto';
import { Router } from 'express';
import { HEADER_PHOTO_ID_PATTERN, type ResumeDocument } from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import { nowIso, type AppDeps } from '../../core/context';
import { createUploadSingle } from '../../core/files/upload';
import { AppError, notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';

// Header photos: small JPEG or PNG images an account puts in the header of its resumes (the editor crops them and
// resizes them to 400 x 400 first). They live in resume_photos (migration 0104), not in the file store, which holds
// only uploaded documents, and a resume names one by id in `header.photo`. Owner-scoped throughout: another account's
// photo is not found, and a resume can only name its own account's photos. A photo no resume names any more goes
// after an hour (long enough for the save that names a photo just uploaded).

export const MAX_PHOTO_BYTES = 1_048_576;
const PHOTO_GRACE_MS = 60 * 60 * 1000;
const PHOTO_CACHE = 'private, max-age=31536000, immutable';
const NOT_A_PHOTO = 'Choose a JPG or PNG image for the photo.';

export interface PhotoInfo {
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

/** What the bytes are, read from their own header (never from a name or a declared type); null when not a photo. */
export function photoInfo(bytes: Buffer): PhotoInfo | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { mime: 'image/png', width, height } : null;
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // The frame header (SOFn, any but the DHT, JPG and DAC markers that share the range) holds the size.
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      // Markers that stand alone, with no length after them.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        at += 2;
        continue;
      }
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = bytes.readUInt16BE(at + 5);
        const width = bytes.readUInt16BE(at + 7);
        return width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : null;
      }
      if (length < 2) return null;
      at += 2 + length;
    }
  }
  return null;
}

/** Stores a photo for the account; 400 for anything that is not a JPEG or PNG, 413 above the size cap. */
export async function savePhoto(deps: AppDeps, userId: string, bytes: Buffer): Promise<PhotoInfo & { photoId: string }> {
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw refuse(deps, 'file_too_large', 'MSG_PHOTO_TOO_LARGE', { max_mb: MAX_PHOTO_BYTES / 1_048_576 });
  }
  const info = photoInfo(bytes);
  if (!info) throw new AppError('unsupported_file', NOT_A_PHOTO);
  const photoId = randomUUID();
  await deps.db.run(
    `INSERT INTO resume_photos(id, user_id, mime, bytes, size_bytes, sha256, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      photoId,
      userId,
      info.mime,
      bytes,
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      info.width,
      info.height,
      nowIso(deps),
    ],
  );
  await prunePhotos(deps, userId);
  return { photoId, ...info };
}

/** One of the account's photos; null for any other id. */
export async function readPhoto(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  photoId: string,
): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!HEADER_PHOTO_ID_PATTERN.test(photoId)) return null;
  const row = await deps.db.one<{ mime: string; bytes: Buffer }>('SELECT mime, bytes FROM resume_photos WHERE id = ? AND user_id = ?', [
    photoId,
    userId,
  ]);
  return row ?? null;
}

/** A photo as an inline image address, for print (the print browser loads nothing but data: URLs). */
export async function photoDataUrl(deps: Pick<AppDeps, 'db'>, userId: string, photoId: string): Promise<string | null> {
  const photo = await readPhoto(deps, userId, photoId);
  return photo ? `data:${photo.mime};base64,${photo.bytes.toString('base64')}` : null;
}

/** The document without a header photo the account does not own (the same object when it names none, or its own). */
export async function withOwnPhoto(deps: Pick<AppDeps, 'db'>, userId: string, document: ResumeDocument): Promise<ResumeDocument> {
  const photo = document.header?.photo;
  if (!photo) return document;
  const owned = await deps.db.one('SELECT 1 FROM resume_photos WHERE id = ? AND user_id = ?', [photo.photoId, userId]);
  if (owned) return document;
  const { photo: _foreign, ...header } = document.header!;
  return { ...document, header };
}

/** Deletes the account's photos that no resume names and that are older than the grace hour. */
export async function prunePhotos(deps: AppDeps, userId: string): Promise<void> {
  const before = new Date(deps.now().getTime() - PHOTO_GRACE_MS).toISOString();
  const photoIdOf = deps.db.dialect.jsonText('data', '$.header.photo.photoId');
  await deps.db.run(
    `DELETE FROM resume_photos WHERE user_id = ? AND created_at < ? AND id NOT IN (
         SELECT ${photoIdOf} FROM resumes WHERE user_id = ? AND data IS NOT NULL AND ${photoIdOf} IS NOT NULL)`,
    [userId, before, userId],
  );
}

/** Mounted at /api/resumes/photos (before /api/resumes, whose GET /:id would take 'photos' for a resume id). */
export function createResumePhotosRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const photoField = createUploadSingle(MAX_PHOTO_BYTES, 1)('photo');

  router.post('/', photoField, async (req, res) => {
    const saved = await savePhoto(deps, userOf(req).id, req.file!.buffer);
    res.status(201).json(saved);
  });

  router.get('/:id', async (req, res, next) => {
    const photo = await readPhoto(deps, userOf(req).id, String(req.params.id));
    if (!photo) return next(notFound('That photo'));
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Cache-Control', PHOTO_CACHE);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Content-Disposition', 'inline');
    res.end(photo.bytes);
  });

  return router;
}
