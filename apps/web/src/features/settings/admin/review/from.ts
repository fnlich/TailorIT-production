import { JobImportListSchema, type JobImportList, type JobImportSummary } from '@tailorit/shared/ingest';
import { NEW_JOB_FROM_LABEL, type NewJobFromFilter } from '@tailorit/shared/reviews';
import type { UnverifiedFrom } from '@tailorit/shared/jobs';
import { api } from '@/lib/api';
import { UNVERIFIED_FROM_LABEL, type UnverifiedFilter } from './unverified';

// v35 OPSWEB (PLAN H3): Admin › Review's From filter on both lanes that take imports (Couldn't verify: All, Imports,
// People's adds, one import; New jobs: All, Link reads, Imports, one import) and the recent imports it offers. Pure but
// for the requests, so the web tests read it without a page.

/** GET /api/admin/imports: the recent imports (newest first) the From filter offers one by one. */
export function fetchRecentImports(signal?: AbortSignal): Promise<JobImportList> {
  return api.get<JobImportList>('/api/admin/imports', { signal, schema: JobImportListSchema });
}

/** "Import · jobs.csv" (an import in a select). */
export function importOptionLabel(item: Pick<JobImportSummary, 'name'>): string {
  return `Import · ${item.name}`;
}

/** A From value in a select: a way ('all', 'imports', ...) or one import (`run:<runId>`). */
export type FromValue = string;

/** The select's options: the ways, then each recent admin import (and the one the address named, if not among them). */
export function fromOptions(
  ways: ReadonlyArray<{ value: string; label: string }>,
  imports: readonly Pick<JobImportSummary, 'runId' | 'name'>[],
  chosenRun: number | null,
): Array<{ value: FromValue; label: string }> {
  const runs = imports.filter((item): item is typeof item & { runId: number } => item.runId !== null);
  const options = [...ways.map((way) => ({ value: way.value, label: way.label })), ...runs.map((item) => ({ value: `run:${item.runId}`, label: importOptionLabel(item) }))];
  if (chosenRun !== null && !runs.some((item) => item.runId === chosenRun)) options.push({ value: `run:${chosenRun}`, label: `Import (run ${chosenRun})` });
  return options;
}

/** The run a From value names, or null. */
export function runOfValue(value: FromValue): number | null {
  const match = /^run:(\d+)$/.exec(value);
  return match ? Number(match[1]) : null;
}

// Couldn't verify ---------------------------------------------------------------------------------------------------

export const UNVERIFIED_WAYS = (['all', 'imports', 'adds'] as const).map((value) => ({ value, label: UNVERIFIED_FROM_LABEL[value] }));

export function unverifiedFromValue(filter: UnverifiedFilter): FromValue {
  return filter.runId ? `run:${filter.runId}` : filter.from;
}

export function unverifiedFilterOf(value: FromValue): UnverifiedFilter {
  const run = runOfValue(value);
  if (run) return { from: 'imports', runId: run };
  return { from: (['all', 'imports', 'adds'] as const).includes(value as UnverifiedFrom) ? (value as UnverifiedFrom) : 'all', runId: null };
}

// New jobs ----------------------------------------------------------------------------------------------------------

/** New jobs' From filter: where its held jobs came from, or one import (its run). */
export interface NewJobFilter {
  from: NewJobFromFilter;
  runId: number | null;
}
export const ALL_NEW_JOBS: NewJobFilter = { from: 'all', runId: null };

/** All, Link reads, Imports (the spec's order). */
export const NEW_JOB_WAYS = (['all', 'reads', 'imports'] as const).map((value) => ({ value, label: NEW_JOB_FROM_LABEL[value] }));

export function newJobFromValue(filter: NewJobFilter): FromValue {
  return filter.runId ? `run:${filter.runId}` : filter.from;
}

export function newJobFilterOf(value: FromValue): NewJobFilter {
  const run = runOfValue(value);
  if (run) return { from: 'imports', runId: run };
  return { from: (['all', 'imports', 'reads'] as const).includes(value as NewJobFromFilter) ? (value as NewJobFromFilter) : 'all', runId: null };
}

/** The filter an address opens New jobs with: `run=<runId>` (one import), else All. */
export function newJobFilterFromAddress(params: { get(name: string): string | null }): NewJobFilter {
  const run = Number(params.get('run'));
  return params.get('lane') === 'new_job' && Number.isInteger(run) && run > 0 ? { from: 'imports', runId: run } : ALL_NEW_JOBS;
}

/** The New jobs list's query keys for the filter (absent: all). */
export function newJobFilterQuery(filter: NewJobFilter): { from?: NewJobFromFilter; importRunId?: number } {
  if (filter.runId) return { from: 'imports', importRunId: filter.runId };
  return filter.from === 'all' ? {} : { from: filter.from };
}

// v37 REVIEW (SP v37 PLAN.md R3): New jobs' Approve all / Reject all became the lane's "Select all N" (every review the
// filter matches, as on Closed links and Flags): its requests and words are all.ts's.
