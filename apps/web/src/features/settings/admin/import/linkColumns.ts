import type { ImportField, ImportMapping, ImportPreview } from '../types';

// v31 ADMINWEB: an import is a list of links (docs/design/v3.1/21-jobs-from-links.md §5, LINK2): TailorIT reads each
// posting from its link, so the link column is the one an admin chooses and every other column is ignored. The fields
// shown are the ones the server says a row needs (`fields[].required`: the link, and on a server before LINK2 also the
// title and company, which only name a row in a message). Pure, so the tests read it without a page.

/** The fields whose column the admin chooses: the ones a row needs, the link first. */
export function chosenFields(preview: Pick<ImportPreview, 'fields'>): ImportPreview['fields'] {
  const needed = preview.fields.filter((field) => field.required || field.field === 'url');
  return [...needed.filter((field) => field.field === 'url'), ...needed.filter((field) => field.field !== 'url')];
}

/** The columns TailorIT does not read: every column no chosen field names. */
export function ignoredColumns(preview: Pick<ImportPreview, 'columns' | 'fields'>, mapping: ImportMapping): string[] {
  const used = new Set(chosenFields(preview).map((field) => mapping[field.field]).filter((column): column is string => Boolean(column)));
  return preview.columns.filter((column) => !used.has(column));
}

/** The chosen fields with no column yet ("job link"), in words for the warning. */
export function missingFields(preview: Pick<ImportPreview, 'fields'>, mapping: ImportMapping): string[] {
  return chosenFields(preview)
    .filter((field) => field.required && !mapping[field.field as ImportField])
    .map((field) => field.label.toLowerCase());
}

/** "2 rows, 2 links to read (CSV)". */
export function linkCountText(preview: Pick<ImportPreview, 'rowCount' | 'jobCount'>, countLabel: string): string {
  const rows = `${preview.rowCount.toLocaleString('en-US')} ${preview.rowCount === 1 ? 'row' : 'rows'}`;
  const links = `${preview.jobCount.toLocaleString('en-US')} ${preview.jobCount === 1 ? 'link' : 'links'}`;
  return `${rows}, ${links} to read (${countLabel})`;
}

/** The sentence under the ignored columns (an import answer's own words, MSG_JOB_IMPORT_ONLY_LINKS, replace it). */
export function ignoredText(count: number): string {
  if (count === 0) return 'TailorIT reads each posting from its link.';
  return `TailorIT reads each posting from its link, so ${count === 1 ? 'this column is' : `these ${count} columns are`} ignored.`;
}
