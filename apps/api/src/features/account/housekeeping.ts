import { addDaysToKey, DAY_MS } from '@tailorit/shared';
import { changeEntitlement } from '../../core/accounts/index';
import { autoApplyWindow, constantsOf, dayKeyAt } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';
import { RETENTION_DAILY } from './retention';

// v2.0: the daily housekeeping (docs/design/v2.0/01-data-model.md, "Retention and housekeeping"). Once at start, then
// every 24 hours, it:
// - prunes the rows the retention table keeps for a while (each window is a constant an admin may change);
// - cancels an MCP Prepare left waiting for the person's own AI (05-prepare-flow.md), so the Queue pane never shows
//   "Preparing with your AI" for an abandoned conversation;
// - rewrites a lapsed Paid account to Free through the entitlement service, with a `system` audit event, so the
//   admin's lists read plainly. Correctness never depends on it: the effective type is already Free at the lapse.
// Kept forever, never touched here: ai_credit_ledger (money), account_entitlement_events (audit) and
// application_apply_records (the application history).
//
// v30 ST4: each step is a Feature.daily step (core/feature-hooks.ts runs every feature's steps once after start, then
// every 24 hours, each on its own, and logs `[housekeeping] <feature>.<step> <n>`). The account's own steps are listed
// on accountFeature.daily. v30 INT-0: the other steps are on the features whose tables they prune: the announcements'
// (features/announcements/housekeeping.ts), Prepare's (features/prepare/housekeeping.ts: finished Prepares, abandoned
// MCP Prepares) and the Custom filter verdicts' (features/prepare-filters/housekeeping.ts).
// v30 DB-JOBS: 11 §8.2's batched-delete rules (views, draft answers, closed jobs' facts and analyses) are ./retention.ts.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const isoDaysAgo = (deps: Deps, days: number) => new Date(deps.now().getTime() - days * DAY_MS).toISOString();

/** ai_spend_daily rows older than the last AI_SPEND_KEEP_DAYS day keys. */
export const pruneAiSpendDays: DailyStep = {
  name: 'aiSpendDays',
  // A year of per-person AI history for the admin: the last AI_SPEND_KEEP_DAYS day keys, today included.
  run: async (deps) => {
    const oldest = addDaysToKey(dayKeyAt(deps), -(constantsOf(deps).get('AI_SPEND_KEEP_DAYS') - 1));
    return (await deps.db.run('DELETE FROM ai_spend_daily WHERE day_key < ?', [oldest])).changes;
  },
};

/** Settled auto_apply_reservations older than RESERVATION_KEEP_DAYS. */
export const pruneReservations: DailyStep = {
  name: 'reservations',
  // Only the current window is counted; a live (reserved) reservation is never pruned. v20 FIX-A (BEH-7): nor is one
  // of the current window, whatever RESERVATION_KEEP_DAYS says: a keep period shorter than AUTO_APPLY_WINDOW_DAYS
  // would otherwise give a Free account its window's uses back.
  run: async (deps) =>
    (
      await deps.db.run(
        `DELETE FROM auto_apply_reservations
          WHERE state IN ('used', 'released') AND settled_at IS NOT NULL AND settled_at < ? AND day_key < ?`,
        [isoDaysAgo(deps, constantsOf(deps).get('RESERVATION_KEEP_DAYS')), autoApplyWindow(deps).start],
      )
    ).changes,
};

/** Lapsed Paid accounts rewritten to Free. */
export const rewriteLapsedAccounts: DailyStep = {
  name: 'lapsedAccounts',
  // A lapsed term reads Free already (effectiveType); this rewrites the row for the admin's lists, and audits it.
  // v3.0 D2 (D2-0): async, as changeEntitlement is.
  run: async (deps) => {
    const lapsed = await deps.db.all<{ id: string }>(
      // NULLS FIRST: SQLite's order (PostgreSQL sorts nulls last by default), so a term with no end is rewritten first.
      `SELECT id FROM users WHERE account_type = 'paid' AND (paid_until IS NULL OR paid_until <= ?)
        ORDER BY paid_until NULLS FIRST, id`,
      [deps.now().toISOString()],
    );
    let rewritten = 0;
    for (const { id } of lapsed) {
      try {
        // Checked again inside the transaction, behind the person's lock: an admin who extended the term meanwhile
        // keeps it.
        const done = await deps.db.tx(async (t) => {
          await t.lockPerson(id);
          const still = await t.one(
            `SELECT 1 AS one FROM users
              WHERE id = ? AND account_type = 'paid' AND (paid_until IS NULL OR paid_until <= ?)`,
            [id, deps.now().toISOString()],
          );
          if (!still) return false;
          await changeEntitlement(deps, { userId: id, source: 'system', accountType: 'free', note: 'The Paid term ended.' });
          return true;
        });
        if (done) rewritten += 1;
      } catch (error) {
        deps.log.warn(`[housekeeping] the lapsed account ${id} could not be rewritten to Free`, error);
      }
    }
    return rewritten;
  },
};

/**
 * accountFeature.daily, in the order the v2.0 housekeeping ran them (the other steps are their own features'), then
 * v3.0's retention rules (./retention.ts, v30 DB-JOBS).
 */
export const ACCOUNT_DAILY: readonly DailyStep[] = [pruneAiSpendDays, pruneReservations, rewriteLapsedAccounts, ...RETENTION_DAILY];
