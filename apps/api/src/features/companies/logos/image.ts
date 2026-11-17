// v30 E2: what an image file is, by its bytes (never its name or its declared type), and how large it is, read from its
// header alone (docs/design/part2/13-company-enrichment.md §6.1 "an icon of at least 64 px", §4 rule 7). The logo
// pipeline (pipeline.ts) decodes and re-encodes every image in the headless browser; this only decides which bytes go
// there, and which candidate is large enough to be a logo.

/** The image kinds the browser decodes and the pipeline takes. */
export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'ico' | 'bmp' | 'avif' | 'svg';

/** Each kind's media type, for the data: address the browser reads it from. */
export const IMAGE_MIME: Record<ImageKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

export interface ImageInfo {
  kind: ImageKind;
  /** Pixels, when the header says (an SVG scales; an AVIF's size is not read here). */
  width: number | null;
  height: number | null;
  /** Drawn from shapes: any size is sharp. */
  vector: boolean;
}

const u16le = (b: Buffer, at: number) => (at + 2 <= b.length ? b.readUInt16LE(at) : 0);
const u16be = (b: Buffer, at: number) => (at + 2 <= b.length ? b.readUInt16BE(at) : 0);
const u24le = (b: Buffer, at: number) => (at + 3 <= b.length ? b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) : 0);
const u32be = (b: Buffer, at: number) => (at + 4 <= b.length ? b.readUInt32BE(at) : 0);
const i32le = (b: Buffer, at: number) => (at + 4 <= b.length ? b.readInt32LE(at) : 0);
const ascii = (b: Buffer, at: number, length: number) => b.toString('latin1', at, at + length);

/** A JPEG's size: the first start-of-frame marker's. */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1]!;
    // Fill bytes and markers without a length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) return { height: u16be(b, at + 5), width: u16be(b, at + 7) };
    at += 2 + length;
  }
  return null;
}

/** A WebP's size from its first chunk (VP8, VP8L or VP8X). */
function webpSize(b: Buffer): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

/** An icon file's largest picture (a width or height byte of 0 means 256). */
function icoSize(b: Buffer): { width: number; height: number } | null {
  const count = u16le(b, 4);
  let best: { width: number; height: number } | null = null;
  for (let n = 0; n < count && 6 + n * 16 + 16 <= b.length; n += 1) {
    const width = b[6 + n * 16] || 256;
    const height = b[7 + n * 16] || 256;
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

/** Whether text bytes are an SVG document (an XML prolog, comments or a doctype may come first). */
function isSvg(b: Buffer): boolean {
  const head = b.subarray(0, 4096);
  if (head.includes(0)) return false;
  const text = head.toString('utf8').replace(/^\ufeff/, '');
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(text);
}

/** What an image's bytes are and how large it is, or null for anything that is not an image the pipeline takes. */
export function imageInfoOf(bytes: Buffer): ImageInfo | null {
  const b = bytes;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && ascii(b, 12, 4) === 'IHDR') {
    return { kind: 'png', width: u32be(b, 16), height: u32be(b, 20), vector: false };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return { kind: 'jpeg', width: size?.width ?? null, height: size?.height ?? null, vector: false };
  }
  if (b.length >= 10 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return { kind: 'gif', width: u16le(b, 6), height: u16le(b, 8), vector: false };
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const size = webpSize(b);
    return { kind: 'webp', width: size?.width ?? null, height: size?.height ?? null, vector: false };
  }
  if (b.length >= 22 && u16le(b, 0) === 0 && u16le(b, 2) === 1 && u16le(b, 4) > 0) {
    const size = icoSize(b);
    return { kind: 'ico', width: size?.width ?? null, height: size?.height ?? null, vector: false };
  }
  if (b.length >= 26 && ascii(b, 0, 2) === 'BM') return { kind: 'bmp', width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)), vector: false };
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp' && /^avi[fs]$/.test(ascii(b, 8, 4))) return { kind: 'avif', width: null, height: null, vector: false };
  if (isSvg(b)) return { kind: 'svg', width: null, height: null, vector: true };
  return null;
}
