import { adminSearch } from '../sources/links';

// v35 IMPORTWEB (SP v35 build/WAVE2-LINKS.md, OPSWEB's list; INT-B resolves any mismatch): the Admin page addresses
// Admin › Import reads and links to. Each key is read by the tab it opens.
//   ?tab=import&run=<runId>                     one import's results (Runs' "Open results", Recent imports' Open)
//   ?tab=review&lane=unverified&run=<runId>     Review › Couldn't verify, filtered to that import
//   ?tab=runs&run=<runId>                       Runs, on that import's run (v35 INT-B: was ?tab=runs, newest first)
// v35 INT-B: each is written by sources/links.ts' adminSearch, the one builder of the admin tabs' addresses.

/** v35 FIX-WEB (decision 7): Admin › Import's ways in, and the one an address names (`mode=`; One link when none). */
export const IMPORT_MODES = ['link', 'many', 'file', 'sheet'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];
export function modeOfSearch(value: string | null): ImportMode {
  return (IMPORT_MODES as readonly string[]).includes(value ?? '') ? (value as ImportMode) : 'link';
}

/** Admin › Import on one way in (One link: no `mode`). */
export function importModeSearch(mode: ImportMode): string {
  return adminSearch({ tab: 'import', mode: mode === 'link' ? null : mode });
}

/** The `run` an address names (a positive whole number), or null. */
export function runOfSearch(value: string | null): number | null {
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  const run = Number(value);
  return Number.isSafeInteger(run) && run > 0 ? run : null;
}

/** Admin › Import, on one import's results when `runId` is given (v35 FIX-WEB: the way in kept, for New import). */
export function importSearch(runId: number | null, mode: ImportMode = 'link'): string {
  return adminSearch({ tab: 'import', run: runId, mode: mode === 'link' ? null : mode });
}

/** Admin › Review › Couldn't verify, filtered to one import (its run). */
export function reviewImportSearch(runId: number): string {
  return adminSearch({ tab: 'review', lane: 'unverified', run: runId });
}

/** v35 INT-B: Admin › Runs, on one import's run (Runs reads `run`: the runs of its record, that run opened). */
export function runsImportSearch(runId: number): string {
  return adminSearch({ tab: 'runs', run: runId });
}
