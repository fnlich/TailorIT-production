import { COMPANY_SUMMARY_PROMPT_VERSION } from '../../../ai/prompts/companies/summary';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { minConfidenceOf } from '../profile';
import { lookAtCompany, type SummaryInputs, type SummaryLookOptions } from './inputs';
import { recordDue, recordIdle, recordNotShared, summaryStateOf, type SummaryCheck, type SummaryStateRow } from './state';
import { DAY_MS } from '@tailorit/shared';

// v30 E3: the enrichment queue's `ai` step (COMPANY_ENRICHMENT_STEPS; docs/design/part2/13-company-enrichment.md §7,
// §8): it looks at one company and marks it pending when its summary is due; the batch runner (runner.ts) then writes
// summaries COMPANY_AI_BATCH at a time. E1's step registry (features/companies/enrich/) runs it for each company whose
// queue row names `ai` (a new company, a hiring-organisation hand-off, an admin's "Refresh now"); the daily sweep
// (sweep.ts) runs it for the companies whose sources changed since its last look.
//
// Due: an eligible company (inputs.ts) whose inputs' hash or prompt version differs from its last answer's (or that
// has none), from the later of now and its last answer + COMPANY_AI_REFRESH_DAYS ("only when its inputs' hash changes,
// at most once in 30 days", 13 §7). Its priority is its open jobs.

export type SummaryDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The constants a look reads (each read at the call: an admin's change applies at the next look). */
export function lookOptionsOf(deps: SummaryDeps): SummaryLookOptions {
  return { minConfidence: minConfidenceOf(deps), minChars: constantsOf(deps).get('COMPANY_AI_MIN_INPUT_CHARS') };
}

/** Whether a company's summary is due for these inputs, and from when (null: current, nothing to do). */
export function summaryDueAt(state: SummaryStateRow | undefined, inputs: SummaryInputs, now: Date, refreshDays: number): Date | null {
  if (state?.outcome && state.inputs_hash === inputs.hash && state.prompt_version === COMPANY_SUMMARY_PROMPT_VERSION) return null;
  const answeredAt = state?.answered_at ? Date.parse(state.answered_at) : null;
  const earliest = answeredAt === null ? now.getTime() : answeredAt + refreshDays * DAY_MS;
  return new Date(Math.max(now.getTime(), earliest));
}

export interface SummaryStepResult {
  check: SummaryCheck;
  /** When the batch runner may take it (pending), else null. */
  dueAt: string | null;
}

/** The look itself, in the caller's transaction. */
export async function lookAndMark(deps: SummaryDeps, t: DbQueries, companyId: number): Promise<SummaryStepResult> {
  const now = deps.now();
  const at = now.toISOString();
  const look = await lookAtCompany(t, companyId, lookOptionsOf(deps));
  const state = await summaryStateOf(t, companyId, true);
  if (!look.eligible) {
    // A company that is gone, or an account's own row, gets no row of its own.
    if (look.reason === 'not_shared') await recordNotShared(t, companyId, at);
    else await recordIdle(t, companyId, look.reason, at, look.openJobs);
    return { check: look.reason, dueAt: null };
  }
  const dueAt = summaryDueAt(state, look.inputs, now, constantsOf(deps).get('COMPANY_AI_REFRESH_DAYS'));
  if (!dueAt) {
    await recordIdle(t, companyId, 'current', at, look.openJobs);
    return { check: 'current', dueAt: null };
  }
  const waiting = dueAt.getTime() > now.getTime();
  await recordDue(t, companyId, { dueAt: dueAt.toISOString(), at, priority: look.openJobs, waiting });
  return { check: waiting ? 'waiting' : 'due', dueAt: dueAt.toISOString() };
}

/** The `ai` enrichment step for one company, in a transaction of its own (no outside I/O: it only reads and marks). */
export async function summaryStep(deps: SummaryDeps, companyId: number): Promise<SummaryStepResult> {
  return deps.db.tx((t) => lookAndMark(deps, t, companyId), { label: 'company summary look' });
}
