import { createHash } from 'node:crypto';
import { constantDefault } from '@tailorit/shared/constants';
import { constantsOf } from '../../../core/constants/index';
import type { AppDeps } from '../../../core/context';
import { getPdfService } from '../../../core/pdf/index';
import { storeLogo } from '../logos';
import { imageInfoOf, type ImageInfo } from './image';
import { browserRasterizer, type LogoRasterizer, type LogoSizes } from './rasterize';

// v30 E2: the logo pipeline (docs/design/part2/13-company-enrichment.md §1 problem 3, §4 rule 7, §6.1 "logo_path",
// §10 "Logo files"). A logo read from a company's site or from logo.dev is copied once and served from TailorIT, never
// hot-linked: its bytes must be an image (by their bytes: PNG, JPEG, GIF, WebP, ICO, BMP, AVIF or SVG), large enough
// to be a logo (an icon at least COMPANY_LOGO_MIN_PX on its shorter side; any SVG), decoded and drawn again by the
// headless browser (rasterize.ts) at the two stored sizes (COMPANY_LOGO_SMALL_PX, COMPANY_LOGO_LARGE_PX: 64 and 128 px),
// and stored through E0-API's storeLogo (content-addressed PNGs under DATA_DIR, served at
// /api/company-logos/<sha256>.png). The profile's logo is the large copy when the source is at least that large (or a
// vector), else the small one. (v30 INT-4: the three sizes are central constants, .env only.)

/** The two stored sizes, from the constants (the smaller one first whatever the .env says). */
export function logoSizesOf(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): LogoSizes {
  const c = constantsOf(deps);
  const a = c.get('COMPANY_LOGO_SMALL_PX');
  const b = c.get('COMPANY_LOGO_LARGE_PX');
  return { small: Math.min(a, b), large: Math.max(a, b) };
}
/** A banner is no logo: the longer side at most this many times the shorter, for a picture that is not a logo by name. */
const SQUARE_RATIO = 1.25;

export interface CopiedLogo {
  /** The profile's logo: a same-origin path. */
  path: string;
  /** Both stored sizes, keyed by the size in px. */
  files: Record<number, string>;
  /** The source bytes' SHA-256 (hex): an unchanged logo is not copied again. */
  sourceSha256: string;
  info: ImageInfo;
}

export type LogoRefusal = 'not_an_image' | 'too_small' | 'not_square' | 'not_drawn';

export interface CopyLogoOptions {
  /** Draws the image (default: the shared headless browser). */
  rasterizer?: LogoRasterizer;
  /** A picture that is no logo by name (a page's og:image) must be about square. */
  squareOnly?: boolean;
  /** A logo by name (schema.org Organization.logo, logo.dev) may be a wide wordmark: only its longer side must be large. */
  wordmark?: boolean;
  /** The least size (COMPANY_LOGO_MIN_PX; copyLogo reads it, a caller without deps gets its default). */
  minPx?: number;
}

/** Why a picture is no logo, or null when it may be one (by its header alone: nothing drawn yet). */
export function logoRefusalOf(info: ImageInfo | null, options: Pick<CopyLogoOptions, 'squareOnly' | 'wordmark' | 'minPx'> = {}): LogoRefusal | null {
  if (!info) return 'not_an_image';
  if (info.vector || info.width === null || info.height === null) return null;
  const short = Math.min(info.width, info.height);
  const long = Math.max(info.width, info.height);
  if ((options.wordmark ? long : short) < (options.minPx ?? constantDefault('COMPANY_LOGO_MIN_PX'))) return 'too_small';
  if (options.squareOnly && long > short * SQUARE_RATIO) return 'not_square';
  return null;
}

/**
 * Copies a logo's bytes into TailorIT's logo store (see the module's note): the stored paths, or the refusal. File I/O
 * and the browser: never inside a transaction. Throws when the browser cannot start (AppError browser_unavailable).
 */
export async function copyLogo(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  bytes: Buffer,
  options: CopyLogoOptions = {},
): Promise<CopiedLogo | { refused: LogoRefusal }> {
  deps.db.assertNoTx('the logo pipeline');
  const info = imageInfoOf(bytes);
  const refused = logoRefusalOf(info, { ...options, minPx: options.minPx ?? constantsOf(deps).get('COMPANY_LOGO_MIN_PX') });
  if (refused || !info) return { refused: refused ?? 'not_an_image' };
  const sizes = logoSizesOf(deps);
  const rasterize = options.rasterizer ?? browserRasterizer(getPdfService(deps));
  const drawn = await rasterize({ bytes, kind: info.kind, sizes });
  const small = drawn?.[sizes.small];
  const largeFile = drawn?.[sizes.large];
  if (!small || !largeFile) return { refused: 'not_drawn' };
  const files = { [sizes.small]: storeLogo(deps, small).path, [sizes.large]: storeLogo(deps, largeFile).path };
  const large = info.vector || info.width === null || info.height === null || Math.max(info.width, info.height) >= sizes.large;
  return { path: large ? files[sizes.large]! : files[sizes.small]!, files, sourceSha256: createHash('sha256').update(bytes).digest('hex'), info };
}
