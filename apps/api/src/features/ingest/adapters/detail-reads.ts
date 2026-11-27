import { DAY_MS } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
// The one close function (core/seams re-exports it from here; a test's vi.mock of this path reaches this import too).
import { closeLink } from '../close';
import { HostHeldError, IngestHttpError } from '../http';
import { holdOf } from '../hosts';
import { storedSourceJobId } from '../normalize';
import { RobotsRefusal } from '../robots';
import { IngestError, type AdapterContext, type FetchFailure, type FetchResult, type RawPosting, type SourceRecord } from '../types';
import { loadReadFailures, orderByFailures, saveReadFailures, type ReadFailures } from './read-failures';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 7): a run of a board whose list names its postings without their text (a
// Rippling board), as a BambooHR run reads its openings (v37 BOARDS B1; adapters/bamboohr.ts, which keeps its own copy):
// the list, then each planned posting's own record, at most `budget` a run, in turn: the ones TailorIT has not stored
// for this source (new, in the list's order), those whose link is closed (listed again: read to reopen), then those not
// read for `recheckMs` (the oldest first); a posting whose read failed lately is read after them and backed off
// (adapters/read-failures.ts). The rest of the list is seen (skippedIds): never wiped (a posting sent without its text
// would lose its stored text) and never closed while the list names it. A record that is gone (the platform's 404)
// closes its link through the one close function (reason `gone`), and its job once no live link is left; the list,
// complete, still closes a posting it no longer names after two misses (store.ts markMissing). A held host (or lane),
// a 429 past the request's own retries, or a robots.txt that cannot be read stops the reads (the run keeps what it read,
// its listing incomplete: nothing closes by absence); `failuresInARow` failed reads in a row stop them the same way.
// v38 FIX-A (SP v38 FIXES-38 D9, REVIEW38-beh M9; as adapters/listed-reads.ts): a listed posting whose own record says it
// is gone while TailorIT has no open link of it (never stored, or closed) would be new (or closed) to every run and read
// before the stale ones: it is backed off as a failed read is (read after the others, less often), never counted a
// failure.

/** One of the source's links as the plan reads it. */
export interface DetailStoredLink {
  source_job_id: string;
  job_id: number;
  live: boolean;
  /** When it was last read: its last sighting or its last read of its own (the later), ISO. */
  read_at: string;
}

/**
 * The listed postings a run reads, in order (see the top): new ones in the list's order, those whose link is closed,
 * then those last read `recheckMs` ago or more, the oldest first; at most `budget`. `left`: the listed postings this run
 * does not read (seen); `dueLeft`: the due ones among them (past the budget, or waiting after a failed read).
 */
export function planDetailReads(
  listed: readonly string[],
  stored: ReadonlyMap<string, DetailStoredLink>,
  options: { now: number; budget: number; recheckMs: number; failures?: ReadFailures },
): { read: string[]; left: string[]; dueLeft: number } {
  const fresh: string[] = [];
  const unread: string[] = [];
  const closed: string[] = [];
  const stale: DetailStoredLink[] = [];
  for (const id of listed) {
    const link = stored.get(id);
    if (!link) unread.push(id);
    else if (!link.live) closed.push(id);
    else if (options.now - Date.parse(link.read_at) >= options.recheckMs) stale.push(link);
    else fresh.push(id);
  }
  stale.sort((a, b) => a.read_at.localeCompare(b.read_at) || a.source_job_id.localeCompare(b.source_job_id));
  const due = [...unread, ...closed, ...stale.map((link) => link.source_job_id)];
  const { ordered } = orderByFailures(due, (id) => id, options.failures ?? new Map(), options.now);
  const read = ordered.slice(0, Math.max(0, options.budget));
  const reading = new Set(read);
  return { read, left: [...fresh, ...due.filter((id) => !reading.has(id))], dueLeft: due.length - read.length };
}

/** The source's links of the listed postings (live or closed), with when each was last read. */
export async function detailStoredLinks(db: DbQueries, sourceId: number, listed: readonly string[]): Promise<Map<string, DetailStoredLink>> {
  const rows = await db.all<{ source_job_id: string; job_id: number; live: boolean; read_at: string | Date }>(
    `SELECT l.source_job_id, l.job_id, l.missing_since IS NULL AS live,
       GREATEST(l.last_seen_at, l.liveness_checked_at) AS read_at
     FROM job_source_links l
     WHERE l.source_id = ? AND l.source_job_id IN (SELECT value FROM ${db.dialect.jsonEach('?')})`,
    [sourceId, JSON.stringify(listed)],
  );
  return new Map(rows.map((row) => [row.source_job_id, { ...row, live: row.live === true, read_at: new Date(row.read_at).toISOString() }]));
}

/** A read's failure as a sentence. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a detail-read run needs of its platform. */
export interface DetailReadsSpec {
  /** The platform in words, in the run's log ("Rippling"). */
  label: string;
  /** The host the records are read from (its hold, or its lane's, is the run's next due time after a 429). */
  host: string;
  /** Most records read a run, and how long a listed one goes before it is read again. */
  budget: number;
  recheckMs: number;
  /** Failed reads in a row that stop the reads. */
  failuresInARow: number;
  /** One posting's record: the posting, or null when it is gone (the platform's 404). Throws when the read fails. */
  read(id: string, signal: AbortSignal): Promise<RawPosting | null>;
}

/** The recheck time of a source's detail reads in days, as a time span (a constant read at each run). */
export const recheckSpanOf = (days: number) => days * DAY_MS;

/**
 * The run's reads of the listed postings' records and what they found (see the top): `listed` is the list's ids in its
 * order (stored form), `complete` whether the list was whole. Answers the FetchResult of the run.
 */
export async function readListedDetails(
  source: SourceRecord,
  ctx: AdapterContext,
  listed: readonly string[],
  complete: boolean,
  failures: FetchFailure[],
  spec: DetailReadsSpec,
): Promise<FetchResult> {
  const deps: AppDeps = ctx.deps;
  const signal = ctx.signal;
  const stored = await detailStoredLinks(deps.db, source.id, listed);
  const readFailures = await loadReadFailures(deps.db, source.id);
  const { read, left, dueLeft } = planDetailReads(listed, stored, {
    now: deps.now().getTime(),
    budget: spec.budget,
    recheckMs: spec.recheckMs,
    failures: readFailures,
  });
  const postings: RawPosting[] = [];
  const seen = [...left];
  const checked: string[] = [];
  const gone: DetailStoredLink[] = [];
  const answered: string[] = [];
  const recordFailed: string[] = [];
  const backedOff: string[] = []; // v38 FIX-A (M9): gone by their record, no open link: read later, less often
  let attempted = 0;
  let goneUnstored = 0;
  let failedInARow = 0;
  let whole = complete;
  let stopped: string | null = null;
  let heldUntil: string | null = null;
  for (const [index, id] of read.entries()) {
    if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
    const link = stored.get(id) ?? null;
    attempted += 1;
    try {
      const posting = await spec.read(id, signal);
      failedInARow = 0;
      if (link) checked.push(id);
      if (posting) {
        postings.push(posting);
        answered.push(id);
      } else if (link?.live) {
        gone.push(link);
        answered.push(id);
      } else {
        // v38 FIX-A (M9): listed, yet gone by its own record, and no open link of it: backed off (see the top).
        goneUnstored += 1;
        backedOff.push(id);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // A 429 past the request's retries (no hold of its own) stops the reads as a held host does.
      const rateLimited = error instanceof IngestHttpError && !(error instanceof HostHeldError) && error.status === 429;
      if (error instanceof HostHeldError || rateLimited || (error instanceof RobotsRefusal && error.reason === 'unreadable')) {
        if (!rateLimited) attempted -= 1;
        stopped = messageOf(error);
        whole = false;
        seen.push(...read.slice(index));
        if (error instanceof HostHeldError) heldUntil = error.until;
        else if (rateLimited) heldUntil = (await holdOf(deps.db, spec.host, nowIso(deps)))?.until ?? null;
        break;
      }
      // Counted as seen (a failure's id), so it is never closed for a read that failed; read again next run.
      const status = error instanceof IngestHttpError ? ` (HTTP ${error.status})` : '';
      failures.push({ sourceJobId: id, message: `Posting ${id} could not be read${status}.` });
      recordFailed.push(id);
      failedInARow += 1;
      if (failedInARow >= spec.failuresInARow) {
        whole = false;
        seen.push(...read.slice(index + 1));
        stopped = `${spec.label} failed ${spec.failuresInARow} reads in a row.`;
        break;
      }
    }
  }

  if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
  const at = nowIso(deps);
  if (checked.length > 0) {
    await deps.db.run(
      `UPDATE job_source_links SET liveness_checked_at = CAST(? AS timestamptz)
       WHERE source_id = ? AND source_job_id IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})`,
      [at, source.id, JSON.stringify(checked)],
    );
  }
  let jobsClosed = 0;
  if (gone.length > 0) {
    await deps.db.tx(
      async (t) => {
        for (const link of gone) {
          const closed = await closeLink(deps, t, { jobId: link.job_id, link: { sourceId: source.id, sourceJobId: link.source_job_id }, reason: 'gone', at });
          if (closed.jobClosed) jobsClosed += 1;
        }
      },
      { label: `${spec.label.toLowerCase()}: postings gone` },
    );
  }
  ctx.log(
    `Read ${attempted} of ${read.length} planned postings: ${postings.length} stored, ${gone.length} gone ` +
      `(${jobsClosed} jobs closed)${goneUnstored ? `, ${goneUnstored} more gone (none of them open here)` : ''}` +
      `${recordFailed.length ? `, ${recordFailed.length} failed` : ''}; ${left.length} left as they are.`,
  );
  if (stopped) ctx.log(`The reads stopped early, so nothing closes by its absence this run: ${stopped}`);
  const listedIds = new Set(listed);
  await saveReadFailures(deps.db, source.id, readFailures, {
    failed: [...recordFailed, ...backedOff], // v38 FIX-A (M9)
    answered,
    keep: (id) => listedIds.has(id),
    now: deps.now().getTime(),
  });
  if (whole && (dueLeft > 0 || recordFailed.length > 0)) ctx.log('Postings are still due a read; the next runs read them.');
  return {
    postings,
    complete: whole,
    failures,
    skippedIds: seen,
    validators: null,
    closedByRead: jobsClosed,
    ...(heldUntil ? { heldUntil } : {}),
  };
}

/** The stored form of a listed posting's id (job_source_links.source_job_id). */
export const listedIdOf = (id: string) => storedSourceJobId(id);
