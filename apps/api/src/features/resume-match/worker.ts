import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { AppDeps } from '../../core/context';
import type { MatchCore, Settled, UserMatcher } from './service';
import type { MatchTiming } from './types';

// The resume match worker (work package WP5): it drains applications marked resume_match_due = 1 (by the triggers of
// migration 0301 when a resume, a reading, the default resume or a posting's analysis changes, and by the writers that
// save jobs) and chooses their best resume again, through the full write guard.
//
// - Cooperative: work is cut into small steps (one resume read, prepared or scored) and gives the event loop a turn
//   once a slice has run `sliceMs` (15 ms by default); each choice is written in one final transaction
//   (`MatchCore.settle`), which checks again what the choice was made from.
// - Fair: accounts take turns (TURN_ROWS rows each); disabled accounts are skipped (their rows stay due).
// - Crash-safe: every timer body, account turn and row is try / log / continue. A row whose choice failed waits
//   `retryFailedMs` before it is tried again, an account whose turn failed too, so neither spins.
// - No timer runs before start(); its stop function clears the timer, ends the running pass at its next slice and
//   waits for it, so the database can be closed right after. Nothing here queues AI work.

/** Due rows one account settles before the next account's turn. */
const TURN_ROWS = 25;
/** Due rows read at a time. */
const BATCH = 100;
/** Accounts read at a time (the rest come in the next round). */
const USERS_PER_ROUND = 1000;
/** Failed rows and accounts remembered (the oldest are forgotten past it). */
const FAILURES_MAX = 10_000;

/** Cooperative time slices: work runs for at most `sliceMs` at a time, then the event loop gets a turn. */
export class Slicer {
  private sliceStart = performance.now();
  private readonly deadline: number;

  constructor(
    private readonly sliceMs: number,
    private readonly options: { budgetMs?: number; signal?: AbortSignal; halted?: () => boolean } = {},
  ) {
    const budget = options.budgetMs;
    this.deadline =
      typeof budget === 'number' && Number.isFinite(budget) ? performance.now() + Math.max(0, budget) : Number.POSITIVE_INFINITY;
  }

  /** The run is out of time, aborted, or its worker is stopping: start nothing new. */
  get over(): boolean {
    return performance.now() >= this.deadline || this.options.signal?.aborted === true || this.options.halted?.() === true;
  }

  /** Gives the event loop a turn when this slice has run its share; resolves at once otherwise. */
  async pause(): Promise<void> {
    if (performance.now() - this.sliceStart < this.sliceMs) return;
    await yieldToEventLoop();
    this.sliceStart = performance.now();
  }
}

export interface MatchWorker {
  /** Settles every due row it can now (cooperative); returns how many. */
  runDue(options?: { budgetMs?: number }): Promise<number>;
  /** A pass soon (once started). */
  nudge(): void;
  /** Starts the timer; returns the stop function (it ends a running pass at its next slice and waits for it). */
  start(): () => Promise<void>;
}

