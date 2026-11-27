import { nowIso, type AppDeps } from '../../../core/context';
// The one close function (core/seams re-exports it from here; a test's vi.mock of this path reaches this import too).
import { closeLink } from '../close';
import { HostHeldError, IngestHttpError } from '../http';
import { holdOf } from '../hosts';
import { storedSourceJobId } from '../normalize';
import { RobotsRefusal } from '../robots';
import { IngestError, type AdapterContext, type FetchFailure, type FetchResult, type RawPosting, type SourceRecord } from '../types';
import { planBamboohrReads, type BamboohrStoredLink } from './bamboohr';
import { loadReadFailures, saveReadFailures } from './read-failures';

// v38 ATS-B: a board whose list names its postings without their text (Oracle Recruiting Cloud's requisition list, ADP's
// job requisitions, Join.com's company page, Recruiterflow's jobs list; a Zoho Recruit record that came without its
// description) is run as BambooHR's is (v37 BOARDS B1, adapters/bamboohr.ts): the list, then each posting's own read, at
// most a budget a run, in this order: the postings TailorIT has not stored for this source (new, in the list's order),
// those whose link is closed (listed again: read to reopen), then those not read for the recheck days (the oldest first);
// a posting whose read failed lately after the others, backed off (adapters/read-failures.ts). The rest of the list is
// seen (skippedIds: never wiped, since a posting sent without its text would lose its stored text), and never closed
// while the list names it. A posting whose own read says it is gone closes its link through the one close function
// (closeLink, reason `gone`), and its job once no live link is left; a whole list still closes a posting it no longer
// names after two misses (store.ts markMissing). A held host, an unreadable robots.txt or a 429 past the request's own
// retries stops the reads (the run keeps what it read, its listing incomplete, and answers the host's hold); after
// LISTED_READ_FAILURES_IN_A_ROW failed reads in a row the run stops the same way. Postings the list gives whole (with
// their text) are stored as listed, read no more.

/** A run stops after this many failed reads of postings in a row. */
export const LISTED_READ_FAILURES_IN_A_ROW = 5;

/** What one board's run of list-then-read gives the runner. */
export interface ListedReads {
  /** The board in the log's words ("Oracle site acme.fa.us2.oraclecloud.com/CX_1"). */
  label: string;
  /** The host the reads go to (a 429's hold is looked up there). */
  host: string;
  /** The list's postings by id, in the list's order (a listing's fields: title, place, link). */
  listed: ReadonlyMap<string, RawPosting>;
  /** Whether the list is the board's whole list (a posting it does not name may close by absence). */
  whole: boolean;
  /** The list's own failures (an entry with no id or title). */
  failures: FetchFailure[];
  /** A listed posting that came whole (its text with it): stored as listed, never read on its own. Default: none. */
  isWhole?: (posting: RawPosting) => boolean;
  /** One posting's own read: the posting, or null when it is gone. Throws as the platform's reads throw. */
  read: (id: string, listed: RawPosting) => Promise<RawPosting | null>;
  /** The reads a run makes at most, and how long a posting read stays fresh (ms). */
  budget: number;
  recheckMs: number;
}

