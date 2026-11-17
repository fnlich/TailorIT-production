import type { DbQueries } from '../../../core/db/types';
import type { SummaryIneligible } from './inputs';

// v30 E3: each company's summary bookkeeping (company_summaries, migrations-pg/0026): the AI's last answer (its inputs'
// hash, prompt version, outcome and time), the last look, and the pending mark the batch runner works.

/** After the AI failed a batch (or its second ask), its companies wait this long. */
export const SUMMARY_FAILURE_WAIT_MS = 60 * 60_000;

/** What the AI's last answer came to. */
export const SUMMARY_OUTCOMES = ['written', 'declined', 'refused'] as const;
export type SummaryOutcome = (typeof SUMMARY_OUTCOMES)[number];

/** What the last look found: due now, due later (the refresh days still run), current, or not eligible. */
export const SUMMARY_CHECKS = ['due', 'waiting', 'current', 'too_little', 'no_jobs', 'locked', 'not_shared'] as const;
export type SummaryCheck = (typeof SUMMARY_CHECKS)[number];

export interface SummaryStateRow {
  company_id: number;
  inputs_hash: string | null;
  prompt_version: number | null;
  outcome: SummaryOutcome | null;
  answered_at: string | null;
  last_check: SummaryCheck;
  checked_at: string;
  due_at: string | null;
  priority: number;
  leased_until: string | null;
  attempts: number;
  last_error: string | null;
}

const STATE_SQL = `SELECT company_id, inputs_hash, prompt_version, outcome, answered_at, last_check, checked_at, due_at, priority,
    leased_until, attempts, last_error FROM company_summaries`;

/** A company's summary state (none before its first look). `forUpdate` locks it for the caller's transaction. */
export async function summaryStateOf(t: DbQueries, companyId: number, forUpdate = false): Promise<SummaryStateRow | undefined> {
  return t.one<SummaryStateRow>(`${STATE_SQL} WHERE company_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [companyId]);
}

/** Records a look that finds nothing to do (not eligible, or current): the pending mark goes. */
export async function recordIdle(
  t: DbQueries,
  companyId: number,
  check: Exclude<SummaryIneligible, 'not_shared'> | 'current',
  at: string,
  priority = 0,
): Promise<void> {
  await t.run(
    `INSERT INTO company_summaries(company_id, last_check, checked_at, priority) VALUES (?, ?, ?, ?)
     ON CONFLICT (company_id) DO UPDATE SET last_check = excluded.last_check, checked_at = excluded.checked_at,
       priority = excluded.priority, due_at = NULL, leased_until = NULL, attempts = 0, last_error = NULL`,
    [companyId, check, at, priority],
  );
}

/**
 * Records a look at a company that is no longer a shared one (merged, opted out): its row, when it has one, is no
 * longer pending. A company with no row gets none (an account's own row, a company gone).
 */
export async function recordNotShared(t: DbQueries, companyId: number, at: string): Promise<void> {
  await t.run(
    `UPDATE company_summaries SET last_check = 'not_shared', checked_at = ?, due_at = NULL, leased_until = NULL, attempts = 0,
       last_error = NULL WHERE company_id = ?`,
    [at, companyId],
  );
}

/**
 * Records a look that finds the company due: pending from `dueAt` (now, or when the refresh days run out), with its
 * open jobs as its priority. A batch holding it (leased_until) keeps it; its answer then sets the state anew. A company
 * waiting after a failed run (attempts) keeps its later time.
 */
export async function recordDue(t: DbQueries, companyId: number, input: { dueAt: string; at: string; priority: number; waiting: boolean }): Promise<void> {
  await t.run(
    `INSERT INTO company_summaries(company_id, last_check, checked_at, due_at, priority) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (company_id) DO UPDATE SET last_check = excluded.last_check, checked_at = excluded.checked_at,
       due_at = CASE WHEN company_summaries.attempts > 0 AND company_summaries.due_at > excluded.due_at
                     THEN company_summaries.due_at ELSE excluded.due_at END,
       priority = excluded.priority`,
    [companyId, input.waiting ? 'waiting' : 'due', input.at, input.dueAt, input.priority],
  );
}

/** Records the AI's answer for a company (written, declined or refused): current, nothing pending. */
export async function recordAnswer(
  t: DbQueries,
  companyId: number,
  input: { hash: string; promptVersion: number; outcome: SummaryOutcome; at: string; priority: number },
): Promise<void> {
  await t.run(
    `INSERT INTO company_summaries(company_id, inputs_hash, prompt_version, outcome, answered_at, last_check, checked_at, priority)
     VALUES (?, ?, ?, ?, ?, 'current', ?, ?)
     ON CONFLICT (company_id) DO UPDATE SET inputs_hash = excluded.inputs_hash, prompt_version = excluded.prompt_version,
       outcome = excluded.outcome, answered_at = excluded.answered_at, last_check = 'current', checked_at = excluded.checked_at,
       priority = excluded.priority, due_at = NULL, leased_until = NULL, attempts = 0, last_error = NULL`,
    [companyId, input.hash, input.promptVersion, input.outcome, input.at, input.at, input.priority],
  );
}

/** Puts companies back as pending from `dueAt` (the budget is spent, the AI failed), keeping their last answer. */
export async function releasePending(
  t: DbQueries,
  companyIds: readonly number[],
  input: { dueAt: string; error?: string | null },
): Promise<void> {
  if (companyIds.length === 0) return;
  const failed = input.error !== undefined && input.error !== null;
  await t.run(
    `UPDATE company_summaries SET leased_until = NULL, due_at = ?,
       attempts = CASE WHEN CAST(? AS boolean) THEN least(attempts + 1, 32767) ELSE attempts END,
       last_error = CASE WHEN CAST(? AS boolean) THEN CAST(? AS text) ELSE last_error END
     WHERE company_id = ANY(CAST(string_to_array(?, ',') AS bigint[]))`,
    [input.dueAt, failed, failed, failed ? input.error!.slice(0, 500) : null, companyIds.join(',')],
  );
}
