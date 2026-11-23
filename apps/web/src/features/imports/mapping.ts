import {
  JOB_ROW_FIELDS,
  guessJobRowMapping,
  type JobImportPreview,
  type JobRowField,
  type JobRowMapping,
} from '@tailorit/shared';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1; PLAN H1): the mapping preview's rules, apart from the components so
// the tests read them. A preview names each field's column (the API's guess, or the person's choice); the screen asks
// the other way round, one select above each column (Link, Company, Title, Description, Rate, Location, Not used). The
// file choice's rules (the types an import reads, the size limit) are here too. Pure: no React, no network.

/** What a column is used as: one of the row's fields, or nothing. */
export type ColumnUse = JobRowField | 'none';

/** The select's options above each column, in H1's order. */
export const COLUMN_USES: readonly ColumnUse[] = [...JOB_ROW_FIELDS, 'none'];

export const COLUMN_USE_LABEL: Record<ColumnUse, string> = {
  link: 'Link',
  company: 'Company',
  title: 'Title',
  description: 'Description',
  rate: 'Rate',
  location: 'Location',
  none: 'Not used',
};

/** What `column` is used as in `mapping`. */
export function columnUseOf(mapping: Partial<JobRowMapping>, column: string): ColumnUse {
  return JOB_ROW_FIELDS.find((field) => mapping[field] === column) ?? 'none';
}

/**
 * The mapping with `column` used as `use`: a field moves to it from any other column (each field reads one column), and
 * the field it was used as before has no column. `none` leaves the column unused.
 */
export function withColumnUse(mapping: Partial<JobRowMapping>, column: string, use: ColumnUse): JobRowMapping {
  const next = Object.fromEntries(JOB_ROW_FIELDS.map((field) => [field, mapping[field] ?? null])) as JobRowMapping;
  for (const field of JOB_ROW_FIELDS) if (next[field] === column) next[field] = null;
  if (use !== 'none') next[use] = column;
  return next;
}

/** Whether a column is the link (Import stays off until one is). */
export const hasLinkColumn = (mapping: Partial<JobRowMapping> | null | undefined): boolean => Boolean(mapping?.link);

/**
 * Whether the API was unsure the first row names the columns, so "First row is a header" is offered as a switch: a
 * header none of whose names TailorIT knows (the first row may be a row), or no header and several columns (their
 * fields were read from the column order, H1's rule for a table with no header). One column of links without a header
 * is sure.
 */
export function headerUnsure(preview: Pick<JobImportPreview, 'hasHeader' | 'columns'>): boolean {
  if (!preview.hasHeader) return preview.columns.length > 1;
  return !Object.values(guessJobRowMapping(preview.columns)).some(Boolean);
}

/** The count line over the preview: "24 rows, 22 links to read". */
export function previewCountText(preview: Pick<JobImportPreview, 'rowCount' | 'linkCount'>): string {
  const rows = `${preview.rowCount.toLocaleString('en-US')} ${preview.rowCount === 1 ? 'row' : 'rows'}`;
  const links = `${preview.linkCount.toLocaleString('en-US')} ${preview.linkCount === 1 ? 'link' : 'links'}`;
  return `${rows}, ${links} to read`;
}

/** The Import button's words: "Import 24 rows". */
export const importRowsText = (rows: number): string => `Import ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`;

// ------------------------------------------------------------------------------------------------- the file

/** The file types an import reads (H1). */
export const IMPORT_FILE_TYPES = ['.csv', '.tsv', '.txt', '.json', '.xlsx'] as const;

/** The file input's `accept`: the types by their endings and their media types. */
export const IMPORT_FILE_ACCEPT = [
  ...IMPORT_FILE_TYPES,
  'text/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

/** "CSV, TSV, TXT, JSON or XLSX". */
export const IMPORT_FILE_TYPES_TEXT = 'CSV, TSV, TXT, JSON or XLSX';

/** Why a file is refused before it is sent: not a type an import reads, over the upload limit, or empty; null when fine. */
export type FileProblem = 'type' | 'size' | 'empty';

export function fileProblem(file: Pick<File, 'name' | 'size'>, maxMb: number): FileProblem | null {
  const name = file.name.toLowerCase();
  if (!IMPORT_FILE_TYPES.some((ending) => name.endsWith(ending))) return 'type';
  if (file.size === 0) return 'empty';
  if (file.size > maxMb * 1024 * 1024) return 'size';
  return null;
}

/** A refused file's sentence, with what to do (the size's words are MSG_FILE_TOO_LARGE's, given as `tooLarge`). */
export function fileProblemText(problem: FileProblem, file: Pick<File, 'name'>, tooLarge: string): string {
  if (problem === 'size') return tooLarge;
  if (problem === 'empty') return `${file.name} is empty: choose a file with a row for each job.`;
  return `TailorIT can't read ${file.name}: choose a ${IMPORT_FILE_TYPES_TEXT} file, or save it as one.`;
}

/** "12 KB" (at least 1 KB), "2.4 MB". */
export function fileSizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
