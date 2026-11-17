import { createBackgroundGate } from '../../../ai/background';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { summaryBudgetLeft } from './budget';
import { releasePending, SUMMARY_FAILURE_WAIT_MS } from './state';
export { SUMMARY_FAILURE_WAIT_MS } from './state';
import { companySummaryTask, type CompanySummaryTaskResult } from './task';

// v30 E3: the batch runner (docs/design/part2/13-company-enrichment.md §8, "Running it"): it takes the pending
// companies (company_summaries.due_at, marked by the `ai` step and the daily sweep), COMPANY_AI_BATCH at a time, most
// open jobs first, and runs one `company_summary` task per batch on the AI queue (background priority, charged to no
// one), one batch at a time, while:
//   - the day's COMPANY_AI_DAILY_BUDGET_USD is not spent (budget.ts; read before each batch, and by the task before
//     each of its runs): a spent budget stops the batches until the next day;
//   - the background gate is open (ai/background.ts: no AI hold, no usage warning, no capacity block), as for the other
//     background AI work.
// It runs in the API process, beside the AI queue and its background slots (Feature.start), not in the ingest worker:
// the summaries share the server's one CLI seat with every other AI task. A batch holds its companies for
// SUMMARY_LEASE_MS (leased_until); a stopped server's batch is taken again after it. v30 FIX-C: that lease is the
// batch's token: the task asks only about the companies it still holds (a task that waited past its lease makes no
// call for a company another batch took meanwhile), and a failed batch puts back only the companies it still holds.

/** How long a batch holds its companies, and how long the runner waits for its task. */
export const SUMMARY_LEASE_MS = 30 * 60_000;
/** How often the runner looks for work when nothing is pending. */
export const SUMMARY_TICK_MS = 60_000;
/** After a batch ran, the next one starts this soon. */
const NEXT_BATCH_MS = 1000;

export type SummaryBatchWait =
  /** No AI queue on this server, or AI off. */
  | 'off'
  /** The day's budget is spent. */
  | 'budget'
  /** Nothing pending is due. */
  | 'empty'
  /** The AI queue refused the task, or the task failed: the companies wait SUMMARY_FAILURE_WAIT_MS. */
  | 'failed';

export interface SummaryBatchResult {
  /** The companies the batch took. */
  companyIds: number[];
  taskId: string | null;
  /** Why no batch ran, or why it failed. */
  wait: SummaryBatchWait | null;
  result: CompanySummaryTaskResult | null;
}

type RunnerDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Takes the next batch of due companies (most open jobs first), holding them until `leaseUntil` (SUMMARY_LEASE_MS). */
export async function claimSummaryBatch(
  deps: RunnerDeps,
  size: number,
  leaseUntil = new Date(deps.now().getTime() + SUMMARY_LEASE_MS).toISOString(),
): Promise<number[]> {
  const now = deps.now();
  const rows = await deps.db.all<{ company_id: number }>(
    // In the walk's order (v30 FIX-C: the task asks one company at a time, the most open jobs first).
    `WITH claimed AS (
       UPDATE company_summaries SET leased_until = ? WHERE company_id IN (
         SELECT company_id FROM company_summaries
         WHERE due_at IS NOT NULL AND due_at <= ? AND (leased_until IS NULL OR leased_until < ?)
         ORDER BY priority DESC, due_at, company_id LIMIT ? FOR UPDATE SKIP LOCKED)
       RETURNING company_id, priority, due_at)
     SELECT company_id FROM claimed ORDER BY priority DESC, due_at, company_id`,
    [leaseUntil, now.toISOString(), now.toISOString(), size],
  );
  return rows.map((row) => Number(row.company_id));
}

