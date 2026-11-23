import { IMPORT_FIELDS, linkKey, parseFlexibleDate, tidyText, type ImportField, type ImportMapping } from '@tailorit/shared';
import { cleanUrl, sha256, storedSourceJobId } from './normalize';
import { IngestError, type RawPosting } from './types';

// Jobs from a spreadsheet or a JSON file (Admin > Import jobs), and from a Google Sheet tab (stored as a CSV copy):
// parse, guess which column is which (free_tailor's sheet headers included: Date, NO(DATE), Company, Job Title,
// Job Link, Job Description), and read each row as a posting. Row numbers are the rows a spreadsheet shows.

export {
  IMPORT_FIELDS,
  IMPORT_FIELD_LABEL,
  REQUIRED_IMPORT_FIELDS,
  importFieldInfo,
  type ImportField,
  type ImportMapping,
} from '@tailorit/shared';

export const IMPORT_FORMATS = ['csv', 'json'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** Header spellings per field, folded (lower case, letters and digits only), best first. */
const HEADER_GUESSES: Record<ImportField, readonly string[]> = {
  title: ['jobtitle', 'title', 'position', 'positiontitle', 'role', 'roletitle', 'jobname', 'job', 'name'],
  company: ['company', 'companyname', 'employer', 'organization', 'organisation', 'org', 'hiringcompany'],
  url: ['joblink', 'link', 'url', 'joburl', 'applyurl', 'applylink', 'applicationurl', 'applicationlink', 'postingurl', 'postinglink', 'href', 'hostedurl', 'absoluteurl'],
  description: ['jobdescription', 'description', 'jd', 'details', 'jobdetails', 'descriptionhtml', 'content', 'body', 'summary', 'descriptionplain'],
  location: ['location', 'locations', 'joblocation', 'city', 'office', 'place'],
  postedAt: ['date', 'posted', 'postedat', 'postedon', 'dateposted', 'postdate', 'postingdate', 'created', 'createdat', 'publishedat', 'published'],
  salary: ['salary', 'salaryrange', 'compensation', 'pay', 'payrange', 'wage', 'rate'],
  employmentType: ['employmenttype', 'jobtype', 'type', 'commitment', 'timetype', 'contracttype'],
  workArrangement: ['workarrangement', 'workplacetype', 'workplace', 'remote', 'worktype', 'locationtype', 'arrangement', 'workmodel'],
  department: ['department', 'team', 'function', 'category'],
  id: ['id', 'jobid', 'reqid', 'requisitionid', 'requisition', 'externalid', 'postingid'],
};

const fold = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Which column holds which field, by header name; each column is used once. NO(DATE) is the sheet's row counter. */
export function guessMapping(columns: readonly string[]): ImportMapping {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((field) => [field, null])) as ImportMapping;
  const used = new Set<string>();
  const folded = columns.map((column) => ({ column, key: fold(column) })).filter(({ key }) => key && key !== 'nodate');
  for (const field of IMPORT_FIELDS) {
    for (const guess of HEADER_GUESSES[field]) {
      const hit = folded.find(({ column, key }) => key === guess && !used.has(column));
      if (hit) {
        mapping[field] = hit.column;
        used.add(hit.column);
        break;
      }
    }
  }
  return mapping;
}

