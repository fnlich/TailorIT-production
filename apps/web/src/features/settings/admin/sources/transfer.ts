import { JOB_SOURCE_TERMS_LABEL, type AdminSourcesImportEntry, type AdminSourcesImportOutcome, type AdminSourcesImportResult } from '@tailorit/shared/sourcing';
import type { BadgeTone } from '@/components/ui/Badge';
import type { FileChooserAccept } from '../../../imports/FileChooser';
import { counted, type BulkProblem } from './bulk';

// v37 TRANSFER (SP v37 PLAN T1, T2): Admin › Sources' sources file in words: what Import's preview says of each entry,
// the outcome above the table once a file is imported, and Export's toast. Pure, so the web tests read them.

/** The file Import takes: a .json sources file Export saved. */
export const SOURCES_FILE: FileChooserAccept = {
  endings: ['.json'],
  accept: '.json,application/json',
  typesText: 'JSON',
  label: 'Sources file',
  help: "A file saved by Export in Admin › Sources: each source's kind, name and board settings.",
  holds: 'sources',
};

/** Each outcome of an entry, as the preview's filter and its rows name it. */
export const IMPORT_OUTCOME_LABEL: Record<AdminSourcesImportOutcome, string> = {
  new: 'New',
  exists: 'Already there',
  renamed: 'Renamed',
  invalid: 'Not valid',
};

export const IMPORT_OUTCOME_TONE: Record<AdminSourcesImportOutcome, BadgeTone> = {
  new: 'success',
  exists: 'neutral',
  renamed: 'warning',
  invalid: 'destructive',
};

/** How many sources the file adds (its new and renamed entries). */
export const importAdds = (result: Pick<AdminSourcesImportResult, 'counts'>) => result.counts.new + result.counts.renamed;

/** "5 new, 3 already there, 1 renamed, 2 not valid" (the outcomes it has). */
export function importCountsText(result: Pick<AdminSourcesImportResult, 'counts'>): string {
  const parts = (['new', 'exists', 'renamed', 'invalid'] as const)
    .filter((outcome) => result.counts[outcome] > 0)
    .map((outcome) => `${result.counts[outcome].toLocaleString('en-US')} ${IMPORT_OUTCOME_LABEL[outcome].toLowerCase()}`);
  return parts.length > 0 ? parts.join(', ') : 'No sources in this file';
}

/** What happens to one entry, under its name: the name it gets, the source that has its board, or why it is skipped. */
export function entryDetail(entry: AdminSourcesImportEntry): string | null {
  switch (entry.outcome) {
    case 'new':
      return entry.sourceName && entry.sourceName !== entry.name ? `Added as "${entry.sourceName}".` : null;
    case 'renamed':
      return `Added as "${entry.sourceName ?? entry.name}": another source has its name.`;
    case 'exists':
      return [`Already a source: "${entry.sourceName ?? entry.name}".`, entry.reason].filter(Boolean).join(' ');
    case 'invalid':
      return entry.reason ?? 'TailorIT cannot read this entry.';
  }
}

/**
 * v37 FIX-37B (SP v37 FIXES-37 E3): the terms a new source of the entry gets, as the preview shows them: "Terms: Forbidden,
 * from the file" (a file's terms are kept as written), or its kind's record ("Terms: Allowed with conditions"); null for
 * an entry that makes no source (already there, not valid).
 */
export function entryTerms(entry: Pick<AdminSourcesImportEntry, 'terms'>): string | null {
  if (!entry.terms) return null;
  const label = JOB_SOURCE_TERMS_LABEL[entry.terms.status];
  return entry.terms.fromFile ? `Terms: ${label}, from the file` : `Terms: ${label}`;
}

/**
 * v37 FIX-37B (E4): Export's "?": what a file holds and never holds. Terms notes go word for word (an admin's own words:
 * read them before sharing a file).
 */
export const EXPORT_TIP =
  "Saves the sources the search and filters show: each one's kind, name, board settings, company, priority and terms, " +
  'with their notes word for word. Never ids, on or off, or runs.';

/** An entry's name in the preview ("Entry 17" when it has none). */
export const entryName = (entry: Pick<AdminSourcesImportEntry, 'index' | 'name'>) => entry.name || `Entry ${entry.index}`;

/**
 * What an import did, for the notice above the table: the sources it added (off, waiting for an admin), those there
 * already, renamed and not valid, and the notice's tone.
 */
export function importSummary(result: Pick<AdminSourcesImportResult, 'counts'>): {
  title: string;
  description: string | null;
  tone: 'success' | 'warning' | 'error';
} {
  const added = importAdds(result);
  const { exists, renamed, invalid } = result.counts;
  const rest = [
    exists > 0 ? `${exists.toLocaleString('en-US')} already there (left as ${exists === 1 ? 'it was' : 'they were'})` : '',
    renamed > 0 ? `${renamed.toLocaleString('en-US')} renamed` : '',
    invalid > 0 ? `${invalid.toLocaleString('en-US')} not valid` : '',
  ].filter(Boolean);
  const restText = rest.length > 0 ? `${rest.join(', ')}${invalid > 0 ? ':' : '.'}` : '';
  const description = [added > 0 ? 'Each is off and waits for an admin: turn on the ones you want.' : '', restText ? restText.charAt(0).toUpperCase() + restText.slice(1) : '']
    .filter(Boolean)
    .join(' ');
  return {
    title: added > 0 ? `${counted(added, 'source', 'sources')} imported` : 'No source imported',
    description: description || null,
    tone: invalid > 0 ? (added > 0 || exists > 0 ? 'warning' : 'error') : 'success',
  };
}

/** The entries an import skipped as not valid, for the notice's list (by their place in the file). */
export function importProblems(result: Pick<AdminSourcesImportResult, 'entries'>): BulkProblem[] {
  return result.entries
    .filter((entry) => entry.outcome === 'invalid')
    .map((entry) => ({
      id: `entry-${entry.index}`,
      name: entry.name ? `Entry ${entry.index} (${entry.name})` : `Entry ${entry.index}`,
      outcome: 'skipped' as const,
      message: entry.reason ?? 'TailorIT cannot read this entry.',
    }));
}

/** Export's toast: how many sources the file holds, and those shown that a file never holds. */
export function exportSavedText(file: { fileName: string; count: number; leftOut: number }): string {
  const saved = `${counted(file.count, 'source', 'sources')} saved to ${file.fileName}.`;
  if (file.leftOut <= 0) return saved;
  const be = file.leftOut === 1 ? 'was' : 'were';
  return `${saved} ${counted(file.leftOut, 'source', 'sources')} of a kind a file doesn't hold (the lake, the demo jobs, single postings) ${be} left out.`;
}
