import { randomUUID } from 'node:crypto';
import type { AutofillAgentResultBody, AutofillAgentRun, AutofillDailyLimit } from '@tailorit/shared/autofill';
import { entitlementsOf } from '../../../core/accounts/entitlements';
import { autoApplyLimitMessage } from '../../../core/accounts/refusals';
import { liveReservations } from '../../../core/accounts/usage';
import { autoApplyWindow, type AutoApplyWindow } from '../../../core/constants/day';
import { nowIso, type AppDeps } from '../../../core/context';
import type { Dialect } from '../../../core/db/dialect';

// v2.0: the Free daily auto-apply allowance (docs/design/v2.0/04-accounts-limits.md §1, DECISIONS A13). A run of Run
// auto-apply (GET /agent/next) or of the Queue tab (POST /agent/:id/opened) that takes a queued row reserves one use in
// auto_apply_reservations, inside the claim's own transaction (deps.db.tx), after counting the account's live
// reservations (`reserved` + `used`) in the current window. v3.0 D2 (11-database.md §9.3): the claim's transaction
// starts with lockPerson, held from the count to the insert, so two claims at once can never both take the last use
// (on SQLite BEGIN IMMEDIATE already serialises them; on PostgreSQL the person's lock does). Every account's runs are
// recorded, Paid included (a lapse mid-day then counts the morning). The reservation is settled in the transaction that
// changes its queue row: kept (`used`) for a sent form, or when Submit was pressed and the confirmation was not seen
// (`timed_out` or `submitPressed`); given back (`released`) for a run that failed, was skipped, or needs the person
// before Submit. Prepare, queueing, Mark as applied, the person's own Autofill and the Tracker never reserve. Only this
// folder writes the table.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The account's allowance at the moment of a claim (inside its transaction). */
export interface ClaimAllowance {
  window: AutoApplyWindow;
  /** null: UNLIMITED (a Paid account). */
  limit: number | null;
  /** Live reservations in the window before this claim. */
  used: number;
  /** No use is left: the claim takes nothing. */
  reached: boolean;
  /**
   * The account is Free now. v20 FIX-INT (INT-open): the limit's words say so, with Subscribe, only for a Free account;
   * any other account an admin gave a finite limit reads the neutral MSG_LIMIT_AUTO_APPLY_ACCOUNT.
   */
  free: boolean;
}

/**
 * Counts the account's live reservations in the current window. Call inside the claim's transaction, after its
 * lockPerson (v3.0 D2).
 */
export async function allowanceOf(deps: Deps, userId: string): Promise<ClaimAllowance> {
  const window = autoApplyWindow(deps);
  const entitlements = await entitlementsOf(deps, userId);
  const limit = entitlements.autoApplyPerWindow;
  const used = await liveReservations(deps, userId, window.start, window.end);
  return { window, limit, used, reached: limit !== null && used >= limit, free: entitlements.type === 'free' };
}

