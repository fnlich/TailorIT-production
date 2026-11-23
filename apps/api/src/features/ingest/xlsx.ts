import JSZip from 'jszip';
import { JOB_IMPORT_MAX_COLUMNS, JOB_ROW_CELL_READ_CHARS, XLSX_MAX_ENTRIES, XLSX_MAX_UNCOMPRESSED_MB } from '@tailorit/shared';
import { IngestError } from './types';

// v35 IMPORT (SP v35 PLAN.md H1 "A file ... .xlsx (first sheet, or the chosen one; read with jszip ... plus a small cell
// reader; no new dependency)"): an Excel workbook's one sheet as rows of text cells. Only what a table needs is read:
// the workbook's sheet list, its relationships, the shared strings and the chosen sheet; every other part stays
// compressed. Cells: shared strings, inline strings, a formula's text result, numbers and dates as the text the file
// stores ("45000", "1.5E-2": numbers as text), booleans as TRUE or FALSE; errors are blank. An empty row is dropped (its
// number is kept: rows are numbered as the sheet numbers them).
//
// Limits (a zip bomb, a huge sheet): at most XLSX_MAX_ENTRIES parts; the parts read may hold at most
// XLSX_MAX_UNCOMPRESSED_MB once unzipped, checked against each part's declared size before it is opened and counted as
// it is inflated (a part that lies about its size is stopped there); at most XLSX_MAX_COLUMNS columns are kept.
//
// v35 FIX-PARSE (sec S1): every part is read forward once (indexOf, no lazy pattern over a whole part; a tag with no
// close tag ends the reading of its part), so a 2 KB file of 80,000 unclosed <row> takes one search, not seconds. A
// shared string is cut to JOB_ROW_CELL_READ_CHARS when read, and the text the rows read take (a shared string once per
// cell that uses it) counts toward XLSX_MAX_UNCOMPRESSED_MB as the parts do: one string used by every row is no way past
// the limit. A reader given a row limit reads that many rows and counts the rest.

/** Columns kept of a row (a cell further right is ignored): an import's column limit. */
export const XLSX_MAX_COLUMNS = JOB_IMPORT_MAX_COLUMNS;

/** An .xlsx file was refused: not a workbook, or too large once opened (`tooBig`). */
export class XlsxError extends IngestError {
  constructor(
    message: string,
    readonly tooBig = false,
    /** The sheet asked for is not in the workbook (its words name it). */
    readonly noSheet = false,
  ) {
    super(message);
    this.name = 'XlsxError';
  }
}

export interface XlsxSheet {
  /** Every sheet's name, in the workbook's order. */
  sheets: string[];
  /** The sheet read. */
  sheet: string;
  /** Its rows that hold a cell of text, numbered as the sheet numbers them (1-based). */
  rows: Array<{ row: number; cells: string[] }>;
  /** v35 FIX-PARSE: the rows after a row limit that hold a value (counted, not read); 0 with no limit. */
  moreRows: number;
}

/** Whether bytes are a zip archive (an .xlsx is one). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text as read: entities, and OOXML's _xHHHH_ escapes (a carriage return is _x000D_). */
function xmlText(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
      const lower = name.toLowerCase();
      if (lower.startsWith('#x')) return charOf(Number.parseInt(lower.slice(2), 16)) ?? whole;
      if (lower.startsWith('#')) return charOf(Number.parseInt(lower.slice(1), 10)) ?? whole;
      return XML_ENTITIES[lower] ?? whole;
    })
    .replace(/_x([0-9a-f]{4})_/gi, (whole, hex: string) => charOf(Number.parseInt(hex, 16)) ?? whole);
}

function charOf(code: number): string | null {
  if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
  return String.fromCodePoint(code);
}

/** An attribute's value in a tag's text, or null. */
function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? xmlText(match[1] ?? match[2] ?? '') : null;
}

const REF_ATTR = /\sr\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const TYPE_ATTR = /\st\s*=\s*(?:"([^"]*)"|'([^']*)')/;
/** A cell's or a row's `r` or `t` (the patterns above), or null. */
function attrOf(attrs: string, pattern: RegExp): string | null {
  const match = pattern.exec(attrs);
  return match ? xmlText(match[1] ?? match[2] ?? '') : null;
}

/** An element found by nextElement: its open tag's attributes, its inner text (null for `<name/>`), and where it ends. */
interface XmlElement {
  attrs: string;
  inner: string | null;
  end: number;
}

/** Whether a character ends a tag's name (`>`, `/`, whitespace). */
const endsName = (code: number) => code === 62 || code === 47 || code === 32 || code === 9 || code === 10 || code === 13;