/** The source's links of the listed postings (live or closed), with when each was last read. */
async function storedLinks(deps: Pick<AppDeps, 'db'>, sourceId: number, listed: readonly string[]): Promise<Map<string, BamboohrStoredLink>> {
  const db = deps.db;
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

/**
 * One run of a list-then-read board (see the top). The admin's Test and discovery's validation (`listingOnly`, or a
 * source not stored) get the list alone, as listed.
 */
export async function runListedReads(source: SourceRecord, ctx: AdapterContext, spec: ListedReads): Promise<FetchResult> {
  const failures = [...spec.failures];
  const runs = !ctx.listingOnly && source.id > 0;
  if (!runs) return { postings: [...spec.listed.values()], complete: spec.whole, failures };

  const deps = ctx.deps;
  const signal = ctx.signal;
  const postings: RawPosting[] = [];
  // Stored ids (storedSourceJobId) of the postings that need a read of their own, and their listing.
  const toRead = new Map<string, RawPosting>();
  for (const [id, posting] of spec.listed) {
    if (spec.isWhole?.(posting)) postings.push(posting);
    else toRead.set(storedSourceJobId(id), posting);
  }
  const ids = [...toRead.keys()];
  const stored = ids.length > 0 ? await storedLinks(deps, source.id, ids) : new Map<string, BamboohrStoredLink>();
  const readFailures = await loadReadFailures(deps.db, source.id);
  const { read, left, dueLeft } = planBamboohrReads(ids, stored, {
    now: deps.now().getTime(),
    budget: spec.budget,
    recheckMs: spec.recheckMs,
    failures: readFailures,
  });
  const seen = [...left];
  const checked: string[] = [];
  const gone: BamboohrStoredLink[] = [];
  const answered: string[] = [];
  const readFailed: string[] = [];
  let attempted = 0;
  let goneUnstored = 0;
  let failedInARow = 0;
  let complete = spec.whole;
  let stopped: string | null = null;
  let heldUntil: string | null = null;
  for (const [index, id] of read.entries()) {
    if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
    const link = stored.get(id) ?? null;
    attempted += 1;
    try {
      const posting = await spec.read(id, toRead.get(id)!);
      failedInARow = 0;
      if (link) checked.push(id);
      if (posting) {
        postings.push(posting);
        answered.push(id);
      } else if (link?.live) {
        gone.push(link);
        answered.push(id);
      } else {
        // Listed, yet its own read says gone, and never stored (or closed): it would be new to every run and read before
        // the stale ones; backed off as a failed read is (read after the others, less often), never counted a failure.
        goneUnstored += 1;
        readFailed.push(id);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      // A 429 past the request's own retries (no hold of its own) stops the reads as a held host does.
      const rateLimited = error instanceof IngestHttpError && !(error instanceof HostHeldError) && error.status === 429;
      if (error instanceof HostHeldError || rateLimited || (error instanceof RobotsRefusal && error.reason === 'unreadable')) {
        if (!rateLimited) attempted -= 1;
        stopped = messageOf(error);
        complete = false;
        seen.push(...read.slice(index));
        if (error instanceof HostHeldError) heldUntil = error.until;
        else if (rateLimited) heldUntil = (await holdOf(deps.db, spec.host, nowIso(deps)))?.until ?? null;
        break;
      }
      // Counted as seen (a failure's id), so it never closes for a read that failed; read again next run.
      const status = error instanceof IngestHttpError ? ` (HTTP ${error.status})` : '';
      failures.push({ sourceJobId: id, message: `Posting ${id} could not be read${status}.` });
      readFailed.push(id);
      failedInARow += 1;
      if (failedInARow >= LISTED_READ_FAILURES_IN_A_ROW) {
        complete = false;
        seen.push(...read.slice(index + 1));
        stopped = `${spec.label}: ${LISTED_READ_FAILURES_IN_A_ROW} reads failed in a row.`;
        break;
      }
    }
  }

  // The postings read get their read time; the gone ones close (their jobs once no live link is left).
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
      { label: 'listed board: postings gone' },
    );
  }
  ctx.log(
    `${spec.label}: read ${attempted} of ${read.length} planned postings: ${postings.length} stored, ${gone.length} gone ` +
      `(${jobsClosed} jobs closed)${goneUnstored ? `, ${goneUnstored} more gone (none of them open here)` : ''}` +
      `${failures.length ? `, ${failures.length} failed` : ''}; ${left.length} left as they are.`,
  );
  if (stopped) ctx.log(`The reads stopped early, so nothing closes by its absence this run: ${stopped}`);
  const listedIds = new Set(ids);
  await saveReadFailures(deps.db, source.id, readFailures, { failed: readFailed, answered, keep: (id) => listedIds.has(id), now: deps.now().getTime() });
  if (complete && dueLeft > 0) ctx.log('Postings are still due a read; the next run reads them.');
  return {
    postings,
    complete,
    failures,
    skippedIds: seen,
    closedByRead: jobsClosed,
    ...(heldUntil ? { heldUntil } : {}),
  };
}
