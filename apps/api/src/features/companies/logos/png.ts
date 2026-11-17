import { crc32, deflateSync, inflateSync } from 'node:zlib';

// v30 E2: the little PNG the logo pipeline needs (no image package in the app): reading the headless browser's own
// screenshots (8-bit grey, grey+alpha, RGB or RGBA, not interlaced: what Chrome writes) and writing RGBA. The pictures
// the pipeline stores are always written here, from pixels the browser decoded, so no byte of a site's file is ever
// served as it came.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels per colour type (0 grey, 2 RGB, 4 grey+alpha, 6 RGBA). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** RGBA pixels, row by row. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB, RGBA) to RGBA; throws for anything else. */
export function decodePng(png: Buffer): RgbaImage {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG.');
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let colourType = -1;
  const idat: Buffer[] = [];
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8]!;
      colourType = data[9]!;
      const interlace = data[12]!;
      channels = CHANNELS[colourType] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) throw new Error('An unsupported PNG layout.');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (!width || !height || channels === 0) throw new Error('A PNG without a header.');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('A PNG too short for its size.');
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[out + x - channels]! : 0;
      const up = y > 0 ? pixels[out - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[out - stride + x - channels]! : 0;
      const value = row[x]!;
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : -1;
      if (predicted < 0) throw new Error('A PNG row with an unknown filter.');
      pixels[out + x] = (value + predicted) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let n = 0; n < width * height; n += 1) {
    const from = n * channels;
    if (colourType === 6) data.set(pixels.subarray(from, from + 4), n * 4);
    else if (colourType === 2) data.set([pixels[from]!, pixels[from + 1]!, pixels[from + 2]!, 255], n * 4);
    else if (colourType === 4) data.set([pixels[from]!, pixels[from]!, pixels[from]!, pixels[from + 1]!], n * 4);
    else data.set([pixels[from]!, pixels[from]!, pixels[from]!, 255], n * 4);
  }
  return { width, height, data };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes RGBA pixels as an 8-bit RGBA PNG (each row filtered by its left neighbour). */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const out = y * (stride + 1);
    raw[out] = 1;
    for (let x = 0; x < stride; x += 1) {
      const value = data[y * stride + x]!;
      const left = x >= 4 ? data[y * stride + x - 4]! : 0;
      raw[out + 1 + x] = (value - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
