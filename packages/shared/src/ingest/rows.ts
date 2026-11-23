import { z } from 'zod';
import { IsoDateTime } from '../core/list';
import { JOB_LINK_MAX_CHARS, JOB_VERIFY_REASONS } from '../jobs/add';
import { canonicalJobUrl } from '../jobs/canonical';

// v35 IMPORT (SP v35 PLAN.md H1-H2): one import of job links for admins and users, three ways (one link or many links
// pasted, a file, a Google Sheet), five fields and a place. This module is the one row contract both sides read: the
// fields, the header names a column is guessed from, the rule for a table with no header row, the cleaning and the
// length limits, the results each row comes to, and the bodies and answers of the import routes. The API parses every
// way into rows with it (apps/api/src/features/jobs/add/import-rows.ts); the web shows the preview and the results with
// it. Pure: no network, no URL type (this package's lib is ES only).

/** The fields of a row, in the order a table with no header row gives them (H1). */
export const JOB_ROW_FIELDS = ['link', 'company', 'title', 'description', 'rate', 'location'] as const;
export type JobRowField = (typeof JOB_ROW_FIELDS)[number];

export const JOB_ROW_FIELD_LABEL: Record<JobRowField, string> = {
  link: 'Job link',
  company: 'Company',
  title: 'Job title',
  description: 'Job description',
  rate: 'Rate',
  location: 'Location',
};

/**
 * The header names each field is guessed from, folded (foldHeader: no case, spaces, "_" or "-"), best first. Exactly
 * H1's lists: nothing else is read.
 */
export const JOB_ROW_HEADER_ALIASES: Record<JobRowField, readonly string[]> = {
  link: ['link', 'url', 'joblink', 'joburl', 'posting', 'applylink', 'applyurl'],
  company: ['company', 'companyname', 'employer', 'organization'],
  title: ['title', 'jobtitle', 'position', 'role'],
  description: ['description', 'jobdescription', 'jd', 'details', 'summary'],
  rate: ['rate', 'pay', 'payrate', 'salary', 'compensation', 'wage'],
  location: ['location', 'place', 'city', 'where'],
};

/** The longest text each field keeps (the description as plain text, paragraphs kept). */
export const JOB_ROW_MAX_CHARS: Record<Exclude<JobRowField, 'link'>, number> = {
  company: 120,
  title: 200,
  description: 20_000,
  rate: 120,
  location: 200,
};

/** The rows a mapping preview shows. */
export const JOB_IMPORT_PREVIEW_ROWS = 5;
/** The longest cell a preview shows (the description's first words). */
export const JOB_IMPORT_PREVIEW_CELL_CHARS = 300;
/** Rows an import answers per page of its results. */
export const JOB_IMPORT_RESULTS_PAGE = 100;
/** The most text a pasted list may hold, in characters (1,000 links of a long spreadsheet row each). */
export const JOB_IMPORT_PASTE_MAX_CHARS = 5_000_000;
/** An .xlsx file: the most bytes its parts may hold once unzipped, and the most parts (a zip bomb is refused). */
export const XLSX_MAX_UNCOMPRESSED_MB = 50;
export const XLSX_MAX_ENTRIES = 2_000;
/** An import of more than this many rows tells its person when it finished (a notice). */
export const JOB_IMPORT_NOTICE_MIN_ROWS = 10;
/**
 * v35 FIX-PARSE (sec S1): the technical caps that keep the reading of one import short whatever its file holds (a cell
 * of 100,000 "<", a header of 60,000 columns, a shared string used by every row). The most columns a table may have:
 * an .xlsx file and a Google Sheet keep their first ones; any other table with more (a CSV, a TSV, pasted rows, a JSON
 * file's keys) is refused with words. A column's name is cut to JOB_IMPORT_COLUMN_NAME_MAX_CHARS.
 */
export const JOB_IMPORT_MAX_COLUMNS = 100;
export const JOB_IMPORT_COLUMN_NAME_MAX_CHARS = 300;
/**
 * The most of a cell an import reads: the rest is cut before it is cleaned (a description then keeps
 * JOB_ROW_MAX_CHARS.description of its text; an .xlsx file's shared string is cut to it when read). A one-line field
 * reads JOB_ROW_LINE_READ_CHARS before its whitespace is collapsed (ten times the longest one-line field).
 */