/**
 * v35 FIX-PARSE (sec S1): the next `<name>` element of `xml` from `from`, found by forward searches (indexOf, never a
 * lazy pattern over the whole part). Null when there is none, or when its open tag or its close tag `</name>` is
 * missing: the reading stops there, so an unclosed tag costs one search to the end, not one per tag.
 */
function nextElement(xml: string, name: string, from: number): XmlElement | null {
  const open = `<${name}`;
  for (let at = xml.indexOf(open, from); at !== -1; at = xml.indexOf(open, at + 1)) {
    if (!endsName(xml.charCodeAt(at + open.length))) continue;
    const gt = xml.indexOf('>', at + open.length);
    if (gt === -1) return null;
    const selfClosing = xml.charCodeAt(gt - 1) === 47;
    const attrs = xml.slice(at + open.length, selfClosing ? gt - 1 : gt);
    if (selfClosing) return { attrs, inner: null, end: gt + 1 };
    const close = xml.indexOf(`</${name}>`, gt + 1);
    if (close === -1) return null;
    return { attrs, inner: xml.slice(gt + 1, close), end: close + name.length + 3 };
  }
  return null;
}

/** Whether the tag at `at` (a "<") is `<name` itself (not a longer name). */
const isTagAt = (xml: string, at: number, name: string) => xml.startsWith(name, at + 1) && endsName(xml.charCodeAt(at + 1 + name.length));

/**
 * The text of a string item (<si> or <is>): its <t> runs, phonetic runs (<rPh>) left out. v35 FIX-PARSE (sec S1): read
 * forward once (a run or a phonetic run with no close tag ends it), at most JOB_ROW_CELL_READ_CHARS.
 */
function itemText(xml: string): string {
  let out = '';
  for (let at = xml.indexOf('<'); at !== -1 && out.length < JOB_ROW_CELL_READ_CHARS; ) {
    if (isTagAt(xml, at, 'rPh')) {
      const close = xml.indexOf('</rPh>', at);
      if (close === -1) break;
      at = xml.indexOf('<', close + 6);
    } else if (isTagAt(xml, at, 't')) {
      const run = nextElement(xml, 't', at);
      if (!run) break;
      if (run.inner !== null) out += xmlText(run.inner);
      at = xml.indexOf('<', run.end);
    } else {
      at = xml.indexOf('<', at + 1);
    }
  }
  return out.length > JOB_ROW_CELL_READ_CHARS ? out.slice(0, JOB_ROW_CELL_READ_CHARS) : out;
}

/** A column's letters (A, Z, AA) as a 0-based index; null for none. */
function columnIndex(ref: string): number | null {
  const letters = /^([A-Z]{1,3})\d*$/i.exec(ref)?.[1]?.toUpperCase();
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** JSZip's StreamHelper, as far as the reader uses it. */
interface PartStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): PartStream;
  on(event: 'error', listener: (error: Error) => void): PartStream;
  on(event: 'end', listener: () => void): PartStream;
  pause(): PartStream;
  resume(): PartStream;
}

/** Reads the parts the table needs, within the limits (see the top). */
class PartReader {
  private used = 0;
  private readonly max = XLSX_MAX_UNCOMPRESSED_MB * 1024 * 1024;

  constructor(private readonly zip: JSZip) {}

  has(path: string): boolean {
    return this.zip.file(path) !== null;
  }

  async read(path: string): Promise<string | null> {
    const file = this.zip.file(path);
    if (!file) return null;
    // The declared size first (cheap); then the bytes as they inflate (a part may lie about its size).
    const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof declared === 'number' && this.used + declared > this.max) throw tooBig();
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      // JSZip's internal stream (its typings leave it out): the part's bytes as they inflate.
      const stream = (file as unknown as { internalStream(type: 'uint8array'): PartStream }).internalStream('uint8array');
      let stopped = false;
      stream
        .on('data', (chunk: Uint8Array) => {
          if (stopped) return;
          this.used += chunk.length;
          if (this.used > this.max) {
            stopped = true;
            stream.pause();
            reject(tooBig());
            return;
          }
          chunks.push(chunk);
        })
        .on('error', (error: Error) => {
          if (!stopped) reject(error);
        })
        .on('end', () => {
          if (!stopped) resolve();
        })
        .resume();
    });
    return Buffer.concat(chunks).toString('utf8');
  }
}

const tooBig = () => new XlsxError(`This spreadsheet is larger than ${XLSX_MAX_UNCOMPRESSED_MB} MB once opened.`, true);
const notWorkbook = () => new XlsxError('This file is not an Excel workbook (.xlsx) TailorIT can read.');