/** The format a file is in, by its name, else by its first character. */
export function detectFormat(fileName: string, text: string): ImportFormat {
  if (/\.json$/i.test(fileName)) return 'json';
  if (/\.(?:csv|tsv|txt)$/i.test(fileName)) return 'csv';
  return /^\s*[[{]/.test(text) ? 'json' : 'csv';
}

/** How many times `char` occurs in `text` (counted, not split: a long line makes no array). */
export function countOf(text: string, char: string): number {
  let count = 0;
  for (let at = text.indexOf(char); at !== -1; at = text.indexOf(char, at + 1)) count += 1;
  return count;
}

/** The delimiter of a CSV text: the one of , ; tab that splits its first line most. */
function delimiterOf(text: string): string {
  const end = text.search(/\r?\n/);
  const firstLine = end === -1 ? text : text.slice(0, end);
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t']) {
    const count = countOf(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** One CSV record: its cells, and its 1-based position in the file counting blank records (a spreadsheet's row). */
export interface CsvRecord {
  cells: string[];
  record: number;
}

/**
 * v35 FIX-PARSE (sec S1): the most cells a record keeps. Past `maxColumns` a blank cell is dropped and a filled one
 * refuses the table with `tooWide` (its words name the file or the pasted rows).
 */
export interface CsvWidth {
  maxColumns: number;
  tooWide: string;
}

/**
 * RFC 4180 CSV: quoted fields with "" escapes and line breaks, CRLF or LF, a BOM ignored. Blank records are dropped
 * but counted, so `record` is the row a spreadsheet shows. `delimiter` overrides the guess from the first line;
 * `width` caps a record's cells (CsvWidth). v35 FIX-PARSE (sec S1): runs of plain or quoted text are taken as slices (a
 * 5 MB cell was 5 million string appends).
 */
export function parseCsvRecords(input: string, delimiter?: string, width?: CsvWidth): CsvRecord[] {
  const text = input.replace(/^\ufeff/, '');
  const separator = (delimiter ?? delimiterOf(text)).charCodeAt(0);
  const records: CsvRecord[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let record = 1;
  const endField = () => {
    if (!width || row.length < width.maxColumns) row.push(field);
    else if (field.trim() !== '') throw new IngestError(width.tooWide);
    field = '';
  };
  const endRecord = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) records.push({ cells: row, record });
    row = [];
    record += 1;
  };
  const QUOTE = 34;
  const LF = 10;
  const CR = 13;
  let index = 0;
  while (index < text.length) {
    if (quoted) {
      // Up to the next quote: a doubled one is a quote in the text, a single one ends the quoted part.
      const close = text.indexOf('"', index);
      if (close === -1) {
        field += text.slice(index);
        break;
      }
      field += text.slice(index, close);
      if (text.charCodeAt(close + 1) === QUOTE) {
        field += '"';
        index = close + 2;
      } else {
        quoted = false;
        index = close + 1;
      }
      continue;
    }
    const code = text.charCodeAt(index);
    if (code === QUOTE && field === '') {
      quoted = true;
      index += 1;
    } else if (code === separator) {
      endField();
      index += 1;
    } else if (code === LF || code === CR) {
      index += code === CR && text.charCodeAt(index + 1) === LF ? 2 : 1;
      endRecord();
    } else {
      // A run of plain text (a quote inside a field is text), up to the next separator, line break or quote.
      let end = index + 1;
      for (; end < text.length; end += 1) {
        const next = text.charCodeAt(end);
        if (next === separator || next === LF || next === CR || next === QUOTE) break;
      }
      field += text.slice(index, end);
      index = end;
    }
  }
  endRecord();
  return records;
}

/** RFC 4180 CSV as rows of cells (blank lines dropped). */
export function parseCsv(input: string): string[][] {
  return parseCsvRecords(input).map((entry) => entry.cells);
}

export interface Table {
  format: ImportFormat;
  columns: string[];
  rows: Array<Record<string, string>>;
  /** The row number of each of `rows`, as problems name them: a spreadsheet's row (CSV), the item's place (JSON). */
  rowNumbers: number[];
}

/** How a CSV text is read: a forced delimiter (a Google Sheet copy is always comma-separated), and the spreadsheet
 *  row its first record is (a copy whose header row was row 3 of the sheet starts at 3). */
export interface CsvTableOptions {
  delimiter?: string;
  firstRow?: number;
}

/** v35 FIX-PARSE (sec S7): how deep a cell's lists and objects may nest; a JSON file nested deeper is no list of jobs. */
const JSON_CELL_MAX_DEPTH = 3;
export const NOT_A_JOB_LIST = 'This file is not a list of jobs.';

/**
 * A JSON value as a cell's text: a list's items joined with "; ", an object's one text (name, text, title, ...) or the
 * object as JSON. v35 FIX-PARSE (sec S7): lists nest at most JSON_CELL_MAX_DEPTH deep, and an object too deep to write
 * as JSON (the stack's limit) is refused too, with words (400), never a 500.
 */
export function cellText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object') return '';
  if (depth >= JSON_CELL_MAX_DEPTH) throw new IngestError(NOT_A_JOB_LIST);
  if (Array.isArray(value)) return value.map((item) => cellText(item, depth + 1)).filter(Boolean).join('; ');
  const record = value as Record<string, unknown>;
  // {"name": "Acme"} / {"location": "Paris"}: the one text a nested object usually carries.
  for (const key of ['name', 'text', 'title', 'location', 'value', 'url']) {
    if (typeof record[key] === 'string') return record[key];
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    if (error instanceof RangeError) throw new IngestError(NOT_A_JOB_LIST);
    throw error;
  }
}

/**
 * Column names made unique: a repeated name gets its column's number ("Title (4)"); the first keeps its own.
 * v35 FIX-PARSE (sec S1): one pass with a Set (was an indexOf per column: a header of 60,000 columns took seconds).
 */
export function uniqueColumnNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((name, index) => {
    if (seen.has(name)) return `${name} (${index + 1})`;
    seen.add(name);
    return name;
  });
}

/** A CSV file as a table: the first record is the header; repeated or blank headers get a number. */
export function tableFromCsv(text: string, options: CsvTableOptions = {}): Table {
  const records = parseCsvRecords(text, options.delimiter);
  if (records.length === 0) throw new IngestError('The file is empty.');
  const offset = (options.firstRow ?? 1) - 1;
  const columns = uniqueColumnNames(records[0]!.cells.map((cell, index) => tidyText(cell) || `Column ${index + 1}`));
  const body = records.slice(1);
  return {
    format: 'csv',
    columns,
    rows: body.map(({ cells }) => Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? '']))),
    rowNumbers: body.map(({ record }) => record + offset),
  };
}