export const JOB_ROW_CELL_READ_CHARS = 40_000;
export const JOB_ROW_LINE_READ_CHARS = 2_000;

/** A header as compared: lower case, without spaces, "_" or "-". */
export function foldHeader(header: string): string {
  return header.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Which column holds each field (a column name), or null when none does. */
export type JobRowMapping = Record<JobRowField, string | null>;

/** Every field, none mapped. */
export function emptyJobRowMapping(): JobRowMapping {
  return Object.fromEntries(JOB_ROW_FIELDS.map((field) => [field, null])) as JobRowMapping;
}

/** The mapping guessed from the header names (H1's aliases, best first); each column is used once. */
export function guessJobRowMapping(columns: readonly string[]): JobRowMapping {
  const mapping = emptyJobRowMapping();
  const used = new Set<string>();
  const folded = columns.map((column) => ({ column, key: foldHeader(column) }));
  for (const field of JOB_ROW_FIELDS) {
    for (const alias of JOB_ROW_HEADER_ALIASES[field]) {
      const hit = folded.find(({ column, key }) => key === alias && !used.has(column));
      if (hit) {
        mapping[field] = hit.column;
        used.add(hit.column);
        break;
      }
    }
  }
  return mapping;
}

/** The mapping of a table with no header row: column 1 is the link, the rest Company, Title, Description, Rate, Location. */
export function positionalJobRowMapping(columns: readonly string[]): JobRowMapping {
  const mapping = emptyJobRowMapping();
  JOB_ROW_FIELDS.forEach((field, index) => {
    mapping[field] = columns[index] ?? null;
  });
  return mapping;
}

/** A mapping with every named column checked against the table's columns (an unknown one is none). */
export function cleanJobRowMapping(mapping: Partial<Record<JobRowField, string | null>>, columns: readonly string[]): JobRowMapping {
  const out = emptyJobRowMapping();
  for (const field of JOB_ROW_FIELDS) {
    const column = mapping[field];
    if (typeof column === 'string' && columns.includes(column)) out[field] = column;
  }
  return out;
}

/** A cell that reads as a web address (a scheme, or a dotted host with a path): a row's link, not a header's name. */
export function isLinkCell(cell: string | undefined): boolean {
  const text = (cell ?? '').trim();
  if (!text || /\s/.test(text)) return false;
  if (/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(text)) return true;
  return /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\/\S*$/i.test(text);
}

/** H1's no-header rule: a table whose first row's first cell is a link has no header row. */
export function firstRowIsHeader(firstRow: readonly string[]): boolean {
  return !isLinkCell(firstRow[0]);
}

/**
 * A row's link as TailorIT keeps it: an address given without its scheme gets https, then Add job's canonical form
 * (canonicalJobUrl: https, tracking parameters dropped). Null for no address. The server checks it as Add job does
 * (its shared form, a public host).
 */
export function rowLinkOf(cell: string): string | null {
  const text = cell.trim();
  if (!text || text.length > JOB_LINK_MAX_CHARS || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text.replace(/^\/+/, '')}`;
  if (!/^https?:\/\//i.test(withScheme)) return null;
  return canonicalJobUrl(withScheme);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/**
 * Whether a cell holds HTML (block or inline tags a job description uses). v35 FIX-PARSE (sec S1): a tag's attributes
 * stop at the next "<" as well as at ">", so a cell of unclosed tags is read once, not once per "<".
 */
function looksLikeHtml(text: string): boolean {
  return /<\/?(?:p|div|ul|ol|li|br|h[1-6]|strong|b|em|i|span|table|tr|td|section|article)\b[^<>]*>/i.test(text);
}

const SCRIPT_OR_STYLE_OPEN = /<(script|style)\b[^<>]*>/gi;
const SCRIPT_CLOSE = /<\/script\s*>/gi;
const STYLE_CLOSE = /<\/style\s*>/gi;

/**
 * The text without its script and style elements, read forward once: each element's close tag is looked for after its
 * open tag; an element with no close tag ends the reading (it and the rest are kept, as the tags are stripped after).
 */
function withoutScripts(text: string): string {
  SCRIPT_OR_STYLE_OPEN.lastIndex = 0;
  let out = '';
  let kept = 0;
  for (let open = SCRIPT_OR_STYLE_OPEN.exec(text); open; open = SCRIPT_OR_STYLE_OPEN.exec(text)) {
    const close = open[1]!.toLowerCase() === 'script' ? SCRIPT_CLOSE : STYLE_CLOSE;
    close.lastIndex = SCRIPT_OR_STYLE_OPEN.lastIndex;
    if (!close.exec(text)) break;
    out += text.slice(kept, open.index);
    kept = close.lastIndex;
    SCRIPT_OR_STYLE_OPEN.lastIndex = kept;
  }
  return kept === 0 ? text : out + text.slice(kept);
}

/**
 * A description as plain text: HTML reduced to text (blocks and line breaks kept as new lines, list items as "- "),
 * entities read, paragraphs kept (at most one blank line between them), at most JOB_ROW_MAX_CHARS.description.
 * v35 FIX-PARSE (sec S1): linear in the cell, which is cut to JOB_ROW_CELL_READ_CHARS first (a tag the cut leaves open
 * at its end is dropped).
 */
export function descriptionToText(input: string): string {
  const cut = input.length > JOB_ROW_CELL_READ_CHARS;
  let text = (cut ? input.slice(0, JOB_ROW_CELL_READ_CHARS) : input).replace(/\r\n?/g, '\n');
  if (looksLikeHtml(text)) {
    text = withoutScripts(cut ? text.replace(/<[^<>]*$/, '') : text)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^<>]*>/gi, '\n- ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<\/(?:p|div|ul|ol|h[1-6]|tr|table|section|article)\s*>/gi, '\n\n')
      .replace(/<(?:p|div|h[1-6]|tr|table|section|article)\b[^<>]*>/gi, '\n\n')
      .replace(/<[^<>]*>/g, '');
  }
  text = text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return safeChar(Number.parseInt(lower.slice(2), 16)) ?? whole;
    if (lower.startsWith('#')) return safeChar(Number.parseInt(lower.slice(1), 10)) ?? whole;
    return ENTITIES[lower] ?? whole;
  });
  const lines = text.split('\n').map((line) => line.replace(/[\t\f\v\u00a0 ]+/g, ' ').trim());
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, JOB_ROW_MAX_CHARS.description)
    .trim();
}

function safeChar(code: number): string | null {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return String.fromCodePoint(code);
}

/** A one-line field as kept: whitespace collapsed, trimmed, at most its limit (v35 FIX-PARSE: of its first JOB_ROW_LINE_READ_CHARS). */
export function rowLineOf(field: Exclude<JobRowField, 'link' | 'description'>, input: string): string {
  return input.slice(0, JOB_ROW_LINE_READ_CHARS).replace(/\s+/g, ' ').trim().slice(0, JOB_ROW_MAX_CHARS[field]).trim();
}

/** What a row gives beside its link (each field trimmed and within its limit; absent when empty). */
export const JobRowDetailsSchema = z.object({
  company: z.string().trim().min(1).max(JOB_ROW_MAX_CHARS.company).optional(),
  title: z.string().trim().min(1).max(JOB_ROW_MAX_CHARS.title).optional(),
  description: z.string().trim().min(1).max(JOB_ROW_MAX_CHARS.description).optional(),
  rate: z.string().trim().min(1).max(JOB_ROW_MAX_CHARS.rate).optional(),
  location: z.string().trim().min(1).max(JOB_ROW_MAX_CHARS.location).optional(),
});
export type JobRowDetails = z.infer<typeof JobRowDetailsSchema>;

/** One row: its link and what it gives. */
export const JobImportRowSchema = JobRowDetailsSchema.extend({
  link: z.string().trim().min(1, 'Give the job link.').max(JOB_LINK_MAX_CHARS, 'That link is too long.'),
});
export type JobImportRow = z.infer<typeof JobImportRowSchema>;

/**
 * A row's cells cleaned by the contract (descriptionToText, rowLineOf, the limits): what the import keeps. Absent fields
 * stay absent. The link is the cell as given (rowLinkOf makes it canonical).
 */
export function cleanJobRow(cells: Partial<Record<JobRowField, string>>): { link: string } & JobRowDetails {
  const out: { link: string } & JobRowDetails = { link: (cells.link ?? '').slice(0, JOB_ROW_CELL_READ_CHARS).trim() };
  for (const field of ['company', 'title', 'rate', 'location'] as const) {
    const value = rowLineOf(field, cells[field] ?? '');
    if (value) out[field] = value;
  }
  const description = descriptionToText(cells.description ?? '');
  if (description) out.description = description;
  return out;
}

/** Whether a row can become a job of its own when its link cannot be read (H2.3): a title and a company. */
export function rowHasTitleAndCompany(details: JobRowDetails | null | undefined): boolean {
  return Boolean(details?.title?.trim() && details.company?.trim());
}

// ------------------------------------------------------------------------------------------------- the results

/** What each row of an import came to (H2, H5). */
export const JOB_IMPORT_ROW_RESULTS = [
  /** Waiting for TailorIT's read (queued), or being read. */
  'queued',
  'working',
  /** TailorIT read it: a new job, published or held for approval. */
  'added',
  /** An admin import of a job TailorIT had: reposted (H5). */
  'reposted',
  /** Already in TailorIT (a person's import: saved to their tracker; or waiting for review already). */
  'known',
  /** An admin import TailorIT could not read: a job from the row waits in Review › Couldn't verify. */
  'review',
  /** A person's import TailorIT could not read: their own job from the row, waiting for review. */
  'added_private',
  /** TailorIT could not read it and the row has no title or company: nothing kept. */
  'needs_details',
  /** The posting has closed: not added. */
  'closed',
  /** Not imported (a link that is no job link, a site TailorIT never reads, over the day's rows). */
  'failed',
  /** The same link (or the same job) as an earlier row of the import. */
  'repeated',
] as const;
export type JobImportRowResult = (typeof JOB_IMPORT_ROW_RESULTS)[number];

/** The words of each result, as a row and a count show them. */
export const JOB_IMPORT_ROW_RESULT_LABEL: Record<JobImportRowResult, string> = {
  queued: 'Waiting',
  working: 'Reading',
  added: 'Added',
  reposted: 'Reposted',
  known: 'Already in TailorIT',
  review: 'To review',
  added_private: 'Added for you; waiting for review',
  needs_details: 'Needs a title and company',
  closed: 'Closed',
  failed: "Couldn't import",
  repeated: 'Repeats an earlier row',
};

/** Why a row came to its result, beside the read's reasons: waiting for review already, over the day's rows, no link. */
export const JOB_IMPORT_ROW_REASONS = [...JOB_VERIFY_REASONS, 'waiting_review', 'day_limit', 'no_link'] as const;
export type JobImportRowReason = (typeof JOB_IMPORT_ROW_REASONS)[number];

export const JobImportCountsSchema = z.object({
  rows: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  reposted: z.number().int().nonnegative(),
  known: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  addedPrivate: z.number().int().nonnegative(),
  needsDetails: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  repeated: z.number().int().nonnegative(),
});
export type JobImportCounts = z.infer<typeof JobImportCountsSchema>;

/** Counts of nothing. */
export function emptyJobImportCounts(): JobImportCounts {
  return { rows: 0, queued: 0, added: 0, reposted: 0, known: 0, review: 0, addedPrivate: 0, needsDetails: 0, closed: 0, failed: 0, repeated: 0 };
}

/** The count a result adds to (queued and working are both "queued"). */
export const JOB_IMPORT_COUNT_OF: Record<JobImportRowResult, Exclude<keyof JobImportCounts, 'rows'>> = {
  queued: 'queued',
  working: 'queued',
  added: 'added',
  reposted: 'reposted',
  known: 'known',
  review: 'review',
  added_private: 'addedPrivate',
  needs_details: 'needsDetails',
  closed: 'closed',
  failed: 'failed',
  repeated: 'repeated',
};

/** One row's result. */
export const JobImportRowOutcomeSchema = z.object({
  /** The row as the file or the sheet numbers it (a spreadsheet's row; a JSON item's place; a pasted line). */
  row: z.number().int().positive(),
  /** The link in its canonical form; null when the row had none TailorIT could use. */
  link: z.string().nullable(),
  result: z.enum(JOB_IMPORT_ROW_RESULTS),
  reason: z.enum(JOB_IMPORT_ROW_REASONS).nullable(),
  /** `repeated`: the earlier row. */
  repeatsRow: z.number().int().positive().nullable(),
  /** The job it added, found or made (absent when none, or one the viewer may not open). */
  jobId: z.number().int().nullable(),
  /**
   * v35 FIX-STORE (the ux review's M4): where its job waits for an admin's review now, read from the reviews (not the
   * result): `unverified`, a listed note in Review › Couldn't verify; `new_job`, a pending review in Review › New jobs (a
   * held read, or one a re-import reopened); null, it waits for none.
   */
  heldIn: z.enum(['unverified', 'new_job']).nullable(),
  /** The row's own title and company (as given), to name it. */
  title: z.string().nullable(),
  company: z.string().nullable(),
  /** The result in words (and the reason, when there is one). */
  message: z.string(),
});
export type JobImportRowOutcome = z.infer<typeof JobImportRowOutcomeSchema>;

export const JOB_IMPORT_WAYS = ['link', 'paste', 'file', 'sheet'] as const;
export type JobImportWay = (typeof JOB_IMPORT_WAYS)[number];

/** Where a Google Sheet import read its rows (its "Import again" reads the tab again). */
export const JobImportSheetRefSchema = z.object({
  url: z.string(),
  spreadsheetId: z.string(),
  gid: z.number().int().nonnegative(),
  headerRow: z.number().int().positive(),
  spreadsheetTitle: z.string(),
  tabTitle: z.string(),
});
export type JobImportSheetRef = z.infer<typeof JobImportSheetRefSchema>;

/** One import, as Recent imports and the progress list it. */
export const JobImportSummarySchema = z.object({
  id: z.number().int(),
  /** An admin's import: its run on Runs (GET /api/admin/imports/:runId). Null for a person's import. */
  runId: z.number().int().nullable(),
  way: z.enum(JOB_IMPORT_WAYS),
  /** The file, the sheet's tab, "1 link" or "24 pasted links". */
  name: z.string(),
  /** Who started it (an admin's import: their name or address; absent for a person's own). */
  startedBy: z.string().nullable(),
  createdAt: IsoDateTime,
  /** Null while rows wait for TailorIT's read. */
  finishedAt: IsoDateTime.nullable(),
  counts: JobImportCountsSchema,
  /** A Google Sheet import's tab (Import again). */
  sheet: JobImportSheetRefSchema.nullable(),
  /** The mapping it used (Import again reuses it). */
  mapping: z.record(z.enum(JOB_ROW_FIELDS), z.string().nullable()).nullable(),
});
export type JobImportSummary = z.infer<typeof JobImportSummarySchema>;

/**
 * GET /api/admin/imports/:runId and GET /api/jobs/imports/:id: the import and a page of its rows. v35 FIX-STORE (the
 * final review's S4): no "Download these rows" rows (`counts.needsDetails` says how many); the CSV is its own route,
 * GET .../needs-details.csv (text/csv, escaped cells, at most JOB_IMPORT_DOWNLOAD_MAX_MB).
 */
export const JobImportDetailSchema = JobImportSummarySchema.extend({
  rows: z.array(JobImportRowOutcomeSchema),
  /** The next page's cursor (the last row's number), or null. */
  nextCursor: z.string().nullable(),
});
export type JobImportDetail = z.infer<typeof JobImportDetailSchema>;

/** GET /api/admin/imports: Recent imports, newest first. v35 FIX-STORE: GET /api/jobs/imports/recent?limit= too (a profile's). */
export const JobImportListSchema = z.object({ items: z.array(JobImportSummarySchema), nextCursor: z.string().nullable() });
export type JobImportList = z.infer<typeof JobImportListSchema>;

// ------------------------------------------------------------------------------------------------- the requests

/** A mapping as a request sends it: any field, each a column name or null. */
export const JobRowMappingInputSchema = z.partialRecord(z.enum(JOB_ROW_FIELDS), z.string().max(300).nullable());
export type JobRowMappingInput = z.infer<typeof JobRowMappingInputSchema>;

/** POST /api/admin/imports/link: one link with its optional fields. */
export const AdminImportLinkBodySchema = JobImportRowSchema;
export type AdminImportLinkBody = z.infer<typeof AdminImportLinkBodySchema>;

/** POST /api/admin/imports/paste(/preview): links one a line, or rows copied from a spreadsheet (tab-separated). */
export const AdminImportPasteBodySchema = z.object({
  text: z.string().min(1, 'Paste at least one link.').max(JOB_IMPORT_PASTE_MAX_CHARS, 'That is more text than one import takes.'),
  mapping: JobRowMappingInputSchema.optional(),
  /** Whether the first line names the columns; guessed when absent (H1's no-header rule). */
  hasHeader: z.boolean().optional(),
});
export type AdminImportPasteBody = z.infer<typeof AdminImportPasteBodySchema>;

/**
 * A file import as JSON (scripts and tests; the web sends multipart `file` with the same fields as form values, the
 * mapping as JSON text): its name, and its text, or its bytes in base64 for an .xlsx.
 */
export const JobImportFileJsonBodySchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  content: z.string().min(1, 'The file is empty.').optional(),
  contentBase64: z.string().min(1, 'The file is empty.').optional(),
  mapping: JobRowMappingInputSchema.optional(),
  hasHeader: z.boolean().optional(),
  /** An .xlsx file's sheet to read (its name); the first when absent. */
  sheet: z.string().max(200).optional(),
});
export type JobImportFileJsonBody = z.infer<typeof JobImportFileJsonBodySchema>;

/** POST .../sheet(/preview): a Google Sheet's tab, shared with TailorIT's reader account. */
export const JobImportSheetBodySchema = z.object({
  url: z.string().trim().min(1, 'Paste the link of the Google Sheet.').max(2000, 'That link is too long.'),
  gid: z.number().int().min(0).max(2_147_483_647).optional(),
  headerRow: z.number().int().min(1).max(20).optional(),
  mapping: JobRowMappingInputSchema.optional(),
  hasHeader: z.boolean().optional(),
  /** Preview only: reuse the last read of this tab (a new mapping or header row). */
  refresh: z.boolean().optional(),
});
export type JobImportSheetBody = z.infer<typeof JobImportSheetBodySchema>;

/** One previewed row: the row's number, its fields as mapped (cells cut to JOB_IMPORT_PREVIEW_CELL_CHARS), its problem. */
export const JobImportPreviewRowSchema = z.object({
  row: z.number().int().positive(),
  link: z.string(),
  company: z.string(),
  title: z.string(),
  description: z.string(),
  rate: z.string(),
  location: z.string(),
  /** Why this row will not be read (no link, a link that is no web address, a repeat), or null. */
  problem: z.string().nullable(),
});
export type JobImportPreviewRow = z.infer<typeof JobImportPreviewRowSchema>;

/** Every preview route's answer: the guessed (or chosen) mapping and the first rows. Nothing is saved. */
export const JobImportPreviewSchema = z.object({
  /** The file's name, the sheet's tab, or "Pasted links". */
  name: z.string(),
  format: z.enum(['paste', 'csv', 'tsv', 'json', 'xlsx', 'sheet']),
  /** Whether the first row names the columns (H1's rule, or as asked). */
  hasHeader: z.boolean(),
  columns: z.array(z.string()),
  mapping: z.record(z.enum(JOB_ROW_FIELDS), z.string().nullable()),
  /** The raw cells of the first rows, by column (each cut to JOB_IMPORT_PREVIEW_CELL_CHARS). */
  sample: z.array(z.record(z.string(), z.string())),
  /** The first JOB_IMPORT_PREVIEW_ROWS rows as mapped. */
  rows: z.array(JobImportPreviewRowSchema),
  /** Rows below the header (blank rows not counted). */
  rowCount: z.number().int().nonnegative(),
  /** Rows with a link TailorIT can read. */
  linkCount: z.number().int().nonnegative(),
  /** The most rows this import takes (ADMIN_ADD_LINKS_MAX, SHEET_MAX_ROWS, JOB_IMPORT_ROWS_MAX). */
  maxRows: z.number().int().positive(),
  /** An .xlsx file's sheets, and the one read. */
  sheets: z.array(z.string()).optional(),
  sheet: z.string().optional(),
  /** Why rows will be skipped, naming each (the first 20). */
  problems: z.array(z.string()),
  /** No column is the link. */
  missingLink: z.boolean(),
  /** A person's preview: the rows they may still import today (null: no limit); absent for an admin's. */
  rowsLeftToday: z.number().int().nonnegative().nullable().optional(),
  /**
   * v35 IMPORTWEB: a Google Sheet preview's spreadsheet (absent for any other way): its title, the tab read (its address
   * and gid) and every tab, hidden ones marked, in the sheet's order (the tab choice sends a tab's gid).
   */
  spreadsheet: z
    .object({
      title: z.string(),
      url: z.string(),
      gid: z.number().int().nonnegative(),
      tabs: z.array(z.object({ gid: z.number().int().nonnegative(), title: z.string(), hidden: z.boolean() })),
    })
    .optional(),
});
export type JobImportPreview = z.infer<typeof JobImportPreviewSchema>;

/**
 * v35 IMPORTWEB: the `result` filter of an import's rows (GET /api/admin/imports/:runId and GET /api/jobs/imports/:id,
 * `?result=added,added_private`): the results asked for, in the contract's order; unknown names dropped. Empty: every row.
 */
export function importRowResultsOf(value: unknown): JobImportRowResult[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const asked = new Set(value.slice(0, 300).split(',').map((part) => part.trim()));
  return JOB_IMPORT_ROW_RESULTS.filter((result) => asked.has(result));
}

/** POST of an import (each way): the import started (its rows wait for TailorIT's read), and the person's room left. */
export const JobImportStartedSchema = z.object({
  import: JobImportSummarySchema,
  /** A person's import: rows they may still import today (null: no limit). */
  rowsLeftToday: z.number().int().nonnegative().nullable(),
  /** A person's import whose rows went over the day's room: when the room comes back. */
  retryAt: IsoDateTime.nullable(),
});
export type JobImportStarted = z.infer<typeof JobImportStartedSchema>;

// --------------------------------------------------------------------------------- "Download these rows" (CSV)

/**
 * A cell as a spreadsheet must never read it as a formula (CSV injection): text starting with =, +, -, @, a tab or a
 * carriage return is preceded by an apostrophe. v35 FIX-PARSE (sec S5): so is text holding one of them after a ";"
 * (a spreadsheet whose list separator is ";" would start a cell there if the cell were not quoted).
 */
export function csvSafeCell(value: string): string {
  return /^[=+\-@\t\r]|;[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * A CSV text (RFC 4180, CRLF) of columns and rows. Cells are used as given. v35 FIX-PARSE (sec S5): every cell is
 * quoted, so a spreadsheet splits no cell whatever its list separator ("," or ";").
 */
export function toCsvText(columns: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const quote = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  return [columns, ...rows].map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

/** The columns of "Download these rows", in H1's order with their header names (an import reads them back). */
export const JOB_IMPORT_DOWNLOAD_COLUMNS: readonly string[] = ['Link', 'Company', 'Title', 'Description', 'Rate', 'Location'];

/** GET .../sheet/account: whether this server reads Google Sheets, and the address to share a sheet with (Viewer). */
export const JobImportSheetAccountSchema = z.object({ configured: z.boolean(), clientEmail: z.string().nullable() });
export type JobImportSheetAccount = z.infer<typeof JobImportSheetAccountSchema>;

/** An admin's import started (each way): its run on Runs and the import (its rows wait for TailorIT's read). */
export const AdminImportStartedSchema = z.object({ runId: z.number().int(), import: JobImportSummarySchema });
export type AdminImportStarted = z.infer<typeof AdminImportStartedSchema>;
