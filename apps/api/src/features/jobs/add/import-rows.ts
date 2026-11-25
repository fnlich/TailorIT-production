import {
  cleanJobRow,
  cleanJobRowMapping,
  guessJobRowMapping,
  JOB_IMPORT_PREVIEW_CELL_CHARS,
  JOB_IMPORT_PREVIEW_ROWS,
  JOB_ROW_FIELDS,
  linkKey,
  parseSalary,
  positionalJobRowMapping,
  rowLinkOf,
  type JobImportPreview,
  type JobImportRowReason,
  type JobRowDetails,
  type JobRowField,
  type JobRowMapping,
  type JobRowMappingInput,
} from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { RowTable } from '../../ingest/row-table';
import { isRefusedPageHost } from '../../job-reviews/hosts';
import { sharedAddress } from './address';
import { isAddableLink } from './pipeline';

// v35 IMPORT (SP v35 PLAN.md H1): a table's rows (ingest/row-table.ts) read by the shared row contract
// (packages/shared/src/ingest/rows.ts), for every import of every way, admins' and people's: the mapping (the one
// chosen, over the guess from the header names, or H1's order for a table with no header row), each row's fields
// cleaned and cut to their limits, its link made canonical and checked as Add job checks one (its shared form: no secret
// parameter; https on a public host), and what is known before any read: a row with no link, a link that is no job link,
// a site TailorIT never reads (LinkedIn, a refused board: "Can't import from <host>"), a link an earlier row gave
// ("Repeats row N": the first row wins). Every other row waits for TailorIT's read (the link queue).

/** One row as read: its link (null when none TailorIT can use), its fields, and its result when known now. */
export interface ParsedImportRow {
  row: number;
  /** The link in its shared canonical form. */
  url: string | null;
  urlKey: string | null;
  host: string | null;
  /** The link cell as given (cut), for a row with no usable link. */
  linkCell: string;
  details: JobRowDetails;
  /** Known now: `failed` (no link, not a job link, a site never read) or `repeated`; null: it waits for a read. */
  result: 'failed' | 'repeated' | null;
  reason: JobImportRowReason | null;
  repeatsRow: number | null;
}

/** The rows a headerless table's pay guess looks at, and the longest cell that reads as a rate (not a sentence). */
const PAY_SAMPLE_ROWS = 20;
const PAY_CELL_MAX_CHARS = 60;
const NUMBERS_ONLY = /^[\s\d,.\-–—−~+]*$/;

/** Whether a cell reads as pay: short, more than numbers alone (an id, a count), and parseSalary finds an amount in it. */
function looksLikePay(cell: string): boolean {
  const text = cell.trim();
  if (!text || text.length > PAY_CELL_MAX_CHARS || NUMBERS_ONLY.test(text)) return false;
  const pay = parseSalary(text);
  return pay !== null && (pay.min !== null || pay.max !== null);
}

/**
 * v35 FIX-PARSE (decision 9, the ux review's owner question 3): in a table with no header row, a column whose first
 * rows' filled cells mostly read as pay is guessed as Rate wherever it is (the field H1's order gave it takes Rate's
 * column in turn: "link, company, title, $50/hr" maps the fourth column to Rate, not Description). The link's column is
 * never moved, and a Rate column that reads as pay keeps its place. The person can change it in the preview.
 */
function withPayColumn(table: RowTable, mapping: JobRowMapping): JobRowMapping {
  const sample = table.rows.slice(0, PAY_SAMPLE_ROWS);
  const isPay = (index: number) => {
    let filled = 0;
    let pay = 0;
    for (const { cells } of sample) {
      const cell = cells[index] ?? '';
      if (!cell.trim()) continue;
      filled += 1;
      if (looksLikePay(cell)) pay += 1;
    }
    return filled > 0 && pay * 2 > filled;
  };
  const rateIndex = mapping.rate === null ? -1 : table.columns.indexOf(mapping.rate);
  if (rateIndex >= 0 && isPay(rateIndex)) return mapping;
  for (let index = 0; index < table.columns.length; index += 1) {
    const column = table.columns[index]!;
    if (index === rateIndex || mapping.link === column || !isPay(index)) continue;
    const field = JOB_ROW_FIELDS.find((name) => mapping[name] === column);
    return { ...mapping, ...(field ? { [field]: mapping.rate } : {}), rate: column };
  }
  return mapping;
}

/**
 * The mapping an import uses: the guess (a header row's names) or H1's order (none; a column that reads as pay is Rate:
 * withPayColumn), then the person's choices over it.
 */
export function mappingOf(table: RowTable, input?: JobRowMappingInput | null): JobRowMapping {
  const base = table.hasHeader ? guessJobRowMapping(table.columns) : withPayColumn(table, positionalJobRowMapping(table.columns));
  return input ? cleanJobRowMapping({ ...base, ...input }, table.columns) : base;
}

/** A row's cells by field, as mapped (each field's column found once for the table, not once a row). */
function cellReader(table: RowTable, mapping: JobRowMapping): (cells: readonly string[]) => Partial<Record<JobRowField, string>> {
  const columns: Array<[JobRowField, number]> = [];
  for (const field of JOB_ROW_FIELDS) {
    const column = mapping[field];
    const index = column === null ? -1 : table.columns.indexOf(column);
    if (index >= 0) columns.push([field, index]);
  }
  return (cells) => {
    const out: Partial<Record<JobRowField, string>> = {};
    for (const [field, index] of columns) out[field] = cells[index] ?? '';
    return out;
  };
}

/** What a row's link alone says, before any read: the link's shared form, and the result it gives now (or null). */
type ImportLinkPart = Pick<ParsedImportRow, 'url' | 'urlKey' | 'host' | 'result' | 'reason' | 'repeatsRow'>;

