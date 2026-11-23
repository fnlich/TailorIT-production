import { firstRowIsHeader, JOB_IMPORT_COLUMN_NAME_MAX_CHARS, JOB_IMPORT_MAX_COLUMNS, SHEET_MAX_ROWS, tidyText } from '@tailorit/shared';
import { cellText, countOf, jsonObjectsOf, parseCsvRecords, uniqueColumnNames, type CsvWidth } from './tabular';
import { IngestError } from './types';
import { readXlsxSheet } from './xlsx';

// v35 IMPORT (SP v35 PLAN.md H1): every way an import arrives (pasted lines, a .csv/.tsv/.txt/.json/.xlsx file, a Google
// Sheet's tab) as one table of rows: its columns, whether its first row names them (H1's rule: a first row whose first
// cell is a link is a row, not a header, unless asked otherwise), and each row's cells with the row number the file or
// the sheet shows. jobs/add/import-rows.ts reads its rows by the shared row contract.
//
// v35 FIX-PARSE (sec S1): reading is linear in the input and capped. A table has at most JOB_IMPORT_MAX_COLUMNS columns:
// an .xlsx file and a Google Sheet keep their first ones; a CSV, a TSV, pasted rows or a JSON file with more is refused
// with words (blank columns past the limit do not count). A reader given `maxRows` (the route's limit) keeps one row
// past it (so the route still refuses "too many") and counts the rest (`totalRows`); a file is read with SHEET_MAX_ROWS,
// the most any file route takes, when its route names none.

export type RowTableFormat = 'paste' | 'csv' | 'tsv' | 'json' | 'xlsx' | 'sheet';

export interface RowTable {
  format: RowTableFormat;
  /** The column names: the header's, or "Column 1", "Column 2"... for a table with no header row. */
  columns: string[];
  hasHeader: boolean;
  /** The rows below the header (blank rows dropped), each cell by column; at most `maxRows + 1` when read with a limit. */
  rows: Array<{ row: number; cells: string[] }>;
  /** v35 FIX-PARSE: the rows below the header in all, when there are more than `rows` keeps (counted, not kept). */
  totalRows?: number;
  /** An .xlsx file's sheets, and the one read. */
  sheets?: string[];
  sheet?: string;
}

/** How a table is read: the route's row limit (rows past one more are counted, not kept). */
export interface RowTableLimits {
  maxRows?: number;
}

/** The words of a table refused for its columns: a file's, or pasted rows'. */
export function tooManyColumnsText(format: RowTableFormat): string {
  return format === 'paste'
    ? `These rows have more than ${JOB_IMPORT_MAX_COLUMNS} columns. Keep the job columns and paste them again.`
    : `This file has more than ${JOB_IMPORT_MAX_COLUMNS} columns. Keep the job columns and import it again.`;
}

const widthOf = (format: RowTableFormat): CsvWidth => ({ maxColumns: JOB_IMPORT_MAX_COLUMNS, tooWide: tooManyColumnsText(format) });
const filled = (cell: string) => cell.trim() !== '';
/** How many cells a record has up to its last filled one. */
function filledWidth(cells: readonly string[]): number {
  let width = cells.length;
  while (width > 0 && !filled(cells[width - 1]!)) width -= 1;
  return width;
}

/** A table from records (the first one a header or a row, as `hasHeader` says or H1's rule guesses). */
export function rowTableOf(
  format: RowTableFormat,
  records: ReadonlyArray<{ row: number; cells: string[] }>,
  hasHeader?: boolean,
  limits: RowTableLimits = {},
): RowTable {
  const rows = records.filter((record) => record.cells.some(filled));
  if (rows.length === 0) throw new IngestError('There are no rows to import.');
  const header = hasHeader ?? firstRowIsHeader(rows[0]!.cells);
  const body = header ? rows.slice(1) : rows;
  const kept = limits.maxRows !== undefined && body.length > limits.maxRows + 1 ? body.slice(0, limits.maxRows + 1) : body;
  const headerCells = header ? rows[0]!.cells : [];
  let width = headerCells.length;
  for (const record of kept) width = Math.max(width, record.cells.length);
  if (width > JOB_IMPORT_MAX_COLUMNS) {
    // Blank columns at the end do not count; a spreadsheet keeps its first columns, any other table is refused.
    width = filledWidth(headerCells);
    for (const record of kept) width = Math.max(width, filledWidth(record.cells));
    if (width > JOB_IMPORT_MAX_COLUMNS) {
      if (format !== 'sheet' && format !== 'xlsx') throw new IngestError(tooManyColumnsText(format));
      width = JOB_IMPORT_MAX_COLUMNS;
    }
  }
  width = Math.max(width, 1);
  const names = Array.from({ length: width }, (_, index) =>
    header ? tidyText(headerCells[index] ?? '').slice(0, JOB_IMPORT_COLUMN_NAME_MAX_CHARS).trim() || `Column ${index + 1}` : `Column ${index + 1}`,
  );
  return {
    format,
    columns: uniqueColumnNames(names),
    hasHeader: header,
    rows: kept.map((record) => ({ row: record.row, cells: record.cells.length > width ? record.cells.slice(0, width) : record.cells })),
    ...(kept.length < body.length ? { totalRows: body.length } : {}),
  };
}

