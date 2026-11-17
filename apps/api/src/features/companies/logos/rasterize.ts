import { constantDefault } from '@tailorit/shared/constants';
import type { PdfService } from '../../../core/pdf/index';
import { IMAGE_MIME, type ImageKind } from './image';
import { decodePng, encodePng, type RgbaImage } from './png';

// v30 E2: logos decoded and re-encoded in the headless browser (docs/design/part2/13-company-enrichment.md §4 rule 7,
// §10 "Logo files"; E0-API left the re-encoding and resizing here). A site's file is never served as it came: the
// shared browser (core/pdf, scripts off, nothing but data: addresses loaded) draws it, an SVG included (an SVG drawn as
// an image runs no script and loads nothing), and TailorIT writes its own PNG of what was drawn, at the two stored
// sizes (COMPANY_LOGO_SMALL_PX and COMPANY_LOGO_LARGE_PX: 64 and 128 px), contained in the square and centred.
//
// The shared browser's screenshot is opaque, so each size is drawn twice, once on black and once on white, in one
// screenshot (large + small wide, twice large high: 192 x 256 px by default; the large and small squares side by side,
// the black row above the white one), and the transparency is read back from the two: a pixel drawn with colour c and opacity a shows c·a on black and
// c·a + 255·(1 - a) on white, so a = 1 - (white - black) / 255 and c = black / a. A logo the browser cannot decode
// draws nothing, and is refused.

/**
 * The two sizes a logo is stored at (13 §10; v30 INT-4: COMPANY_LOGO_SMALL_PX and COMPANY_LOGO_LARGE_PX, 64 and 128 px by
 * default): the profile's logo is the large one when the source is that large.
 */
export interface LogoSizes {
  small: number;
  large: number;
}

/** The constants' defaults (a caller with deps reads the constants: pipeline.ts logoSizesOf). */
export const DEFAULT_LOGO_SIZES: LogoSizes = { small: constantDefault('COMPANY_LOGO_SMALL_PX'), large: constantDefault('COMPANY_LOGO_LARGE_PX') };

/** Draws an image's bytes as PNGs of each size, keyed by the size in px; null when nothing could be drawn. */
export type LogoRasterizer = (input: { bytes: Buffer; kind: ImageKind; sizes?: LogoSizes }) => Promise<Record<number, Buffer> | null>;

/** The screenshot that holds both sizes on both backgrounds. */
const shotOf = (sizes: LogoSizes) => ({ width: sizes.large + sizes.small, height: 2 * sizes.large });

/** The page that draws the logo twice at each size (see the top). */
export function logoPage(bytes: Buffer, kind: ImageKind, sizes: LogoSizes = DEFAULT_LOGO_SIZES): string {
  const source = `data:${IMAGE_MIME[kind]};base64,${bytes.toString('base64')}`;
  const { large, small } = sizes;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff;overflow:hidden}
.row{display:flex;width:${large + small}px;height:${large}px;align-items:flex-start}
.k{background-color:#000}.w{background-color:#fff}
.l{background-image:url("${source}");background-repeat:no-repeat;background-position:center;background-size:contain;flex:none}
.sl{width:${large}px;height:${large}px}.ss{width:${small}px;height:${small}px}
</style></head><body><div class="row k"><div class="l sl"></div><div class="l ss"></div></div><div class="row w"><div class="l sl"></div><div class="l ss"></div></div></body></html>`;
}

/**
 * One size's square, its transparency read back from the black row (top) and the white row (bottom, from half the
 * screenshot's height) of the screenshot; null when the square is empty (nothing was drawn).
 */
export function squareOf(shot: RgbaImage, left: number, size: number): RgbaImage | null {
  const data = new Uint8Array(size * size * 4);
  let drawn = false;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const black = ((y * shot.width) + left + x) * 4;
      const white = (((y + shot.height / 2) * shot.width) + left + x) * 4;
      let spread = 0;
      for (let c = 0; c < 3; c += 1) spread += shot.data[white + c]! - shot.data[black + c]!;
      const alpha = Math.max(0, Math.min(255, Math.round(255 - spread / 3)));
      const out = (y * size + x) * 4;
      if (alpha === 0) continue;
      drawn = true;
      for (let c = 0; c < 3; c += 1) data[out + c] = Math.max(0, Math.min(255, Math.round((shot.data[black + c]! * 255) / alpha)));
      data[out + 3] = alpha;
    }
  }
  return drawn ? { width: size, height: size, data } : null;
}

/** The production rasterizer: the shared headless browser (core/pdf's screenshot), one screenshot a logo. */
export function browserRasterizer(pdf: Pick<PdfService, 'screenshotPng'>): LogoRasterizer {
  return async ({ bytes, kind, sizes = DEFAULT_LOGO_SIZES }) => {
    const size = shotOf(sizes);
    const shot = decodePng(await pdf.screenshotPng(logoPage(bytes, kind, sizes), size));
    if (shot.width < size.width || shot.height < size.height) return null;
    const read = { ...shot, height: size.height };
    const large = squareOf(read, 0, sizes.large);
    const small = squareOf(read, sizes.large, sizes.small);
    if (!large || !small) return null;
    return { [sizes.small]: encodePng(small), [sizes.large]: encodePng(large) };
  };
}