/** A row's link checked (`firstRowOf`: the row each link key was first given in, so a later one is a repeat). */
function linkPartOf(row: number, linkCell: string, firstRowOf: Map<string, number>): ImportLinkPart {
  const link = importLinkOf(linkCell);
  if ('reason' in link) return { url: null, urlKey: null, host: null, result: 'failed', reason: link.reason, repeatsRow: null };
  const parsed = { url: link.url, urlKey: link.key, host: link.host };
  if (isRefusedPageHost(link.host)) return { ...parsed, result: 'failed', reason: 'unreadable_host', repeatsRow: null };
  const first = firstRowOf.get(link.key);
  if (first !== undefined) return { ...parsed, result: 'repeated', reason: null, repeatsRow: first };
  firstRowOf.set(link.key, row);
  return { ...parsed, result: null, reason: null, repeatsRow: null };
}

/** The link of a cell in the shared form an add keeps (address.ts), when it is one Add job would read. */
export function importLinkOf(cell: string): { url: string; key: string; host: string } | { reason: 'invalid_link' | 'no_link' } {
  if (!cell.trim()) return { reason: 'no_link' };
  const canonical = rowLinkOf(cell);
  const url = canonical ? sharedAddress(canonical) : null;
  const key = url ? linkKey(url) : null;
  if (!canonical || !url || !key || url.length > 2100 || !isAddableLink(canonical) || !isAddableLink(url)) return { reason: 'invalid_link' };
  return { url, key, host: new URL(url).hostname };
}

/** Every row of the table read by `mapping` (see the top), in order. */
export function parseImportRows(table: RowTable, mapping: JobRowMapping): ParsedImportRow[] {
  const read = cellReader(table, mapping);
  const firstRowOf = new Map<string, number>();
  return table.rows.map(({ row, cells }) => {
    const { link: linkCell, ...details } = cleanJobRow(read(cells));
    return { row, linkCell: linkCell.slice(0, 300), details, ...linkPartOf(row, linkCell, firstRowOf) };
  });
}

/** A known-now row's problem in words (the preview's and the results' line). */
export function rowProblemText(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  row: Pick<ParsedImportRow, 'result' | 'reason' | 'repeatsRow' | 'host'>,
): string | null {
  const constants = constantsOf(deps);
  if (row.result === 'repeated' && row.repeatsRow !== null) return constants.message('MSG_JOB_IMPORT_ROW_REPEATS', { row: row.repeatsRow });
  if (row.result !== 'failed') return null;
  if (row.reason === 'no_link') return constants.message('MSG_JOB_IMPORT_ROW_NO_LINK');
  if (row.reason === 'unreadable_host') return constants.message('MSG_JOB_IMPORT_ROW_HOST', { host: row.host ?? '' });
  // v37 FIX-37B (E8): its board's terms say no (an admin's record).
  if (row.reason === 'terms') return constants.message('MSG_JOB_IMPORT_ROW_TERMS', { host: row.host ?? '' });
  return constants.message('MSG_JOB_ADD_REFUSED_LINK');
}

const cut = (text: string | undefined) => (text ?? '').slice(0, JOB_IMPORT_PREVIEW_CELL_CHARS);

/**
 * A preview (H1 "Mapping"): the mapping in use and the first rows, read as an import would read them. Nothing is saved.
 * v35 FIX-PARSE (sec S1): only the rows it shows are read whole; the links of at most the import's rows (`maxRows`) are
 * checked for its link count and its first 20 problems; the rows past them are only counted.
 */
export function importPreview(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  table: RowTable,
  input: { name: string; mapping?: JobRowMappingInput | null; maxRows: number },
): JobImportPreview {
  const mapping = mappingOf(table, input.mapping);
  const read = cellReader(table, mapping);
  const firstRowOf = new Map<string, number>();
  const checked = table.rows.slice(0, Math.max(input.maxRows, JOB_IMPORT_PREVIEW_ROWS)).map(({ row, cells }) => {
    const linkCell = cleanJobRow({ link: read(cells).link ?? '' }).link;
    return { row, linkCell: linkCell.slice(0, 300), ...linkPartOf(row, linkCell, firstRowOf) };
  });
  const problems: string[] = [];
  for (const row of checked) {
    if (problems.length >= 20) break;
    const problem = rowProblemText(deps, row);
    if (problem) problems.push(`Row ${row.row}: ${problem}`);
  }
  return {
    name: input.name,
    format: table.format,
    hasHeader: table.hasHeader,
    columns: table.columns,
    mapping,
    sample: table.rows
      .slice(0, JOB_IMPORT_PREVIEW_ROWS)
      .map(({ cells }) => Object.fromEntries(table.columns.map((column, index) => [column, cut(cells[index])]))),
    rows: checked.slice(0, JOB_IMPORT_PREVIEW_ROWS).map((row, index) => {
      const details = cleanJobRow(read(table.rows[index]!.cells));
      return {
        row: row.row,
        link: row.url ?? row.linkCell,
        company: cut(details.company),
        title: cut(details.title),
        description: cut(details.description),
        rate: cut(details.rate),
        location: cut(details.location),
        problem: rowProblemText(deps, row),
      };
    }),
    rowCount: table.totalRows ?? table.rows.length,
    // v35 FIX-PARSE (the ux review's L1): the rows TailorIT will read (a repeat, a refused site or no link is not one).
    linkCount: checked.filter((row) => row.result === null).length,
    maxRows: input.maxRows,
    ...(table.sheets ? { sheets: table.sheets } : {}),
    ...(table.sheet !== undefined ? { sheet: table.sheet } : {}),
    problems,
    missingLink: mapping.link === null,
  };
}
