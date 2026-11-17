import type { Limit } from '@tailorit/shared';
import { autoApplyWindow, resetTextOf } from '../constants/day';
import type { AppDeps } from '../context';
import { entitlementsOf } from './entitlements';

// v2.0: the auto-apply count of one person's current window (docs/design/v2.0/04-accounts-limits.md §1). A run of Run
// auto-apply or of the Queue tab taking a queued row reserves one use (auto_apply_reservations, written by P3's claim in
// the same transaction); the window counts 'reserved' and 'used'. Every account's runs are recorded, Paid included, so
// a lapse mid-day counts the day's earlier runs at once.

export interface AutoApplyUsage {
  /** Reserved and used auto-applies in the current window. */
  used: number;
  /** The plan's limit per window; null: UNLIMITED. */
  limit: Limit;
  /** `limit` is not UNLIMITED and `used` has reached it: the claims take nothing until `resetsAt`. */
  reached: boolean;
  windowDays: number;
  /** Today's day key, and the window's first and last day keys. */
  dayKey: string;
  start: string;
  end: string;
  /** When the window ends (the count resets), ISO-8601; and its {reset_time} words. */
  resetsAt: string;
  resetText: string;
}

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The SQL of liveReservations: user id, first and last day key. */
export const LIVE_RESERVATIONS_SQL = `SELECT count(*) AS n FROM auto_apply_reservations
  WHERE user_id = ? AND day_key BETWEEN ? AND ? AND state IN ('reserved', 'used')`;

/**
 * The SQL count of the person's live reservations between two day keys (P3's claim runs the same inside its lock: on
 * PostgreSQL after lockPerson, v3.0 D2).
 */
export async function liveReservations(deps: Pick<AppDeps, 'db'>, userId: string, start: string, end: string): Promise<number> {
  return (await deps.db.one<{ n: number }>(LIVE_RESERVATIONS_SQL, [userId, start, end]))!.n;
}

/** AutoApplyUsage from the plan's limit and the count (autoApplyUsage). */
export function usageFrom(deps: Deps, limit: Limit, used: number, window: ReturnType<typeof autoApplyWindow>): AutoApplyUsage {
  return {
    used,
    limit,
    reached: limit !== null && used >= limit,
    windowDays: window.windowDays,
    dayKey: window.dayKey,
    start: window.start,
    end: window.end,
    resetsAt: window.resetsAt,
    resetText: resetTextOf(deps),
  };
}

/** The person's auto-apply usage in the window that holds `at` (now). */
export async function autoApplyUsage(deps: Deps, userId: string, at: Date = deps.now()): Promise<AutoApplyUsage> {
  const limit = (await entitlementsOf(deps, userId)).autoApplyPerWindow;
  const window = autoApplyWindow(deps, at);
  return usageFrom(deps, limit, await liveReservations(deps, userId, window.start, window.end), window);
}
