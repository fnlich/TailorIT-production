import { microsOf } from '../../../ai/usage';
import { constantsOf } from '../../../core/constants/service';
import { nextDailyResetAt } from '../../../core/constants/day';
import type { SummaryDeps } from './step';
import { HOUR_MS } from '@tailorit/shared';

// v30 E3: the company summaries' daily budget (docs/design/part2/13-company-enrichment.md §8: COMPANY_AI_DAILY_BUDGET_USD,
// $2 by default; platform spend, never a person's budget). What the summaries spent today is what their AI tasks spent
// since the day's exact start (DAY_RESET_TIME in DAY_RESET_TIME_ZONE, as every daily AI budget): each prompt run's cost
// is added to its task's row as the run ends. The batch runner and the task read it before every call, so a batch stops
// once the day's budget is spent and the rest wait for the next day.

/** A day is 23 to 25 hours across a clock change: a moment 26 hours before the next reset is in the day before. */
const BEFORE_A_DAY_MS = 26 * HOUR_MS;

/** When today began: the daily reset before now. */
export function summaryDayStart(deps: SummaryDeps, at: Date = deps.now()): Date {
  return nextDailyResetAt(deps, new Date(nextDailyResetAt(deps, at).getTime() - BEFORE_A_DAY_MS));
}

/** When the budget's next day begins (the next daily reset), as ISO text: when a company the budget held is due again. */
export function nextBudgetDayAt(deps: SummaryDeps, at: Date = deps.now()): string {
  return nextDailyResetAt(deps, at).toISOString();
}

/**
 * What the summaries spent today, in micro-dollars (rounded up). v30 FIX-C BEH-12: read from the day's exact start, not
 * from its first UTC hour (an admin's DAY_RESET_TIME may fall inside an hour, which the hourly ledger ai_usage_hourly
 * cannot split): the `company_summary` tasks started since then, each prompt run's cost on its task's row (the AI
 * queue writes it with the ledger's row, as the run ends). A task is counted on the day it started.
 */
export async function summarySpentToday(deps: SummaryDeps): Promise<number> {
  const since = summaryDayStart(deps).toISOString();
  const row = await deps.db.one<{ cost: number | string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS cost FROM ai_tasks
     WHERE kind = 'company_summary' AND created_at >= CAST(? AS timestamptz) - interval '1 day'
       AND coalesce(started_at, created_at) >= CAST(? AS timestamptz)`,
    [since, since],
  );
  return microsOf(Number(row?.cost ?? 0));
}

/** What is left of today's budget, in micro-dollars (0 or less: spent). Reads the constant at each call. */
export async function summaryBudgetLeft(deps: SummaryDeps): Promise<number> {
  return constantsOf(deps).get('COMPANY_AI_DAILY_BUDGET_USD') - (await summarySpentToday(deps));
}