/** The path a workbook relationship's target names (relative to xl/, or absolute from the archive's root). */
function partPath(target: string): string {
  const clean = target.replace(/\\/g, '/');
  if (clean.startsWith('/')) return clean.slice(1);
  const parts: string[] = ['xl'];
  for (const piece of clean.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}

/** A cell's text: a shared string, an inline string, a boolean, an error (blank), or the value as stored. */
function cellText(attrs: string, inner: string, shared: readonly string[]): string {
  const type = attrOf(attrs, TYPE_ATTR) ?? 'n';
  if (type === 'inlineStr') {
    const item = nextElement(inner, 'is', 0);
    return item?.inner ? itemText(item.inner) : '';
  }
  const value = nextElement(inner, 'v', 0)?.inner ?? undefined;
  if (type === 's') return value !== undefined ? (shared[Number(value)] ?? '') : '';
  if (type === 'b') return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : '';
  if (type === 'e') return '';
  return value !== undefined ? xmlText(value) : '';
}

/**
 * One sheet of an .xlsx file (see the top): `sheetName`, else the first. Throws XlsxError. v35 FIX-PARSE (sec S1): at
 * most `options.maxRows` rows that hold a cell of text are read; the rows after them that hold a value are counted
 * (`moreRows`), not read.
 */
export async function readXlsxSheet(bytes: Uint8Array, sheetName?: string, options: { maxRows?: number } = {}): Promise<XlsxSheet> {
  if (!isZip(bytes)) throw notWorkbook();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  } catch {
    throw notWorkbook();
  }
  if (Object.keys(zip.files).length > XLSX_MAX_ENTRIES) throw new XlsxError(`This file holds more than ${XLSX_MAX_ENTRIES} parts.`, true);
  const parts = new PartReader(zip);
  const workbook = await parts.read('xl/workbook.xml');
  if (!workbook) throw notWorkbook();
  const rels = (await parts.read('xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b[^<>]*>/g)) {
    const id = attr(match[0], 'Id');
    const target = attr(match[0], 'Target');
    if (id && target) targets.set(id, partPath(target));
  }
  const sheets: Array<{ name: string; path: string }> = [];
  for (const match of workbook.matchAll(/<sheet\b[^<>]*>/g)) {
    const name = attr(match[0], 'name');
    const rid = attr(match[0], 'r:id') ?? attr(match[0], 'id');
    const path = rid ? targets.get(rid) : undefined;
    if (name !== null && path && parts.has(path)) sheets.push({ name, path });
  }
  if (sheets.length === 0) throw notWorkbook();
  const chosen = (sheetName !== undefined ? sheets.find((sheet) => sheet.name === sheetName) : undefined) ?? sheets[0]!;
  if (sheetName !== undefined && chosen.name !== sheetName) throw new XlsxError(`This workbook has no sheet named "${sheetName}".`, false, true);

  const shared: string[] = [];
  const stringsPath = [...targets.values()].find((path) => /sharedStrings\.xml$/i.test(path)) ?? 'xl/sharedStrings.xml';
  const strings = await parts.read(stringsPath);
  if (strings) {
    for (let item = nextElement(strings, 'si', 0); item; item = nextElement(strings, 'si', item.end)) {
      shared.push(item.inner === null ? '' : itemText(item.inner));
    }
  }

  const xml = (await parts.read(chosen.path)) ?? '';
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  // A shared string used by many cells counts once per cell: the text the rows read take is capped as the parts are.
  const maxText = XLSX_MAX_UNCOMPRESSED_MB * 1024 * 1024;
  let cellsText = 0;
  const rows: XlsxSheet['rows'] = [];
  let nextRow = 1;
  let row = nextElement(xml, 'row', 0);
  for (; row && rows.length < maxRows; row = nextElement(xml, 'row', row.end)) {
    const number = Number(attrOf(row.attrs, REF_ATTR)) || nextRow;
    nextRow = number + 1;
    if (row.inner === null) continue;
    const cells: string[] = [];
    let nextColumn = 0;
    for (let cell = nextElement(row.inner, 'c', 0); cell; cell = nextElement(row.inner, 'c', cell.end)) {
      const ref = attrOf(cell.attrs, REF_ATTR);
      const column = (ref ? columnIndex(ref) : null) ?? nextColumn;
      nextColumn = column + 1;
      // Cells come in their columns' order: the rest of the row is past the columns kept.
      if (column >= XLSX_MAX_COLUMNS) break;
      const text = cell.inner === null ? '' : cellText(cell.attrs, cell.inner, shared);
      cellsText += text.length;
      if (cellsText > maxText) throw tooBig();
      while (cells.length < column) cells.push('');
      cells[column] = text;
    }
    if (cells.some((cell) => cell.trim() !== '')) rows.push({ row: number, cells });
  }
  let moreRows = 0;
  for (; row; row = nextElement(xml, 'row', row.end)) if (row.inner !== null && /<(?:v|is)[\s>]/.test(row.inner)) moreRows += 1;
  return { sheets: sheets.map((sheet) => sheet.name), sheet: chosen.name, rows, moreRows };
}