/** A JSON file's job objects: an array of objects, or an object holding one under jobs / items / data / results / postings. */
export function jsonObjectsOf(text: string): Array<Record<string, unknown>> {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\ufeff/, ''));
  } catch {
    throw new IngestError('The file is not valid JSON.');
  }
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    data = [record.jobs, record.items, record.data, record.results, record.postings].find(Array.isArray) ?? data;
  }
  if (!Array.isArray(data)) throw new IngestError('The JSON file must hold a list of jobs (an array of objects).');
  const objects = data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  if (objects.length === 0) throw new IngestError('The JSON file holds no job objects.');
  return objects;
}

/**
 * A JSON file as a table: an array of objects, or an object holding one under jobs / items / data / results. v35
 * FIX-PARSE (sec S1): the keys are collected in a Set (was an includes per key), and each row holds its own object's keys
 * only (a column a row lacks reads as ''), so 5,000 objects with keys of their own make 5,000 cells, not 25 million.
 */
export function tableFromJson(text: string): Table {
  const objects = jsonObjectsOf(text);
  const seen = new Set<string>();
  const columns: string[] = [];
  const rows = objects.map((object) => {
    const keys = Object.keys(object);
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
    return Object.fromEntries(keys.map((key) => [key, cellText(object[key])]));
  });
  return { format: 'json', columns, rows, rowNumbers: objects.map((_, index) => index + 1) };
}

/** A file as a table; `options` apply to CSV only. */
export function readTable(fileName: string, text: string, options: CsvTableOptions = {}): Table {
  return detectFormat(fileName, text) === 'json' ? tableFromJson(text) : tableFromCsv(text, options);
}

/** A mapping with every named column checked against the table; unknown columns become null. */
export function cleanMapping(mapping: Partial<Record<ImportField, string | null>>, columns: readonly string[]): ImportMapping {
  const out = Object.fromEntries(IMPORT_FIELDS.map((field) => [field, null])) as ImportMapping;
  for (const field of IMPORT_FIELDS) {
    const column = mapping[field];
    if (typeof column === 'string' && columns.includes(column)) out[field] = column;
  }
  return out;
}

