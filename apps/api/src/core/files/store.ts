import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RequestHandler } from 'express';
import { constantsOf } from '../constants/service';
import { nowIso, type AppDeps } from '../context';
import { AppError, notFound } from '../http/errors';
import { detectFileKind, isPasswordProtectedOffice, kindOfMime, MIME_BY_KIND, type FileKind } from './detect';
import { cleanFileName } from './names';
import { assertDocxUnpackable } from './unpack';
import { createUploadSingle, fileTooLarge, type FileTooLargeWords, type UploadSingleOptions } from './upload';

// Uploaded files live under <DATA_DIR>/files/<userId>/<fileId> (thumbnails beside them as <fileId>.thumb.png), with
// one stored_files row each. Every read is by owner: someone else's file is "not found", never "forbidden".

export const FILE_PURPOSES = ['resume', 'letter_import', 'template_import', 'job_import'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export interface StoredFile {
  id: string;
  userId: string;
  purpose: FilePurpose;
  /** The uploader's file name, cleaned (see cleanFileName). */
  originalName: string;
  /** Decided from the bytes, never from the browser's claim. */
  mime: string;
  kind: FileKind | null;
  sizeBytes: number;
  sha256: string;
  /** Relative to the files root, '/'-separated: `<userId>/<fileId>`. */
  storagePath: string;
  thumbPath: string | null;
  pageCount: number | null;
  createdAt: string;
}

export interface SaveFileInput {
  userId: string;
  purpose: FilePurpose;
  buffer: Buffer;
  originalName: string;
  /** What this upload may be. Default: PDF or DOCX. */
  accept?: readonly FileKind[];
}

/**
 * v3.0 D2: the methods that read or write a stored_files row are async (deps.db), and refuse to run inside a
 * transaction (assertNoTx: the bytes are files, outside I/O).
 */
export interface FileStore {
  /** <DATA_DIR>/files */
  readonly root: string;
  /** UPLOAD_MAX_MB in bytes. */
  readonly maxBytes: number;
  save(input: SaveFileInput): Promise<StoredFile>;
  get(fileId: string, userId: string): Promise<StoredFile | null>;
  read(fileId: string, userId: string): Promise<{ file: StoredFile; buffer: Buffer }>;
  remove(fileId: string, userId: string): Promise<boolean>;
  pathOf(file: StoredFile | string): Promise<string>;
  saveThumbnail(fileId: string, png: Buffer): Promise<void>;
  readThumbnail(fileId: string, userId: string): Promise<Buffer | null>;
  setPageCount(fileId: string, pageCount: number | null): Promise<void>;
  /** multer middleware for one file in `fieldName` (memory storage, capped at UPLOAD_MAX_MB): sets req.file. */
  uploadSingle(fieldName: string, options?: UploadSingleOptions): RequestHandler;
}

declare module '../context' {
  interface AppServices {
    /** Uploaded file storage (core/files, registered by features/files). */
    files?: FileStore;
  }
}

/** The file store, for features that need it (registered by the files feature at startup). */
export function getFileStore(deps: Pick<AppDeps, 'services'>): FileStore {
  const store = deps.services.files;
  if (!store) throw new AppError('internal', 'File storage is not set up on this server.');
  return store;
}


interface FileRow {
  id: string;
  user_id: string;
  purpose: FilePurpose;
  original_name: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  thumb_path: string | null;
  page_count: number | null;
  created_at: string;
}

function toStoredFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    originalName: row.original_name,
    mime: row.mime,
    kind: kindOfMime(row.mime),
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storagePath: row.storage_path,
    thumbPath: row.thumb_path,
    pageCount: row.page_count,
    createdAt: row.created_at,
  };
}

const KIND_LABEL: Record<FileKind, string> = { pdf: 'PDF', docx: 'DOCX', doc: 'DOC' };
const DEFAULT_ACCEPT: readonly FileKind[] = ['pdf', 'docx'];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** "Please upload a PDF or DOCX file." for the default; the list follows `accept`. */
function unsupportedFile(accept: readonly FileKind[], buffer: Buffer, detected: FileKind | null): AppError {
  if (isPasswordProtectedOffice(buffer)) {
    return new AppError(
      'unsupported_file',
      'That document is password-protected. Remove the password, save it, and upload it again.',
    );
  }
  const labels = accept.map((kind) => KIND_LABEL[kind]);
  const last = labels.pop() ?? 'supported';
  const message = `Please upload a ${labels.length ? `${labels.join(', ')} or ${last}` : last} file.`;
  if (detected === 'doc') {
    return new AppError('unsupported_file', `${message} Save Word 97-2003 documents as .docx first.`);
  }
  return new AppError('unsupported_file', message);
}

/** Ids become path segments, so only plain ones are allowed (ours are UUIDs). */
function assertPlainId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`Refusing to use "${id}" in a file path.`);
}

/** Write to a temporary name and rename, so a crash never leaves a half-written file under the real name. */
function writeAtomically(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, data, { flag: 'wx' });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}


