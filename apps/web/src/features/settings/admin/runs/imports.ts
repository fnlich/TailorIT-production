import type { JobImportCounts } from '@tailorit/shared/ingest';
import type { AdminRunSource, AdminRunSources, AdminSourceAllAction, JobSourceKind, JobSourceRun } from '@tailorit/shared/sourcing';
import { countParts } from '../../../imports/results'; // v35 FIX-WEB (L2): the results' one rule
import { counted } from '../sources/bulk';
import { FILTER_KINDS } from '../sources/filters';

// v35 OPSWEB (PLAN H6): an admin's import on Admin › Runs. Every import (one link, pasted links, a file, a sheet) is one
// run: "Import · <name>", who started it and its counts (IMPORT's import_summary through ADMIN's `importOf`); opened, its
// counts, "Open results" (Admin › Import's results of the run) and the board sources its links named (Sources found),
// the ones it made switched off with Enable all / Disable all. Pure, so the web tests read it without a page.

/** A run that is an import (its source an import record): ADMIN's `importOf` names it. */
export function isImportRun(run: Pick<JobSourceRun, 'importOf'>): boolean {
  return Boolean(run.importOf);
}

/** The import's name: the file, the sheet's tab, "1 link" or "24 pasted links" (older runs: their file or sheet). */
export function importRunName(run: Pick<JobSourceRun, 'importOf' | 'sourceName'>): string {
  const of = run.importOf;
  if (!of) return run.sourceName;
  if (of.import?.name) return of.import.name;
  if (of.sheet) return `${of.sheet.spreadsheetTitle}, tab ${of.sheet.tabTitle}`;
  if (of.fileName) return of.fileName;
  return of.way === 'pasted' ? 'Pasted links' : run.sourceName;
}

/** "Import · jobs.csv". */
export function importRunLabel(run: Pick<JobSourceRun, 'importOf' | 'sourceName'>): string {
  return `Import · ${importRunName(run)}`;
}

/** "Started by ana@example.com"; null when the server does not know (an import through a v3.4 route). */
export function startedByText(run: Pick<JobSourceRun, 'importOf'>): string | null {
  const by = run.importOf?.import?.startedBy;
  return by ? `Started by ${by}` : null;
}

/**
 * The counts, the zero ones left out: [{ key, count, text }] ("12 added", "3 reposted"). v35 FIX-WEB (the ux review's
 * L2): the results' own parts (features/imports/results.ts countParts), so an import counts its rows one way on the
 * results, Recent imports and Runs: a repeated row is one of "couldn't import".
 */
export function importCountParts(counts: JobImportCounts): Array<{ key: string; count: number; text: string }> {
  return countParts(counts);
}

/**
 * The run's counts line: "24 rows" and "12 added · 3 reposted · 2 to review"; while TailorIT still reads its rows (no
 * counts yet), "Reading 24 rows".
 */
export function importRunCounts(run: Pick<JobSourceRun, 'importOf' | 'fetched'>): { rowCount: number; rows: string; line: string } {
  const summary = run.importOf?.import;
  const rowCount = summary?.rows ?? run.fetched;
  const rows = counted(rowCount, 'row', 'rows');
  if (!summary) return { rowCount, rows, line: 'Imported links' };
  if (!summary.counts) return { rowCount, rows, line: `Reading ${rows}` };
  const parts = importCountParts(summary.counts);
  return { rowCount, rows, line: parts.length ? parts.map((part) => part.text).join(' · ') : 'No rows read' };
}

/** Whether a shown import run still waits for its counts (Runs asks again until they come). */
export function importRunReading(run: Pick<JobSourceRun, 'importOf'>): boolean {
  const summary = run.importOf?.import;
  return Boolean(summary && summary.counts === null);
}

// The Kind filter of Runs: the source kinds Sources offers, and "Imports" (an import's records: csv and json).

/** A Kind filter value of Runs: a source's kind, or every import. */
export type RunKindFilter = (typeof FILTER_KINDS)[number] | 'import';
export const RUN_KIND_FILTERS: readonly RunKindFilter[] = [...FILTER_KINDS, 'import'];

/** The kinds the runs history asks for: "Imports" is the import records' kinds. */
export function runKindsQuery(kinds: readonly RunKindFilter[]): JobSourceKind[] {
  return [...new Set(kinds.flatMap((kind): JobSourceKind[] => (kind === 'import' ? ['csv', 'json'] : [kind])))];
}

// v35 INT-B (SP v35 build/WAVE2-LINKS.md): Runs opened on one import's run (`?tab=runs&run=<runId>`, Import results'
// "See it on Runs"): the runs of its record, that run opened, the chip naming the import (an import is no source).