/** Puts a failed batch's companies back, those it still holds (its lease), after SUMMARY_FAILURE_WAIT_MS. */
async function failBatch(deps: RunnerDeps, companyIds: readonly number[], lease: string, error: string): Promise<void> {
  const held = await deps.db.all<{ company_id: number }>(
    "SELECT company_id FROM company_summaries WHERE company_id = ANY(CAST(string_to_array(?, ',') AS bigint[])) AND leased_until = CAST(? AS timestamptz)",
    [companyIds.join(','), lease],
  );
  const dueAt = new Date(deps.now().getTime() + SUMMARY_FAILURE_WAIT_MS).toISOString();
  await deps.db.tx((t) => releasePending(t, held.map((row) => Number(row.company_id)), { dueAt, error }), { label: 'company summaries failed' });
}

/** One batch: the budget, the claim, the task (waited for). Never throws for the AI's failures. */
export async function runSummaryBatch(deps: RunnerDeps): Promise<SummaryBatchResult> {
  const none = (wait: SummaryBatchWait): SummaryBatchResult => ({ companyIds: [], taskId: null, wait, result: null });
  const ai = deps.services.ai;
  if (!ai || !deps.config.ai.enabled) return none('off');
  if ((await summaryBudgetLeft(deps)) <= 0) return none('budget');
  const lease = new Date(deps.now().getTime() + SUMMARY_LEASE_MS).toISOString();
  const companyIds = await claimSummaryBatch(deps, constantsOf(deps).get('COMPANY_AI_BATCH'), lease);
  if (companyIds.length === 0) return none('empty');
  let taskId: string | null = null;
  try {
    ({ taskId } = await companySummaryTask.enqueue(deps, { userId: null, input: { companyIds, lease }, priority: 'background' }));
  } catch (error) {
    deps.log.warn('[companies] the AI queue refused a batch of company summaries; it is tried again later', error);
    await failBatch(deps, companyIds, lease, error instanceof Error ? error.message : String(error));
    return { companyIds, taskId: null, wait: 'failed', result: null };
  }
  let view;
  try {
    view = await ai.waitFor(taskId, SUMMARY_LEASE_MS);
  } catch {
    // Still waiting or running past its lease: the companies are taken again once the lease ends, and this task, when
    // it runs, asks only about those it still holds (its lease is its token).
    return { companyIds, taskId, wait: 'failed', result: null };
  }
  if (view.status !== 'succeeded') {
    await failBatch(deps, companyIds, lease, view.error ? `${view.error.code}: ${view.error.message}` : view.status);
    return { companyIds, taskId, wait: 'failed', result: null };
  }
  return { companyIds, taskId, wait: null, result: view.result as CompanySummaryTaskResult };
}

/**
 * Starts the runner (Feature.start): a batch whenever the gate is open and something is due, one at a time. Nothing
 * when this server has no AI queue, AI is off or no background slot exists. Answers the stop.
 */
export function startSummaryRunner(deps: AppDeps): () => Promise<void> {
  if (!deps.services.ai || !deps.config.ai.enabled || deps.config.ai.backgroundSlots <= 0) return async () => undefined;
  const gate = createBackgroundGate(deps);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(tick, Math.max(0, ms));
    timer.unref?.();
  };
  const tick = () => {
    timer = null;
    const nowMs = deps.now().getTime();
    const open = gate.allowed();
    if (!open.ok) return schedule(Math.min(open.retryAtMs - nowMs, SUMMARY_TICK_MS * 10));
    running = (async () => {
      let next = SUMMARY_TICK_MS;
      try {
        const batch = await runSummaryBatch(deps);
        if (batch.wait === null) next = NEXT_BATCH_MS;
        if (batch.result && (batch.result.refused > 0 || batch.result.written > 0)) {
          deps.log.info(
            `[companies] company summaries: ${batch.result.written} written, ${batch.result.declined} declined, ${batch.result.refused} refused`,
          );
        }
      } catch (error) {
        deps.log.error('[companies] the company summaries batch failed; it runs again later', error);
      } finally {
        running = null;
        schedule(next);
      }
    })();
  };
  schedule(NEXT_BATCH_MS);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