/** The delimiter of a text table: a tab when its first line holds one, else , or ; (whichever splits it more). */
function delimiterOf(text: string): string {
  const end = text.search(/\r?\n/);
  const first = end === -1 ? text : text.slice(0, end);
  if (first.includes('\t')) return '\t';
  return countOf(first, ';') > countOf(first, ',') ? ';' : ',';
}

/**
 * Pasted links (H1 "Many links"): one link per line, or rows copied from a spreadsheet (tab-separated, a header row
 * optional). A line with no tab is one cell (a link list separated by spaces or commas is split into one link a row).
 */
export function rowTableFromPaste(text: string, hasHeader?: boolean): RowTable {
  const clean = text.replace(/^\ufeff/, '');
  if (clean.includes('\t')) {
    return rowTableOf('paste', parseCsvRecords(clean, '\t', widthOf('paste')).map((record) => ({ row: record.record, cells: record.cells })), hasHeader);
  }
  const records: Array<{ row: number; cells: string[] }> = [];
  let row = 0;
  for (const line of clean.split(/\r\n|\r|\n/)) {
    const pieces = line.split(/[\s,;]+/).filter((piece) => piece.trim() !== '');
    if (pieces.length === 0) {
      row += 1;
      continue;
    }
    for (const piece of pieces) {
      row += 1;
      records.push({ row, cells: [piece] });
    }
  }
  return rowTableOf('paste', records, hasHeader);
}

/** A file's bytes as text: UTF-16 (a BOM), else UTF-8 (a BOM dropped). */
export function fileText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  return buffer.toString('utf8').replace(/^\ufeff/, '');
}

/** The format of a file, by its name, else by its bytes. */
export function fileFormatOf(fileName: string, bytes: Uint8Array): Exclude<RowTableFormat, 'paste' | 'sheet'> {
  if (/\.xlsx$/i.test(fileName) || (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    return 'xlsx';
  }
  if (/\.json$/i.test(fileName)) return 'json';
  if (/\.tsv$/i.test(fileName)) return 'tsv';
  if (/\.(?:csv|txt)$/i.test(fileName)) return 'csv';
  return /^\s*[[{]/.test(fileText(bytes.subarray(0, 64))) ? 'json' : 'csv';
}

/** A text table (.csv, .tsv, .txt): its delimiter guessed (a tab, a comma or a semicolon). */
export function rowTableFromText(format: 'csv' | 'tsv', text: string, hasHeader?: boolean, limits: RowTableLimits = {}): RowTable {
  const clean = text.replace(/^\ufeff/, '');
  const records = parseCsvRecords(clean, format === 'tsv' ? '\t' : delimiterOf(clean), widthOf(format));
  return rowTableOf(format, records.map((record) => ({ row: record.record, cells: record.cells })), hasHeader, limits);
}

/**
 * A JSON file (an array of objects, or one holding it under jobs / items / data / results / postings): its keys name the
 * columns. v35 FIX-PARSE (sec S1): the keys are collected in a Set and refused past JOB_IMPORT_MAX_COLUMNS (a key longer
 * than a column's name may be is no job field: left out); with `maxRows`, only the first `maxRows + 1` objects become
 * rows (the rest are counted). Its cells nest at most three lists deep (cellText).
 */
export function rowTableFromJson(text: string, limits: RowTableLimits = {}): RowTable {
  const objects = jsonObjectsOf(text);
  const kept = limits.maxRows !== undefined && objects.length > limits.maxRows + 1 ? objects.slice(0, limits.maxRows + 1) : objects;
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const object of kept) {
    for (const key of Object.keys(object)) {
      if (key.length > JOB_IMPORT_COLUMN_NAME_MAX_CHARS || seen.has(key)) continue;
      if (columns.length >= JOB_IMPORT_MAX_COLUMNS) throw new IngestError(tooManyColumnsText('json'));
      seen.add(key);
      columns.push(key);
    }
  }
  return {
    format: 'json',
    columns,
    hasHeader: true,
    rows: kept.map((object, index) => ({ row: index + 1, cells: columns.map((column) => cellText(object[column])) })),
    ...(kept.length < objects.length ? { totalRows: objects.length } : {}),
  };
}

/**
 * A file as a table (see fileFormatOf); an .xlsx file's `sheet`, else its first. Read up to `maxRows` (the route's
 * limit; SHEET_MAX_ROWS when none is named): one row past it is kept, the rest counted. Throws IngestError (XlsxError).
 */
export async function rowTableFromFile(
  fileName: string,
  bytes: Uint8Array,
  options: { hasHeader?: boolean; sheet?: string; maxRows?: number } = {},
): Promise<RowTable> {
  const limits = { maxRows: options.maxRows ?? SHEET_MAX_ROWS };
  const format = fileFormatOf(fileName, bytes);
  if (format === 'xlsx') {
    // A header row and one row past the limit are read; the rows after them are counted.
    const read = await readXlsxSheet(bytes, options.sheet, { maxRows: limits.maxRows + 2 });
    const table = rowTableOf('xlsx', read.rows, options.hasHeader, limits);
    const totalRows = (table.totalRows ?? table.rows.length) + read.moreRows;
    return { ...table, ...(totalRows > table.rows.length ? { totalRows } : {}), sheets: read.sheets, sheet: read.sheet };
  }
  const text = fileText(bytes);
  if (format === 'json') return rowTableFromJson(text, limits);
  return rowTableFromText(format, text, options.hasHeader, limits);
}