function cell(row: Record<string, string>, mapping: ImportMapping, field: ImportField): string {
  const column = mapping[field];
  return column ? (row[column] ?? '').trim() : '';
}

/** A row's posted date: a calendar date at midnight UTC, or an ISO timestamp as given. */
function postedAtOf(value: string): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const day = parseFlexibleDate(value);
  return day ? `${day}T00:00:00.000Z` : null;
}

/**
 * A job link that leads somewhere: a web address (the scheme may be left out) whose host has a dot or is an IP
 * address. A link's label ("Apply", "N/A"), which a sheet shows for a HYPERLINK() cell, is not one; read as an address
 * it would merge every such row into one job at https://apply/.
 */
export function isWebAddress(text: string): boolean {
  const url = cleanUrl(text);
  if (!url) return false;
  const host = new URL(url).hostname;
  return host.includes('.') || host.startsWith('[');
}

/** A stable id for a row without one: its link, else a hash of company, title and description. */
export function rowIdOf(company: string, title: string, url: string, description: string): string {
  return linkKey(url) ?? `row-${sha256(`${company}\n${title}\n${description}`).slice(0, 32)}`;
}

/** How rows are read beyond the mapping. */
export interface RowOptions {
  /** Every row's posted date (an ISO timestamp), whatever a posted-date column says: a sheet tab named for its day. */
  postedAt?: string | null;
}

const quoted = (text: string) => (text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text);

/** One row as a posting, or an error sentence naming the row (as a spreadsheet numbers it). */
export function rowToPosting(
  row: Record<string, string>,
  mapping: ImportMapping,
  rowNumber: number,
  options: RowOptions = {},
): { posting: RawPosting } | { error: string } {
  // v31 LINK2: an import is a list of links: only the link is needed (the title and company, when mapped, only name
  // the row in a message; TailorIT reads each posting from its link and ignores the rest).
  const title = cell(row, mapping, 'title');
  const company = cell(row, mapping, 'company');
  const url = cell(row, mapping, 'url');
  const named = title ? ` ("${title}")` : '';
  if (!url) return { error: `Row ${rowNumber}${named} has no job link.` };
  if (!isWebAddress(url)) {
    return {
      error: `Row ${rowNumber}${named} has a job link that is not a web address ("${quoted(url)}"). Put the address itself in the column.`,
    };
  }
  const description = cell(row, mapping, 'description');
  const isHtml = /<\/?(?:p|div|ul|ol|li|br|h[1-6]|strong|b)\b/i.test(description);
  const location = cell(row, mapping, 'location');
  // As the store keeps it (a long link's key is cut and hashed), so a repeated row is told by the stored id too.
  const sourceJobId = storedSourceJobId(cell(row, mapping, 'id') || rowIdOf(company, title, url, description));
  // A "Remote" column of yes/no answers says the arrangement without naming it.
  const arrangement = cell(row, mapping, 'workArrangement');
  const yesNoRemote = mapping.workArrangement !== null && fold(mapping.workArrangement) === 'remote';
  const remoteAnswer = yesNoRemote && /^(?:yes|y|true|1)$/i.test(arrangement);
  return {
    posting: {
      sourceJobId,
      title,
      company: { name: company },
      descriptionHtml: isHtml ? description : null,
      descriptionText: isHtml ? null : description,
      url,
      locations: location ? [location] : [],
      salaryText: cell(row, mapping, 'salary') || null,
      employmentText: cell(row, mapping, 'employmentType') || null,
      workArrangement: remoteAnswer ? 'remote' : null,
      arrangementText: yesNoRemote ? null : arrangement || null,
      department: cell(row, mapping, 'department') || null,
      postedAt: options.postedAt ?? postedAtOf(cell(row, mapping, 'postedAt')),
    },
  };
}