export function createMatchWorker(deps: AppDeps, core: MatchCore, timing: MatchTiming): MatchWorker {
  const { log, db } = deps;
  /** Rows and accounts that failed lately -> when they may be tried again (wall clock). */
  const failedRows = new Map<string, number>();
  const failedUsers = new Map<string, number>();
  let halted = false;
  let schedule: ((delayMs: number) => void) | null = null;
  let stopping: (() => Promise<void>) | null = null;

  const d = db.dialect;
  const sql = {
    // `resume_match_due = <true>` is the partial index idx_app_match_due's own predicate on both engines (SQLite's
    // `= 1`; PostgreSQL folds `= true` into the bare flag). The alias is quoted (PostgreSQL folds an unquoted one to
    // lower case). The account whose due row is oldest comes first: the smallest insert order (`seq`, v3.0 PG-E:
    // SQLite's rowid) of its due rows.
    users: `SELECT a.user_id AS "userId" FROM applications a JOIN users u ON u.id = a.user_id
       WHERE a.resume_match_due = ${d.true} AND u.disabled_at IS NULL
       GROUP BY a.user_id ORDER BY min(${d.seq('a')}) LIMIT ?`,
    rows: `SELECT id FROM applications WHERE user_id = ? AND resume_match_due = ${d.true} AND id > ? ORDER BY id LIMIT ?`,
  };

  const waiting = (failures: Map<string, number>, key: string): boolean => {
    const until = failures.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    failures.delete(key);
    return false;
  };

  const fail = (failures: Map<string, number>, key: string): void => {
    failures.delete(key);
    failures.set(key, Date.now() + timing.retryFailedMs);
    if (failures.size > FAILURES_MAX) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
  };

  /**
   * One account's turn: up to TURN_ROWS of its due rows. Returns how many it settled. Its resumes are read first, so
   * a failure there is the account's (the caller logs it and lets the account wait), not one row's.
   */
  async function turn(matcher: UserMatcher, slicer: Slicer, skipped: Set<string>): Promise<number> {
    await matcher.candidates(slicer);
    let settled = 0;
    let tried = 0;
    let cursor = '';
    while (tried < TURN_ROWS && !slicer.over) {
      const ids = await db.all<{ id: string }>(sql.rows, [matcher.userId, cursor, BATCH]);
      if (ids.length === 0) break;
      for (const { id } of ids) {
        cursor = id;
        if (skipped.has(id) || waiting(failedRows, id)) continue;
        tried += 1;
        let outcome: Settled | null = null;
        try {
          outcome = await core.settle(matcher, id, slicer, 'auto');
        } catch (error) {
          log.warn(`[resume-match] could not choose a resume for application ${id}; it is tried again later`, error);
        }
        if (outcome === 'matched' || outcome === 'released') {
          settled += 1;
          failedRows.delete(id);
        } else if (outcome === null || outcome === 'refused') {
          if (outcome === 'refused') log.warn(`[resume-match] the choice for application ${id} was refused; it is tried again later`);
          skipped.add(id);
          fail(failedRows, id);
        }
        if (tried >= TURN_ROWS || slicer.over) break;
      }
    }
    return settled;
  }

  /** Rounds of account turns until no due row is left that can be settled now (or the run is over). */
  async function drain(slicer: Slicer): Promise<number> {
    let settled = 0;
    const skipped = new Set<string>();
    const skippedUsers = new Set<string>();
    const matchers = new Map<string, UserMatcher>();
    while (!slicer.over) {
      const users = (await db.all<{ userId: string }>(sql.users, [USERS_PER_ROUND]))
        .map((row) => row.userId)
        .filter((userId) => !skippedUsers.has(userId) && !waiting(failedUsers, userId));
      if (users.length === 0) break;
      let progressed = false;
      for (const userId of users) {
        if (slicer.over) break;
        let matcher = matchers.get(userId);
        if (!matcher) {
          matcher = core.matcherFor(userId);
          matchers.set(userId, matcher);
        }
        try {
          const count = await turn(matcher, slicer, skipped);
          if (count > 0) {
            settled += count;
            progressed = true;
          }
        } catch (error) {
          log.warn(`[resume-match] a slice for account ${userId} failed; it is tried again later`, error);
          skippedUsers.add(userId);
          fail(failedUsers, userId);
        }
      }
      if (!progressed) break;
    }
    return settled;
  }

  return {
    runDue(options = {}) {
      return drain(new Slicer(timing.sliceMs, { budgetMs: options.budgetMs, halted: () => halted }));
    },

    nudge() {
      try {
        schedule?.(timing.nudgeMs);
      } catch (error) {
        log.warn('[resume-match] could not wake the worker', error);
      }
    },

    start() {
      if (stopping) return stopping;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      let running: Promise<void> | null = null;
      let again = false;
      const run = () => {
        timer = null;
        dueAt = Number.POSITIVE_INFINITY;
        if (halted) return;
        if (running) {
          again = true;
          return;
        }
        running = (async () => {
          try {
            await drain(new Slicer(timing.sliceMs, { halted: () => halted }));
          } catch (error) {
            log.warn('[resume-match] a pass failed; the worker carries on', error);
          } finally {
            running = null;
            const next = again ? timing.nudgeMs : timing.pollMs;
            again = false;
            schedule?.(next);
          }
        })();
      };
      // Timers use the wall clock (the app's clock is frozen in tests); the choices read deps.now().
      schedule = (delayMs) => {
        if (halted) return;
        const at = Date.now() + delayMs;
        if (timer && dueAt <= at) return;
        if (timer) clearTimeout(timer);
        dueAt = at;
        timer = setTimeout(() => {
          try {
            run();
          } catch (error) {
            log.warn('[resume-match] the worker timer failed; it carries on', error);
            schedule?.(timing.pollMs);
          }
        }, delayMs);
        timer.unref?.();
      };
      schedule(timing.firstRunMs);
      stopping = async () => {
        halted = true;
        schedule = null;
        if (timer) clearTimeout(timer);
        timer = null;
        await running;
      };
      return stopping;
    },
  };
}
