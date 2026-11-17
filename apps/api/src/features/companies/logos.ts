import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { AppDeps } from '../../core/context';
import { constantsOf } from '../../core/constants/service';
import { fileTooLarge } from '../../core/files/upload';
import { notFound, validationFailed } from '../../core/http/errors';

// v30 E0-API: the logo store (docs/design/part2/13-company-enrichment.md §1 problem 3, §10 "Logo files"). A logo is
// copied once and served from TailorIT at a same-origin path with long cache headers, never hot-linked (which sends
// every viewer's address to the logo's host and breaks when it moves): content-addressed files <sha256>.<ext> under
// DATA_DIR/company-logos, served at /api/company-logos/<file>. Only raster images whose bytes say what they are (PNG,
// JPEG, WebP, GIF) are kept, at most COMPANY_LOGO_MAX_BYTES; an SVG is never kept as it came (it can carry scripts).
// Wave 4's logo pipeline (E2) decodes, re-encodes and resizes through the headless browser before it stores here; in
// wave 3 an admin's upload is the one writer (admin.ts).

/** Where a stored logo is served (the profile's logo_path starts with it). */
export const LOGO_ROUTE = '/api/company-logos';
const LOGO_DIR = 'company-logos';
const FILE_NAME = /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/;

const KINDS = {
  png: { mime: 'image/png', test: (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', test: (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: 'image/webp', test: (b: Buffer) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  gif: { mime: 'image/gif', test: (b: Buffer) => b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)) },
} as const;
export type LogoKind = keyof typeof KINDS;

/** What a logo's bytes are (by their first bytes, never the name or the declared type); null for anything else. */
export function logoKindOf(bytes: Buffer): LogoKind | null {
  for (const [kind, spec] of Object.entries(KINDS) as Array<[LogoKind, (typeof KINDS)[LogoKind]]>) {
    if (spec.test(bytes)) return kind;
  }
  return null;
}

/** The refusal of a file that is no logo TailorIT keeps. */
const NOT_A_LOGO = 'Upload a PNG, JPEG, WebP or GIF image.';

export interface StoredLogo {
  /** The same-origin path the profile keeps ("/api/company-logos/<sha256>.png"). */
  path: string;
  sha256: Buffer;
}

/**
 * Stores a logo's bytes once (the same bytes are one file) and answers its path. File I/O: never inside a transaction.
 * 413 over COMPANY_LOGO_MAX_BYTES, 400 for bytes that are no PNG, JPEG, WebP or GIF.
 */
export function storeLogo(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, bytes: Buffer, name?: string): StoredLogo {
  deps.db.assertNoTx('the logo store');
  const max = constantsOf(deps).get('COMPANY_LOGO_MAX_BYTES');
  if (bytes.length > max) {
    throw fileTooLarge(name, Math.round((max / 1_000_000) * 10) / 10, (params) => constantsOf(deps).message('MSG_FILE_TOO_LARGE', params));
  }
  const kind = logoKindOf(bytes);
  if (!kind) throw validationFailed(NOT_A_LOGO, { logo: NOT_A_LOGO });
  const sha256 = createHash('sha256').update(bytes).digest();
  const file = `${sha256.toString('hex')}.${kind}`;
  const dir = join(deps.config.dataDir, LOGO_DIR);
  const path = join(dir, file);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  }
  return { path: `${LOGO_ROUTE}/${file}`, sha256 };
}

/** GET /api/company-logos/:file: a stored logo, cached for a year (its name is its content), never sniffed as another type. */
export function createLogosRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/:file', (req, res, next) => {
    const file = String(req.params.file ?? '');
    const match = FILE_NAME.exec(file);
    if (!match) return next(notFound('That logo'));
    const path = join(deps.config.dataDir, LOGO_DIR, file);
    if (!existsSync(path)) return next(notFound('That logo'));
    res.setHeader('Content-Type', KINDS[match[1] as LogoKind].mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.sendFile(path, (error) => {
      if (error && !res.headersSent) next(notFound('That logo'));
    });
  });
  return router;
}
