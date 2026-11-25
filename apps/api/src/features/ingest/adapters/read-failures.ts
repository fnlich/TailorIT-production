import { HOUR_MS } from '@tailorit/shared';
import type { DbQueries } from '../../../core/db/types';

// v37 FIX-37A (SP v37 FIXES-37, REVIEW37-beh F8): the postings of a source whose own read failed lately, so a run reads
// them after the others and backs them off. A BambooHR opening (or an iCIMS posting) whose detail keeps failing used
// to stay at the head of every run's plan: new postings are read first, and a failed read stores nothing, so it was new
// again next run. Five such openings at the top of a list stopped every BambooHR run (BAMBOOHR_FAILURES_IN_A_ROW)
// before any other opening was read; on iCIMS they took the run's whole budget.
//
// Kept on the source's row (job_sources.read_failures, migration 0063): `{ "<posting id>": [failures, "<ISO time of the
// last>"] }`. A posting with an entry waits READ_FAILURE_BACKOFF_FIRST_MS after its first failure, twice as long after
// each further one, at most READ_FAILURE_BACKOFF_MAX_MS; once due it is read after every posting with no entry. A read
// that answers (the posting, or gone) clears its entry; an entry whose posting is no longer listed is dropped; at most
// READ_FAILURES_MAX_ENTRIES entries are kept (the latest).

/** The wait after a posting's first failed read. */
export const READ_FAILURE_BACKOFF_FIRST_MS = 6 * HOUR_MS;
/** The longest wait between two reads of a posting whose reads keep failing. */
export const READ_FAILURE_BACKOFF_MAX_MS = 7 * 24 * HOUR_MS;
/** The most entries one source keeps. */
export const READ_FAILURES_MAX_ENTRIES = 1000;

/** One posting's failed reads: how many in a row, and when the last was (ms). */
export interface ReadFailure {
  failures: number;
  at: number;
}

export type ReadFailures = ReadonlyMap<string, ReadFailure>;

/** The source's entries (an unreadable entry is skipped). */
export async function loadReadFailures(db: DbQueries, sourceId: number): Promise<Map<string, ReadFailure>> {
  const row = await db.one<{ read_failures: unknown }>('SELECT read_failures FROM job_sources WHERE id = ?', [sourceId]);
  const map = new Map<string, ReadFailure>();
  let stored = row?.read_failures;
  if (typeof stored === 'string') {
    try {
      stored = JSON.parse(stored) as unknown; // jsonb as the driver answers it (text)
    } catch {
      return map;
    }
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return map;
  for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const failures = Number(value[0]);
    const at = typeof value[1] === 'string' ? Date.parse(value[1]) : NaN;
    if (Number.isInteger(failures) && failures > 0 && Number.isFinite(at)) map.set(id, { failures, at });
  }
  return map;
}

/** When a posting with this entry may be read again (ms). */
export function readAgainAt(entry: ReadFailure): number {
  const wait = Math.min(READ_FAILURE_BACKOFF_MAX_MS, READ_FAILURE_BACKOFF_FIRST_MS * 2 ** Math.min(entry.failures - 1, 20));
  return entry.at + wait;
}

/**
 * The due postings in the order a run reads them (see the top): those with no entry, in their order, then those whose
 * wait is over (the fewest failures first, then the longest waiting); the ones still waiting are left out (counted).
 */
export function orderByFailures<T>(items: readonly T[], idOf: (item: T) => string, failures: ReadFailures, now: number): { ordered: T[]; waiting: number } {
  const clean: T[] = [];
  const due: Array<{ item: T; entry: ReadFailure }> = [];
  let waiting = 0;
  for (const item of items) {
    const entry = failures.get(idOf(item));
    if (!entry) clean.push(item);
    else if (readAgainAt(entry) <= now) due.push({ item, entry });
    else waiting += 1;
  }
  due.sort((a, b) => a.entry.failures - b.entry.failures || a.entry.at - b.entry.at);
  return { ordered: [...clean, ...due.map((each) => each.item)], waiting };
}

/**
 * The source's entries after a run: one more failure for each id in `failed` (at `now`), none for each id in
 * `answered`, and none for an id `keep` says is no longer listed. Writes only when something changed.
 */
export async function saveReadFailures(
  db: DbQueries,
  sourceId: number,
  before: ReadFailures,
  run: { failed: readonly string[]; answered: readonly string[]; keep: (id: string) => boolean; now: number },
): Promise<void> {
  const next = new Map<string, ReadFailure>();
  for (const [id, entry] of before) if (run.keep(id)) next.set(id, entry);
  for (const id of run.answered) next.delete(id);
  for (const id of run.failed) next.set(id, { failures: (before.get(id)?.failures ?? 0) + 1, at: run.now });
  const kept = [...next.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, READ_FAILURES_MAX_ENTRIES);
  const same = kept.length === before.size && kept.every(([id, entry]) => before.get(id)?.failures === entry.failures && before.get(id)?.at === entry.at);
  if (same) return;
  const json = Object.fromEntries(kept.map(([id, entry]) => [id, [entry.failures, new Date(entry.at).toISOString()]]));
  await db.run('UPDATE job_sources SET read_failures = CAST(? AS jsonb) WHERE id = ?', [JSON.stringify(json), sourceId]);
}
