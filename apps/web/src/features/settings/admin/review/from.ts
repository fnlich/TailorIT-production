import { JobImportListSchema, type JobImportList, type JobImportSummary } from '@tailorit/shared/ingest';
import {
  AdminReviewsAllCountSchema,
  AdminReviewsAllResultSchema,
  NEW_JOB_FROM_LABEL,
  REVIEW_BULK_OUTCOMES,
  type AdminReviewsAllBody,
  type AdminReviewsAllCount,
  type AdminReviewsAllResult,
  type NewJobFromFilter,
  type ReviewStateFilter,
} from '@tailorit/shared/reviews';
import type { UnverifiedFrom } from '@tailorit/shared/jobs';
import { api } from '@/lib/api';
import { UNVERIFIED_FROM_LABEL, type UnverifiedFilter } from './unverified';

// v35 OPSWEB (PLAN H3): Admin › Review's From filter on both lanes that take imports (Couldn't verify: All, Imports,
// People's adds, one import; New jobs: All, Link reads, Imports, one import), the recent imports it offers, and New
// jobs' Approve all / Reject all (ADMIN's /api/admin/reviews/all: a count, then requests continued with `after` until
// `done`). Pure but for the requests, so the web tests read it without a page.

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

/** The lane's filter as /api/admin/reviews/all reads it. */
export function newJobAllFilter(filter: NewJobFilter, state: ReviewStateFilter, q: string): AdminReviewsAllBody['filter'] {
  const text = q.trim();
  return { lane: 'new_job', state, ...(text ? { q: text } : {}), ...newJobFilterQuery(filter) };
}

/**
 * GET /api/admin/reviews/all/count: the pending reviews Approve all / Reject all would decide. v35 FIX-WEB (S6): and
 * `upTo`, what was counted (opaque), which their requests send back.
 */
export function fetchNewJobsAllCount(filter: AdminReviewsAllBody['filter'], signal?: AbortSignal): Promise<AdminReviewsAllCount> {
  return api.get<AdminReviewsAllCount>('/api/admin/reviews/all/count', { signal, query: { ...filter }, schema: AdminReviewsAllCountSchema });
}

/** POST /api/admin/reviews/all: one request (it decides for at most ADMIN_BULK_ALL_SECONDS; `done` false: go on). */
export function decideNewJobsAll(body: AdminReviewsAllBody): Promise<AdminReviewsAllResult> {
  return api.post<AdminReviewsAllResult>('/api/admin/reviews/all', body, { schema: AdminReviewsAllResultSchema });
}

type Outcome = (typeof REVIEW_BULK_OUTCOMES)[number];

/** Every request's answer added up: the counts, the first failures, and whether it finished. */
export interface NewJobsAllOutcome {
  decision: 'approve' | 'reject';
  counts: Partial<Record<Outcome, number>>;
  failures: AdminReviewsAllResult['failures'];
  done: boolean;
}

/**
 * Approve all / Reject all on New jobs: the request again with `after` while `done` is false (up to `maxTurns`); `onTurn`
 * hears the running total.
 */
export async function runNewJobsAll(
  body: Omit<AdminReviewsAllBody, 'after'>,
  send: (body: AdminReviewsAllBody) => Promise<AdminReviewsAllResult>,
  onTurn: (sofar: NewJobsAllOutcome) => void = () => undefined,
  maxTurns = 200,
): Promise<NewJobsAllOutcome> {
  const total: NewJobsAllOutcome = { decision: body.decision, counts: {}, failures: [], done: false };
  let after: number | undefined;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const answer = await send(after === undefined ? body : { ...body, after });
    for (const outcome of REVIEW_BULK_OUTCOMES) {
      const count = answer.counts[outcome];
      if (count) total.counts[outcome] = (total.counts[outcome] ?? 0) + count;
    }
    total.failures = [...total.failures, ...answer.failures].slice(0, 20);
    total.done = answer.done;
    onTurn({ ...total, counts: { ...total.counts } });
    if (answer.done || answer.after === after) break;
    after = answer.after;
  }
  return total;
}

/** "Approved 1,240 jobs; 3 skipped, 1 failed." (one result line). */
export function newJobsAllLine(outcome: Pick<NewJobsAllOutcome, 'decision' | 'counts' | 'done'>): string {
  const decided = outcome.decision === 'approve' ? (outcome.counts.approved ?? 0) : (outcome.counts.rejected ?? 0);
  const verb = outcome.decision === 'approve' ? 'Approved' : 'Rejected';
  const head = `${verb} ${decided.toLocaleString('en-US')} ${decided === 1 ? 'job' : 'jobs'}`;
  const rest = [
    outcome.counts.skipped ? `${outcome.counts.skipped.toLocaleString('en-US')} skipped` : '',
    outcome.counts.failed ? `${outcome.counts.failed.toLocaleString('en-US')} failed` : '',
    outcome.done ? '' : 'more are left: run it again',
  ]
    .filter(Boolean)
    .join(', ');
  return rest ? `${head}; ${rest}.` : `${head}.`;
}