/** The store's SQL. */
const FILE_SQL = {
  byId: 'SELECT * FROM stored_files WHERE id = ?',
  own: 'SELECT * FROM stored_files WHERE id = ? AND user_id = ?',
  insert: `INSERT INTO stored_files(id, user_id, purpose, original_name, mime, size_bytes, sha256, storage_path,
    thumb_path, page_count, created_at)
    VALUES (@id, @user_id, @purpose, @original_name, @mime, @size_bytes, @sha256, @storage_path, @thumb_path,
      @page_count, @created_at)`,
  remove: 'DELETE FROM stored_files WHERE id = ? AND user_id = ?',
  thumb: 'UPDATE stored_files SET thumb_path = ? WHERE id = ?',
  pages: 'UPDATE stored_files SET page_count = ? WHERE id = ?',
} as const;

export function createFileStore(deps: AppDeps): FileStore {
  const root = join(deps.config.dataDir, 'files');
  const maxMb = deps.config.uploadMaxMb;
  const maxBytes = maxMb * 1024 * 1024;
  // v30 INT-0: a file over UPLOAD_MAX_MB is refused in MSG_FILE_TOO_LARGE's words, read when it happens.
  const tooLargeWords: FileTooLargeWords = (params) => constantsOf(deps).message('MSG_FILE_TOO_LARGE', params);
  const absolute = (relative: string) => join(root, ...relative.split('/'));
  const outside = () => deps.db.assertNoTx('the file store');

  /** Checks the upload and writes its bytes; answers the row to insert (save and its twin). */
  function written({ userId, purpose, buffer, originalName, accept = DEFAULT_ACCEPT }: SaveFileInput): FileRow {
    if (buffer.length > maxBytes) throw fileTooLarge(originalName, maxMb, tooLargeWords);
    const kind = detectFileKind(buffer);
    if (!kind || !accept.includes(kind)) throw unsupportedFile(accept, buffer, kind);
    // A ZIP bomb is refused before it is stored (and long before anything unpacks it).
    if (kind === 'docx') assertDocxUnpackable(buffer);
    assertPlainId(userId);

    const id = randomUUID();
    const storagePath = `${userId}/${id}`;
    writeAtomically(absolute(storagePath), buffer);
    return {
      id,
      user_id: userId,
      purpose,
      original_name: cleanFileName(originalName),
      mime: MIME_BY_KIND[kind],
      size_bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      storage_path: storagePath,
      thumb_path: null,
      page_count: null,
      created_at: nowIso(deps),
    };
  }

  /** The bytes of a file found (read and its twin). */
  function bytesOf(file: StoredFile | null): { file: StoredFile; buffer: Buffer } {
    const buffer = file ? readIfPresent(absolute(file.storagePath)) : null;
    if (!file || !buffer) throw notFound('That file');
    return { file, buffer };
  }

  /** Deletes a removed row's bytes and thumbnail (remove and its twin). */
  function unlink(row: FileRow): void {
    for (const relative of [row.storage_path, row.thumb_path]) {
      if (!relative) continue;
      try {
        rmSync(absolute(relative), { force: true });
      } catch (error) {
        deps.log.warn(`[files] could not delete ${relative}`, error);
      }
    }
  }

  function assertPng(png: Buffer): void {
    if (!(png.length > PNG_MAGIC.length && png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC))) {
      throw new Error('A thumbnail must be a PNG image.');
    }
  }

  const store: FileStore = {
    root,
    maxBytes,

    async save(input) {
      outside();
      const row = written(input);
      try {
        await deps.db.run(FILE_SQL.insert, { ...row });
      } catch (error) {
        rmSync(absolute(row.storage_path), { force: true });
        throw error;
      }
      return toStoredFile(row);
    },

    async get(fileId, userId) {
      const row = await deps.db.one<FileRow>(FILE_SQL.own, [fileId, userId]);
      return row ? toStoredFile(row) : null;
    },

    async read(fileId, userId) {
      outside();
      return bytesOf(await store.get(fileId, userId));
    },

    async remove(fileId, userId) {
      outside();
      const row = await deps.db.one<FileRow>(FILE_SQL.own, [fileId, userId]);
      if (!row) return false;
      await deps.db.run(FILE_SQL.remove, [fileId, userId]);
      unlink(row);
      return true;
    },

    async pathOf(file) {
      if (typeof file !== 'string') return absolute(file.storagePath);
      const row = await deps.db.one<FileRow>(FILE_SQL.byId, [file]);
      if (!row) throw notFound('That file');
      return absolute(row.storage_path);
    },

    async saveThumbnail(fileId, png) {
      outside();
      assertPng(png);
      const row = await deps.db.one<FileRow>(FILE_SQL.byId, [fileId]);
      if (!row) throw notFound('That file');
      const thumbPath = `${row.storage_path}.thumb.png`;
      writeAtomically(absolute(thumbPath), png);
      await deps.db.run(FILE_SQL.thumb, [thumbPath, fileId]);
    },

    async readThumbnail(fileId, userId) {
      outside();
      const row = await deps.db.one<FileRow>(FILE_SQL.own, [fileId, userId]);
      return row?.thumb_path ? readIfPresent(absolute(row.thumb_path)) : null;
    },

    async setPageCount(fileId, pageCount) {
      await deps.db.run(FILE_SQL.pages, [pageCount, fileId]);
    },

    uploadSingle: createUploadSingle(maxBytes, maxMb, tooLargeWords),
  };
  return store;
}