/** The record Runs lists: the address's `source`, else the record of the run the address names (once read). */
export function runsListSource(sourceId: number | null, namedRun: number | null, namedRunSourceId: number | null | undefined): number | null {
  if (sourceId !== null) return sourceId;
  return namedRun !== null && namedRunSourceId ? namedRunSourceId : null;
}

/**
 * The record an import's run belongs to, named for every run it holds: a file's or a sheet's tab (Import again adds
 * runs to it), or "pasted links" (one record for every one-link and pasted import).
 */
export function importRecordName(run: Pick<JobSourceRun, 'importOf' | 'sourceName'>): string {
  const of = run.importOf;
  if (!of) return run.sourceName;
  if (of.sheet) return `${of.sheet.spreadsheetTitle}, tab ${of.sheet.tabTitle}`;
  if (of.fileName) return of.fileName;
  return of.way === 'pasted' ? 'pasted links' : run.sourceName;
}

/**
 * The chip of the listed record: "Import: pasted links" for an import's record (v35 FIX-WEB, the ux review's L7: it
 * names the record its runs share, not one import of it), else "Source: Acme Greenhouse".
 */
export function runsSourceChip(name: string, run: Pick<JobSourceRun, 'importOf' | 'sourceName'> | undefined): string {
  return run && isImportRun(run) ? `Import: ${importRecordName(run)}` : `Source: ${name}`;
}

/**
 * v35 FIX-WEB (the ux review's L7): Runs opened on one import (`?run=`, Import results' "See it on Runs", no `source=`)
 * lists that run alone, its chip naming the import ("Import: 3 pasted links"); "Every run of …" lists its record's.
 */
export function onlyNamedRun(sourceId: number | null, namedRun: number | null, named: Pick<JobSourceRun, 'id' | 'importOf'> | undefined): boolean {
  return sourceId === null && namedRun !== null && named !== undefined && named.id === namedRun && isImportRun(named);
}

/** The chip of one import's run alone ("Import: 3 pasted links"). */
export function namedRunChip(run: Pick<JobSourceRun, 'importOf' | 'sourceName'>): string {
  return `Import: ${importRunName(run)}`;
}

/** The way from one import's run to every run of its record ("Every run of pasted links"). */
export function recordRunsLabel(run: Pick<JobSourceRun, 'importOf' | 'sourceName'>): string {
  return `Every run of ${importRecordName(run)}`;
}

/**
 * v35 FIX-WEB (the ux review's L3): an import's run while TailorIT reads its rows: its record run reads "succeeded" at
 * once (the import wrote it), so Runs says "Reading" until the counts come; Took and Requests mean nothing for an
 * import ("-").
 */
export const IMPORT_READING_LABEL = 'Reading';

// Sources found ----------------------------------------------------------------------------------------------------

/** A found source's state in a word: on, off, or waiting (on, but it cannot run now). */
export function foundSourceState(source: Pick<AdminRunSource, 'enabled' | 'waiting' | 'pausedAt'>): 'On' | 'Off' | 'Waiting' | 'Paused' {
  if (source.pausedAt) return 'Paused';
  if (!source.enabled) return 'Off';
  return source.waiting ? 'Waiting' : 'On';
}

/** "3 found · 2 made by this import, 1 on". */
export function sourcesFoundLine(found: Pick<AdminRunSources, 'total' | 'created' | 'createdEnabled'>): string {
  if (found.total === 0) return 'None';
  const made = found.created > 0 ? ` · ${found.created.toLocaleString('en-US')} made by this import, ${found.createdEnabled.toLocaleString('en-US')} on` : '';
  return `${found.total.toLocaleString('en-US')} found${made}`;
}

/** The confirm of the run's Enable all / Disable all: the sources this import made, and how many it changes. */
export function runSourcesConfirm(
  action: AdminSourceAllAction,
  found: Pick<AdminRunSources, 'created' | 'createdEnabled'>,
): { title: string; description: string; confirm: string; changes: number } {
  const changes = action === 'enable' ? found.created - found.createdEnabled : found.createdEnabled;
  const verb = action === 'enable' ? 'Enable' : 'Disable';
  return {
    title: `${verb} ${counted(changes, 'source', 'sources')} this import found?`,
    description:
      action === 'enable'
        ? 'They run on their schedule from now on. Sources that were there before the import stay as they are.'
        : 'They stop running until an admin turns them on again. Sources that were there before the import stay as they are.',
    confirm: `${verb} ${counted(changes, 'source', 'sources')}`,
    changes,
  };
}