/** Reserves one use for the row a run takes now. Call inside the claim's transaction, after `allowanceOf`. */
export async function reserve(
  deps: Deps,
  input: { userId: string; queueId: string; jobId: number; run: AutofillAgentRun; tokenId: string | null; dayKey: string },
): Promise<void> {
  await deps.db.run(
    `INSERT INTO auto_apply_reservations(id, user_id, queue_id, job_id, day_key, run, token_id, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
    [randomUUID(), input.userId, input.queueId, input.jobId, input.dayKey, input.run, input.tokenId, nowIso(deps)],
  );
}

/** The claim's `dailyLimit` (API 8): the counts as they stand after it, and the limit's words once it is reached. */
export function dailyLimitOf(deps: Deps, allowance: ClaimAllowance, used: number): AutofillDailyLimit {
  const reached = allowance.limit !== null && used >= allowance.limit;
  return {
    reached,
    used,
    limit: allowance.limit,
    resetsAt: allowance.window.resetsAt,
    ...(reached && allowance.limit !== null
      ? { message: autoApplyLimitMessage(deps, allowance.limit, { free: allowance.free }) }
      : {}),
  };
}

/** How a reservation is settled. */
export type Settlement = 'used' | 'released';

/**
 * The SQL of a settlement (settleReservation): the queue row's newest reservation; of two made in one millisecond, the
 * later inserted (`d.seq()`: SQLite's rowid, the PostgreSQL baseline's `seq`).
 */
export function settleSql(d: Dialect, settlement: Settlement): string {
  const from = settlement === 'used' ? "('reserved', 'released')" : "('reserved')";
  return `UPDATE auto_apply_reservations SET state = ?, settle_reason = ?, settled_at = ?
       WHERE id = (SELECT id FROM auto_apply_reservations WHERE queue_id = ? ORDER BY created_at DESC, ${d.seq()} DESC LIMIT 1)
         AND state IN ${from}`;
}

/** The values settleSql binds. */
export function settleParams(deps: Pick<AppDeps, 'now'>, queueId: string, settlement: Settlement, reason: string): string[] {
  return [settlement, reason.slice(0, 40), nowIso(deps), queueId];
}

/**
 * Settles the queue row's reservation: its newest one, when it is not settled that way already. `used` also turns a
 * `released` one into a use (a form that was sent always counts: a late submission); `released` gives back only a
 * live (`reserved`) one, never a use. A run taken before v2.0 has none: nothing changes. Call in the transaction that
 * changes the queue row.
 */
export async function settleReservation(
  deps: Pick<AppDeps, 'db' | 'now'>,
  queueId: string,
  settlement: Settlement,
  reason: string,
): Promise<void> {
  await deps.db.run(settleSql(deps.db.dialect, settlement), settleParams(deps, queueId, settlement, reason));
}

/**
 * The settlement a run's result makes (04's table): `submitted` uses; `failed` and `skipped` give back; `needs-you`
 * uses when Submit was pressed (`submitPressed`, or the reason `timed_out`: it may have been), else gives back.
 */
export function settlementOfResult(body: AutofillAgentResultBody): Settlement {
  if (body.state === 'submitted') return 'used';
  if (body.state === 'needs-you' && (body.submitPressed === true || body.reason === 'timed_out')) return 'used';
  return 'released';
}

/** The settle_reason of a result: its state, or its reason code. */
export const resultSettleReason = (body: AutofillAgentResultBody): string => body.reason ?? body.state;

/** A row a server-side change finished: `submit_pressed` a flag as read (1/0 on SQLite, a boolean on PostgreSQL) or NULL. */
export interface FinishedRow {
  id: string;
  submit_pressed: number | boolean | null;
}

/** A finished row's settlement: `used` only when its run reported Submit pressed. */
export function finishedSettlement(d: Dialect, row: FinishedRow): Settlement {
  return row.submit_pressed !== null && d.isTrue(row.submit_pressed) ? 'used' : 'released';
}

/**
 * Settles the reservations of rows a server-side change just finished (the 30-minute stale release, a disconnected
 * browser, a running row the person removed): `used` only when the run reported Submit pressed (`submit_pressed`
 * set); else `released`. v2.0 FIX-B (BEH-4, the coordinator's reading of A13 "kept only when Submit was pressed"): a
 * stale run that never reported a press (NULL: a browser restart or an extension update lost the run) gives its use
 * back too.
 */
export async function settleFinishedRows(
  deps: Pick<AppDeps, 'db' | 'now'>,
  rows: readonly FinishedRow[],
  how: 'stale' | 'disconnected' | 'removed',
): Promise<void> {
  for (const row of rows) await settleReservation(deps, row.id, finishedSettlement(deps.db.dialect, row), how);
}

/** The account's usage for GET /agent/queue (a token) and the Auto-apply page: `{used, limit, resetsAt}`. */
export async function usageOf(deps: Deps, userId: string): Promise<{ used: number; limit: number | null; resetsAt: string }> {
  const allowance = await allowanceOf(deps, userId);
  return { used: allowance.used, limit: allowance.limit, resetsAt: allowance.window.resetsAt };
}

/** Which run took the queue row, by its newest reservation (a removed row's late submission): null with none. */
export async function reservationRunOf(deps: Pick<AppDeps, 'db'>, queueId: string): Promise<AutofillAgentRun | null> {
  // The newest as in settleSql.
  const row = await deps.db.one<{ run: AutofillAgentRun }>(
    `SELECT run FROM auto_apply_reservations WHERE queue_id = ? ORDER BY created_at DESC, ${deps.db.dialect.seq()} DESC LIMIT 1`,
    [queueId],
  );
  return row?.run ?? null;
}
