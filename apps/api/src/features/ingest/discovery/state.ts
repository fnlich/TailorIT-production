import { dayKeyAt } from '../../../core/constants/day';
import type { AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';

// v30 S2: discovery's bookkeeping (migration 0020): each signal's progress (discovery_state: the link sweep's high-water
// marks, Common Crawl's crawl and page) and the exact per-day counts its caps read (discovery_counters: validation
// reads under DISCOVERY_VALIDATIONS_PER_DAY, name probes per host under DISCOVERY_PROBES_PER_HOST_PER_DAY). A count is
// claimed one at a time with one conditional statement, so two processes (or two lanes of one pass) never pass a cap.

/** The counter of the day's validation reads. */
export const VALIDATIONS_COUNTER = 'validations';
/** The counter of the day's name probes to one host. */
export const probeCounter = (host: string) => `probe:${host}`;
/** Counters are kept this many days (the funnel reads today's; older ones only show the trend). */
export const COUNTER_HISTORY_DAYS = 31;

/**
 * v30 FIX-A (REV-BEH BEH-12): the caps' day is the day key (11 §1 item 8: DAY_RESET_TIME in DAY_RESET_TIME_ZONE, 12:00
 * AM Pacific Time by default), as every other "today" (the AI budgets, the report cap, the re-checks), never the UTC
 * date (which turned over at 4-5 PM Pacific Time).
 */
export const discoveryDayOf = (deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, at: Date = deps.now()) => dayKeyAt(deps, at);

/** A signal's progress, or null before its first pass. */
export async function readState<T>(db: DbQueries, key: string): Promise<T | null> {
  // jsonb reads as its text (core/db/pg/types.ts).
  const row = await db.one<{ value: string }>('SELECT value FROM discovery_state WHERE key = ?', [key]);
  return row ? (JSON.parse(row.value) as T) : null;
}

/**
 * A signal's progress, locked until the caller's transaction ends (made with `initial` when there is none), so two
 * passes at once (two processes) take turns instead of both reading one mark.
 */
export async function lockState<T>(t: DbQueries, key: string, initial: T, at: string): Promise<T> {
  await t.run(
    `INSERT INTO discovery_state(key, value, updated_at) VALUES (?, CAST(? AS jsonb), CAST(? AS timestamptz)) ON CONFLICT (key) DO NOTHING`,
    [key, JSON.stringify(initial), at],
  );
  const row = await t.one<{ value: string }>('SELECT value FROM discovery_state WHERE key = ? FOR UPDATE', [key]);
  return { ...initial, ...(JSON.parse(row!.value) as T) };
}

/** Writes a signal's progress (in the caller's transaction, with what it records). */
export async function writeState(db: DbQueries, key: string, value: unknown, at: string): Promise<void> {
  await db.run(
    `INSERT INTO discovery_state(key, value, updated_at) VALUES (?, CAST(? AS jsonb), CAST(? AS timestamptz))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), at],
  );
}

/** A counter's value on a day (0 when nothing was counted). */
export async function counterOf(db: DbQueries, day: string, counter: string): Promise<number> {
  return (await db.one<{ value: number }>('SELECT value FROM discovery_counters WHERE day = CAST(? AS date) AND counter = ?', [day, counter]))?.value ?? 0;
}

/**
 * Counts one more on the day's counter unless it reached `cap`: true when counted. One statement, so two claims at
 * once take two places and never the cap's last one twice. A cap of 0 or less counts nothing.
 */
export async function claimCount(db: DbQueries, day: string, counter: string, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const row = await db.one<{ value: number }>(
    `INSERT INTO discovery_counters AS c (day, counter, value) VALUES (CAST(@day AS date), @counter, 1)
     ON CONFLICT (day, counter) DO UPDATE SET value = c.value + 1 WHERE c.value < CAST(@cap AS integer)
     RETURNING value`,
    { day, counter, cap },
  );
  return row !== null && row !== undefined;
}

/** Gives back a place claimed for a read that was never sent (its host was held). */
export async function releaseCount(db: DbQueries, day: string, counter: string): Promise<void> {
  await db.run('UPDATE discovery_counters SET value = value - 1 WHERE day = CAST(? AS date) AND counter = ? AND value > 0', [day, counter]);
}

/** Deletes counters older than COUNTER_HISTORY_DAYS (a daily step's part). Answers how many went. */
export async function pruneCounters(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): Promise<number> {
  const before = discoveryDayOf(deps, new Date(deps.now().getTime() - COUNTER_HISTORY_DAYS * 86_400_000));
  return (await deps.db.run('DELETE FROM discovery_counters WHERE day < CAST(? AS date)', [before])).changes;
}
