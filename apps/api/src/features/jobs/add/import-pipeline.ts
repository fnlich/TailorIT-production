import {
  canonicalJobUrl,
  HOUR_MS,
  jobReviewSubject,
  JobRowDetailsSchema,
  linkKey,
  rowHasTitleAndCompany,
  type JobAddOrigin,
  type JobRowDetails,
  type JobVerifyReason,
} from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { aliasValueHash } from '../../autofill/alias-key';
import { heldJobOf, newInFlight } from '../../autofill/jobs';
import { findPageJob, readPage } from '../../autofill/lookup';
import { rememberImportBoard, type ImportBoardInput } from '../../ingest/import-sources'; // v35 INT-A: ADMIN's
import { getSourceRecord } from '../../ingest/sources';
import { IngestError } from '../../ingest/types';
import { reopenReview } from '../../job-reviews/decide'; // v35 FIX-PIPE (data D4)
import { isRefusedPageHost } from '../../job-reviews/hosts';
import { noteImportedHold } from '../../job-reviews/new-jobs'; // v35 INT-A: ADMIN's
import { reviewById } from '../../job-reviews/store'; // v35 FIX-PIPE (data D4)
import { sharedAddress } from './address';
import { closeGoneJob, fillPayFromRate, fillReadPosting, holdImported, jobFromRow, repostJob } from './import-jobs';
import { dateImported } from './import-time'; // v36 IMPORTTIME
import { pastedLinksSource, type QueueOutcome } from './import-store';
import { retireLegacyJob } from './legacy';
import type { ImportRead } from './page';
import { addJobByLink, isAddableLink, readLink, type LinkRead } from './pipeline';
import { listedSql, rejectionCovers } from './verification'; // v37 INT-A: listedSql (REVIEW's R5), as the list
import { legacyHeld } from './held'; // v37 CLOSED (C2)
import { embeddedImportBoardOf, importBoardOfLink } from './closed-link'; // v37 CLOSED (C7); v381 EMBED: embeddedImportBoardOf
import { TRY_LATER_REASONS } from './verdict'; // v37 CLOSED (C1)

// v35 IMPORT (SP v35 PLAN.md H2, H4, H5): what TailorIT's read of an import's queued link does, in the link queue's
// worker (queue.ts settle), never inside a request.
//
// An admin's import (the queue row has no profile):
//   1. A job TailorIT has (Add job's matching: the ATS posting, the link's keys and aliases), by its state (H5):
//      - held, waiting for review: "Already waiting for review" (`known`), no repost;
//      - open, last read within 24 hours: reposted at once;
//      - open, read longer ago: read again: live, reposted (the read refreshed it); gone, closed (`closed`);
//        unreadable, reposted all the same (the admin vouches);
//      - closed: read again: live, reopened (the read) and reposted; gone, it stays closed; unreadable, reopened HELD for
//        Review › Couldn't verify (an approval publishes and reposts it).
//   2. Else TailorIT's read (an ATS's API, else the page's JobPosting), as Add job reads:
//      - read: the read's job, published or held as today (`added`; a job the store's dedupe found: reposted); the
//        row's Rate is its pay when the read has none (H4); its board is remembered for ADMIN's Sources found (H6);
//        v35 INT-A: the row fills what the read lacks (its location, its description; the title or the employer:
//        import-jobs.ts fillReadPosting), and a new job the read holds for New jobs is the import's from the start (its
//        review marked imported, with the run: page.ts ImportRead), so it waits for its approval before the AI analysis;
//      - closed: `closed`, nothing added;
//      - unreadable (after the queue's tries for a failure for now): with a title and a company, a held shared job made
//        from the row with a "Couldn't verify" note (no adder, origin `import`): `review`; without, nothing is kept:
//        `needs_details`. LinkedIn and the refused boards are `failed` ("Can't import from <host>").
//   A link an admin rejected comes back (H3: the admin asked): its rejection is lifted before the read.
// v35 FIX-PIPE (the final review's data and sec findings; the coordinator's decisions 4 and 5):
//   - D1: a repost of an open job that had left search as unverified brings it back at once; an admin's vouch (no read)
//     writes or renews its approval (import-jobs.ts repostJob), so the sweep takes it out ADMIN_APPROVED_JOB_DAYS later
//     unless a source lists it;
//   - D4: "Already waiting for review" only while a review waits (a pending New jobs review, a listed Couldn't verify
//     note); a held job nothing waits on (its New jobs review rejected) is back in review (heldAgain);
//   - D6: an unreadable row joins a job TailorIT has only by an exact match (its keys, or the same company, title and
//     text: import-jobs.ts jobFromRow), and changes nothing on it: open, reposted (the admin vouches); closed, Couldn't
//     verify (unreadableKnown);
//   - D8: the rejection is lifted only for a row that ends `review`, `added` or `reposted` (withRejectionLifted);
//   - D11: every outcome that lands on a shared job gets the row's Rate (when it has no pay) and its board remembered,
//     a read or not (afterLanding).
// v36 IMPORTTIME (SP v36 PLAN.md I1, the owner's addendum): every row of an admin's import that lands on a job (added,
// reposted, to review, already known or waiting) dates it the import's: jobs.reposted_at now, in the transaction that
// creates, reposts or holds it (import-time.ts), so a job whose board posted it weeks ago is under "Past 24 hours" and
// at the top of "Recently posted"; a new job a read made is dated in the store's transaction (page.ts ImportRead), a
// held one here (heldAgain) or by holdImported. Closed, Needs a title and company and Can't import date nothing.
// A person's import (the queue row names their profile): Add job's pipeline (addJobByLink) on their profile, the job
// saved to its Job Tracker: a job TailorIT has is `known` ("Already in TailorIT"); read, `added`; unreadable (after the
// queue's tries), their own job from the row (`added_private`, Add job with details: "From you, not verified", Retry
// read, Couldn't verify) when it has a title and a company, else `needs_details`. A person's row never writes to a job
// others see, nor reposts one (H5: people's imports never repost).
// v37 CLOSED (SP v37 PLAN.md C1-C3, C7; the owner's "Workday closed job is currently represented as for review (not
// closed)" and "even if the job is closed, the source should be extracted and added"):
//   - C1: every read's verdict is verdict.ts's: open, closed, try later (a 429, a paused Workday lane or held host, a
//     5xx, a timeout, an unreachable robots.txt), can't read;
//   - C3: a try-later read is read again by the link queue (queue.ts) after the pause (no try used while the site
//     paused TailorIT: `until`) or its backoff, for LINK_QUEUE_RETRY_HOURS; only after that, or for a can't-read verdict,
//     does a row with a title and a company go to Review. A queued read waits up to LINK_QUEUE_READ_TIMEOUT_MS for its
//     turn (a person's Add job keeps 15 s), so a Workday read queued behind the lane is no failure;
//   - C2: closed is closed: a known job read closed closes (closeGoneJob: its reviews settled by the server); a closed
//     job is never reopened nor held because a read failed (unreadableKnown: `closed`; holdImported holds open jobs
//     only); a held known job (waiting in Review) is read again when its last read is older than REPOST_RECENT_MS: open,
//     released as a read import is (the read settles it, a job the read made in its place retires it) and reposted;
//     closed, closed and out of Review; try later, held and read again; can't read, still in Review;
//   - C7: the board an admin import's link names becomes a source (off, Found by import, in Runs' Sources found)
//     whatever the read gave (closed-link.ts importBoardOfLink): a read's landing names its company, any other row
//     its own company.

/** How long a read counts as recent for a repost (H5: "last read within 24 h"). */
export const REPOST_RECENT_MS = 24 * HOUR_MS;

/** A claimed queued link of an import (queue.ts DueRow's import columns). */
export interface ImportQueueRow {
  id: number;
  url: string;
  origin: string;
  details: unknown;
  user_id: string | null;
  grant_id: string | null;
  added_by: string | null;
  source_id: number | null;
  import_id: number | null;
}

/**
 * What settling an import's link came to: an outcome for its rows, or a try again later (a failure for now). v37 CLOSED
 * (C3): `until`, the end of the pause of the site (or every Workday site): read again then, with no try used.
 */
export type ImportSettle = ({ retry: false } & QueueOutcome) | { retry: true; reason: JobVerifyReason; until?: string };

/** A queued row's fields: validated by the shared row contract (never trusted as stored). */
export function detailsOf(value: unknown): JobRowDetails {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  const result = JobRowDetailsSchema.safeParse(parsed ?? {});
  return result.success ? result.data : {};
}

/** Settles one claimed import link (see the top). `lastTry`: the queue's last try of a failure for now. */
export async function settleImportLink(deps: AppDeps, row: ImportQueueRow, lastTry: boolean): Promise<ImportSettle> {
  const details = detailsOf(row.details);
  if (row.user_id !== null) return settlePersonLink(deps, row, row.user_id, details, lastTry);
  return settleAdminLink(deps, row, details, lastTry);
}

const done = (result: QueueOutcome['result'], reason: QueueOutcome['reason'], jobId: number | null, held = false): ImportSettle => ({
  retry: false,
  result,
  reason,
  jobId,
  ...(held ? { held: true } : {}),
});

/**
 * A read that failed for now (verdict.ts: try later), before the queue's last try: tried again later (its reason, and
 * the end of the site's pause when it paused TailorIT), else null.
 */
const retryOf = (read: LinkRead, lastTry: boolean): ImportSettle | null =>
  read.kind === 'unreadable' && TRY_LATER_REASONS.has(read.reason) && !lastTry
    ? { retry: true, reason: read.reason, ...(read.pause ? { until: read.pause.until } : {}) }
    : null;

/** v37 CLOSED (C3): a queued read's budget, its wait for the site's turn included (LINK_QUEUE_READ_TIMEOUT_MS). */
const queueReadTimeout = (deps: AppDeps): number => constantsOf(deps).get('LINK_QUEUE_READ_TIMEOUT_MS');

// ------------------------------------------------------------------------------------------------- a person's import

async function settlePersonLink(deps: AppDeps, row: ImportQueueRow, userId: string, details: JobRowDetails, lastTry: boolean): Promise<ImportSettle> {
  const origin: JobAddOrigin = row.origin === 'sheets' ? 'sheets' : 'import';
  const actor = row.added_by && row.added_by !== userId ? { actor: { id: row.added_by, grantId: row.grant_id } } : {};
  const inFlight = newInFlight();
  let read: LinkRead | null = null;
  const first = await addJobByLink(deps, {
    url: row.url,
    userId,
    origin,
    details: null,
    // v38 FIX-APP (SP v38 FIXES-38 D1): the row's company names a posting TailorIT read that names none.
    ...(details.company ? { company: details.company } : {}),
    privateJob: false,
    save: true,
    inFlight,
    onRead: (made) => {
      read = made;
    },
    timeoutMs: queueReadTimeout(deps), // v37 CLOSED (C3)
    ...actor,
  });
  if (first.state === 'published' || first.state === 'waiting_admin') {
    return done(first.created ? 'added' : 'known', null, first.jobId, first.state === 'waiting_admin');
  }
  // v37 CLOSED (C3): a host TailorIT holds (not a slow-down) answers as a link it cannot read now: its pause still says
  // when to read it again.
  const held = read !== null && (read as LinkRead).kind === 'unreadable' ? (read as Extract<LinkRead, { kind: 'unreadable' }>).pause : undefined;
  if (first.pause) {
    // v37 CLOSED (C3): the site asked TailorIT to slow down: read again after the pause; at the last try, as a link it
    // can't read.
    if (!lastTry) return { retry: true, reason: first.reason ?? 'unavailable', until: first.pause.until };
  } else if (first.state === 'refused') {
    if (first.reason === 'closed') return done('closed', 'closed', null);
    return done('failed', first.reason ?? 'invalid_link', null);
  }
  // private_unverified: the person's own job of the link was there already, or TailorIT could not read it.
  if (first.jobId !== null) return done('known', first.reason, first.jobId);
  const reason = first.reason ?? 'unavailable';
  if (TRY_LATER_REASONS.has(reason) && !lastTry) return { retry: true, reason, ...(held ? { until: held.until } : {}) };
  if (reason === 'unreadable_host' || reason === 'terms') return done('failed', reason, null); // v37 FIX-37B (E8): terms too
  if (!rowHasTitleAndCompany(details)) return done('needs_details', reason, null);
  // v37 CLOSED (C3): the read's reason without its pause (its last try: the person's own job from the row).
  const known: Extract<LinkRead, { kind: 'closed' | 'unreadable' }> =
    read !== null && (read as LinkRead).kind === 'unreadable'
      ? { kind: 'unreadable', reason: (read as Extract<LinkRead, { kind: 'unreadable' }>).reason }
      : { kind: 'unreadable', reason };
  const own = await addJobByLink(deps, {
    url: row.url,
    userId,
    origin,
    details: {
      title: details.title!,
      company: details.company!,
      ...(details.location ? { location: details.location } : {}),
      ...(details.description ? { description: details.description } : {}),
      ...(details.rate ? { rate: details.rate } : {}),
    },
    privateJob: true,
    save: true,
    inFlight,
    knownRead: known,
    ...actor,
  });
  if (own.state === 'private_unverified' && own.jobId !== null) return done(own.created ? 'added_private' : 'known', own.reason, own.jobId);
  if (own.state === 'published' || own.state === 'waiting_admin') return done(own.created ? 'added' : 'known', null, own.jobId);
  return done(own.reason === 'closed' ? 'closed' : 'failed', own.reason ?? reason, own.jobId);
}

// ------------------------------------------------------------------------------------------------- an admin's import

/** A job's state for H5: its owner, open or closed, held, and when TailorIT last read it. */
async function jobState(
  db: DbQueries,
  jobId: number,
): Promise<{ owner: string | null; active: boolean; held: boolean; lastRead: string | null } | null> {
  const row = await db.one<{ owner_user_id: string | null; active: boolean; held: boolean; last_read: string | null }>(
    `SELECT owner_user_id, active, held_since IS NOT NULL AS held, GREATEST(last_verified_at, last_seen_at) AS last_read
     FROM jobs WHERE id = ? AND superseded_by IS NULL`,
    [jobId],
  );
  return row ? { owner: row.owner_user_id, active: row.active, held: row.held, lastRead: row.last_read ? new Date(row.last_read).toISOString() : null } : null;
}

/** An open held shared job of the link's key (one an import made from its row, waiting in Couldn't verify), or null. */
async function heldOfLink(db: DbQueries, url: string): Promise<{ id: number } | null> {
  const key = linkKey(url);
  if (!key) return null;
  const row = await db.one<{ id: number }>(
    `SELECT j.id FROM job_keys k JOIN jobs j ON j.id = k.job_id
     WHERE k.key_kind = 'link' AND k.key = ? AND j.owner_user_id IS NULL AND j.held_since IS NOT NULL AND j.active AND j.superseded_by IS NULL
     ORDER BY j.id LIMIT 1`,
    [key],
  );
  return row ? { id: Number(row.id) } : null;
}

/** A link's rejection as job_link_rejections keeps it. */
interface Rejection {
  url_key: string;
  rejected_by: string | null;
  rejected_at: string | Date;
}

/**
 * H3: an admin who imports a rejected link asked for it: its rejection (and any rejection covering it) is lifted.
 * Answers the rejections taken off (restoreRejections puts them back). In the caller's transaction, or none.
 */
async function liftRejection(db: DbQueries, url: string): Promise<Rejection[]> {
  const key = linkKey(url);
  if (!key) return [];
  const taken = (urlKey: string) =>
    db.all<Rejection>('DELETE FROM job_link_rejections WHERE url_key = ? RETURNING url_key, rejected_by, rejected_at', [urlKey]);
  const lifted = await taken(key);
  const origin = (() => {
    try {
      const parsed = new URL(key);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return null;
    }
  })();
  if (!origin) return lifted;
  const rows = await db.all<{ url_key: string }>('SELECT url_key FROM job_link_rejections WHERE url_key >= ? AND url_key < ? LIMIT 1000', [
    `${origin}/`,
    `${origin}0`,
  ]);
  for (const row of rows) if (rejectionCovers(row.url_key, key)) lifted.push(...(await taken(row.url_key)));
  return lifted;
}

/** v35 FIX-PIPE (data D8): rejections liftRejection took off, back as they were (their admin, if still an account). */
async function restoreRejections(db: DbQueries, lifted: readonly Rejection[]): Promise<void> {
  for (const row of lifted) {
    await db.run(
      `INSERT INTO job_link_rejections(url_key, rejected_by, rejected_at) VALUES (?, (SELECT id FROM users WHERE id = ?), ?)
       ON CONFLICT (url_key) DO NOTHING`,
      [row.url_key, row.rejected_by, new Date(row.rejected_at).toISOString()],
    );
  }
}

/** v35 FIX-PIPE (data D8): the results that keep a link's rejection lifted: the job is in review, added or reposted. */
const LIFTING_RESULTS: ReadonlySet<QueueOutcome['result']> = new Set(['review', 'added', 'reposted']);

/**
 * v35 FIX-PIPE (data D8): `read` with the link's rejection lifted (TailorIT's read refuses a rejected link: pipeline.ts
 * readLink, page.ts), and put back unless the row ends `review`, `added` or `reposted` (a row that ends Needs a title and
 * company, Closed, Can't import or Already waiting, or is tried again later, leaves the link rejected: people's adds of
 * it stay refused). A row that settles with no read lifts it in its outcome's own transaction instead.
 */
async function withRejectionLifted(deps: AppDeps, url: string, read: (lifted: boolean) => Promise<ImportSettle>): Promise<ImportSettle> {
  const lifted = await liftRejection(deps.db, url);
  let settled: ImportSettle | null = null;
  try {
    settled = await read(lifted.length > 0); // v37 CLOSED (C2): whether an admin had rejected the link
    return settled;
  } finally {
    if (lifted.length > 0 && (settled === null || settled.retry || !LIFTING_RESULTS.has(settled.result))) {
      await restoreRejections(deps.db, lifted);
    }
  }
}

/** The run of the import that queued the row (null: none, or a run gone). */
async function runOf(deps: AppDeps, row: ImportQueueRow): Promise<number | null> {
  if (row.import_id === null) return null;
  const run = await deps.db.one<{ run_id: number | null }>('SELECT run_id FROM job_imports WHERE id = ?', [row.import_id]);
  return run?.run_id === null || run?.run_id === undefined ? null : Number(run.run_id);
}

/**
 * A read held a job it CREATED for New jobs (NEW_JOBS_ADMIN_APPROVAL, or a page read): ADMIN's mark, the import's (its
 * run). v35 INT-A: the read's own hold marks it already (ImportRead); this keeps the mark whatever path held it.
 */
async function heldByImport(deps: AppDeps, runId: number | null, jobId: number): Promise<void> {
  await noteImportedHold(deps.db, jobId, runId);
}

/** v35 INT-A: an admin import's read (page.ts ImportRead): its run, and its row filling what the read lacks. */
function importReadOf(runId: number | null, details: JobRowDetails): ImportRead {
  return { runId, company: details.company ?? null, fill: (raw) => fillReadPosting(raw, details) };
}

/** The board an admin import's link names (closed-link.ts importBoardOfLink), as rememberImportBoard takes it. */
type ImportBoard = Omit<ImportBoardInput, 'runId' | 'companyName'>;

/**
 * The board remembered (H6: ADMIN's rememberImportBoard, a source switched off and Found by import when none reads it),
 * named `companyName`. A board that cannot be named is logged, never the row's failure.
 */
async function rememberBoard(deps: AppDeps, runId: number | null, board: ImportBoard, companyName: string | null): Promise<void> {
  try {
    await deps.db.tx((t) => rememberImportBoard(deps, t, { ...board, companyName, runId }), { label: 'import: a board found' });
  } catch (error) {
    if (!(error instanceof IngestError)) throw error;
    deps.log.warn('[job-imports] the board of a read link could not be named', error.name);
  }
}

/**
 * A shared job an admin's row landed on: its pay from the Rate when it has none (H4), its board remembered under the
 * job's company (rememberBoard), the board named by the row's link (no read needed). v35 FIX-PIPE (data D11): after
 * every outcome that lands on a shared job (added, reposted, known, to review), a read or not. v37 CLOSED (C7): the board
 * is the link's (importBoardOfLink: a Workday link without a location, or the address alone, too), and a row that lands
 * on no job remembers it all the same (settleAdminLink).
 */
async function afterLanding(deps: AppDeps, runId: number | null, board: ImportBoard | null, jobId: number, details: JobRowDetails): Promise<void> {
  await deps.db.tx((t) => fillPayFromRate(t, jobId, details.rate, nowIso(deps)), { label: 'import: a job landed on' });
  if (!board) return;
  const company = await deps.db.one<{ name: string }>('SELECT c.name FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?', [jobId]);
  await rememberBoard(deps, runId, board, company?.name ?? null);
}

/**
 * H5: reposted now. v35 FIX-PIPE: `vouchFor`, the link an admin's import vouches for, TailorIT unable to read it now
 * (decision 4: an unverified job back in search, bounded by an approval: import-jobs.ts repostJob); `lift`, the link
 * whose rejection a row settled with no read lifts, in the repost's transaction (data D8).
 */
async function repostNow(deps: AppDeps, row: ImportQueueRow, jobId: number, options: { vouchFor?: string; lift?: string } = {}): Promise<void> {
  await deps.db.tx(
    async (t) => {
      if (options.lift) await liftRejection(t, options.lift);
      await repostJob(t, jobId, nowIso(deps), { adminId: row.added_by, ...(options.vouchFor ? { vouchFor: options.vouchFor } : {}) });
    },
    { label: 'import: a repost' },
  );
}

/** H5: a job TailorIT has, held for Review › Couldn't verify (import-jobs.ts holdImported), the link's rejection lifted. */
async function toCouldntVerify(deps: AppDeps, jobId: number, url: string, reason: JobVerifyReason, reopen = false): Promise<void> {
  await deps.db.tx(
    async (t) => {
      await liftRejection(t, url);
      await holdImported(t, jobId, url, reason, nowIso(deps), { reopen }); // v37 CLOSED (C2): `reopen`, H3's rejected job only
    },
    { label: 'import: a job to review' },
  );
}

/**
 * v35 FIX-PIPE (data D4): a held shared job an admin's import names. "Already waiting for review" only while a review
 * waits on it: its New jobs review pending, or its Couldn't verify note listed. Otherwise nothing waits (an admin
 * rejected its New jobs review, which leaves the job held: job-reviews/decide.ts; or its note is no longer listed), and
 * the admin asked (H3): it is back in review, `review`:
 *   - a rejected New jobs review is reopened (decide.ts reopenReview) and marked this import's (New jobs › Imports and
 *     the import's own filter list it), in one transaction with the link's rejection lifted;
 *   - else the job is noted again in Couldn't verify (`reason`, or "no job data" when nothing was read).
 * v36 IMPORTTIME (I1): each way dates the job the import's (out of search while held; its approval dates it again).
 * v37 INT-A (CLOSED's C2 with REVIEW's R5): a held job whose note says TailorIT's last read found its posting closed
 * (reason `closed`, which Couldn't verify never lists) is closed, never "already waiting" nor noted again, unless a read
 * just found its posting open (`open`); "listed" is the list's own condition (listedSql: the switch's word on people's
 * links included).
 */
async function heldAgain(
  deps: AppDeps,
  runId: number | null,
  jobId: number,
  url: string,
  reason: JobVerifyReason | null,
  open = false,
): Promise<ImportSettle> {
  if (!open && (await deps.db.one("SELECT 1 AS found FROM job_verifications WHERE job_id = ? AND reason = 'closed'", [jobId]))) {
    await closeGoneJob(deps, jobId);
    return done('closed', 'closed', jobId);
  }
  const subject = jobReviewSubject(jobId);
  const waiting = async (): Promise<ImportSettle> => {
    await deps.db.tx((t) => dateImported(t, jobId, nowIso(deps)), { label: 'import: a held job dated' }); // v36 IMPORTTIME
    return done('known', 'waiting_review', jobId);
  };
  const pending = await deps.db.one("SELECT 1 AS found FROM job_reviews WHERE kind = 'new_job' AND subject_key = ? AND state = 'pending'", [subject]);
  if (pending) return waiting();
  const listed = await deps.db.one(
    `SELECT 1 AS found FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE v.job_id = ? AND ${listedSql(deps)}`,
    [jobId],
  );
  if (listed) return waiting();
  const rejected = await deps.db.one<{ id: number }>(
    "SELECT id FROM job_reviews WHERE kind = 'new_job' AND subject_key = ? AND origin = 'ats' AND state = 'rejected' ORDER BY id DESC LIMIT 1",
    [subject],
  );
  if (rejected) {
    await deps.db.tx(
      async (t) => {
        const review = await reviewById(t, Number(rejected.id), true);
        if (review?.state !== 'rejected') return;
        await reopenReview(deps, t, review, null, deps.now());
        await noteImportedHold(t, jobId, runId);
        await liftRejection(t, url);
        await dateImported(t, jobId, nowIso(deps)); // v36 IMPORTTIME
      },
      { label: 'import: a rejected new job back to review' },
    );
    return done('review', null, jobId);
  }
  await toCouldntVerify(deps, jobId, url, reason ?? 'no_posting');
  return done('review', reason, jobId);
}

/**
 * H5 for a job TailorIT has that it cannot read now (a re-read that failed, or v35 FIX-PIPE decision 5: an unreadable
 * row that joined it by an exact match): held, as heldAgain says; open, reposted, the admin vouching for it. v37 CLOSED
 * (C2): closed, it stays closed (`closed`): a read that failed never reopens nor holds a closed job (v3.5 reopened it held
 * for Review › Couldn't verify). One exception, H3's: a job closed by an admin's rejection of its link (`rejected`: the
 * import lifted it), which an admin's import asks for again: back in Couldn't verify, as v3.5 did (no read said its
 * posting closed).
 */
async function unreadableKnown(
  deps: AppDeps,
  row: ImportQueueRow,
  runId: number | null,
  url: string,
  job: { id: number; active: boolean; held: boolean },
  reason: JobVerifyReason,
  rejected = false,
): Promise<ImportSettle> {
  if (job.held && job.active) return heldAgain(deps, runId, job.id, url, reason);
  if (job.active) {
    await repostNow(deps, row, job.id, { vouchFor: url });
    return done('reposted', reason, job.id);
  }
  if (rejected) {
    await toCouldntVerify(deps, job.id, url, reason, true);
    return done('review', reason, job.id);
  }
  return done('closed', 'closed', job.id); // v37 CLOSED (C2)
}

async function settleAdminLink(deps: AppDeps, row: ImportQueueRow, details: JobRowDetails, lastTry: boolean): Promise<ImportSettle> {
  const given = canonicalJobUrl(row.url);
  const url = sharedAddress(given);
  if (!given || !url || !isAddableLink(given) || !isAddableLink(url)) return done('failed', 'invalid_link', null);
  const page = readPage(url, undefined, aliasValueHash(deps));
  if (page.linkedIn || isRefusedPageHost(new URL(url).hostname)) return done('failed', 'unreadable_host', null);
  const runId = await runOf(deps, row);
  // v37 CLOSED (C7): the link's board becomes a source whatever the read gives: a landing names it with the job's
  // company; a row that lands on no job (closed, try later, needs details) with its own.
  const board = importBoardOfLink(page, url);
  // v381 EMBED (SP v381 PLAN E5): a company page's link names the board its site embeds. v381 FIX (REVIEW381-beh L5,
  // REVIEW381-ux L2): the board of the job the row landed on (the board the read stored it under), never the site's
  // newest board; a row that lands on no job names none this way.
  let remembered = false;
  const landed = async (jobId: number) => {
    remembered = true;
    const found = board ?? (await embeddedImportBoardOf(deps, url, jobId)); // v381 FIX (L5)
    await afterLanding(deps, runId, found, jobId, details); // v35 FIX-PIPE (data D11)
  };
  const settled = await settleAdminRead(deps, row, details, lastTry, { given, url, page, runId, landed });
  if (board && !remembered) await rememberBoard(deps, runId, board, details.company ?? null);
  return settled;
}

/** settleAdminLink's link, read and landing (see there). */
interface AdminRead {
  given: string;
  url: string;
  page: ReturnType<typeof readPage>;
  runId: number | null;
  landed: (jobId: number) => Promise<void>;
}

async function settleAdminRead(deps: AppDeps, row: ImportQueueRow, details: JobRowDetails, lastTry: boolean, link: AdminRead): Promise<ImportSettle> {
  const { given, url, page, runId, landed } = link;
  const inFlight = newInFlight();
  const importRead = importReadOf(runId, details); // v35 INT-A
  const timeoutMs = queueReadTimeout(deps); // v37 CLOSED (C3)

  // 1. A job TailorIT has (H5): Add job's matching, else a held job of the link (an import's, waiting for review).
  const found = (await findPageJob(deps, '', page)) ?? (await heldJobOf(deps, page)) ?? (await heldOfLink(deps.db, url));
  const state = found ? await jobState(deps.db, found.id) : null;
  if (found && state && state.owner === null) {
    const recent = state.lastRead !== null && deps.now().getTime() - Date.parse(state.lastRead) < REPOST_RECENT_MS;
    // v37 CLOSED (C2): a held job read lately waits as it is; read longer ago, it is read again below.
    if (state.held && state.active && recent) {
      await landed(found.id);
      return heldAgain(deps, runId, found.id, url, null);
    }
    if (state.active && !state.held && recent) {
      await landed(found.id);
      await repostNow(deps, row, found.id, { lift: url });
      return done('reposted', null, found.id);
    }
    return withRejectionLifted(deps, url, async (rejected) => {
      const read = await readLink(deps, url, inFlight, page, { readAt: given, fresh: true, importRead, timeoutMs });
      const again = retryOf(read, lastTry);
      if (again) return again;
      if (read.kind === 'shared') {
        // v37 CLOSED (C2): a held job of the link (an import's row, waiting in Couldn't verify) that the read did not
        // land on gives way to the job the read made (its trackers, aliases and queue rows move; it closes, superseded).
        if (state.held && read.jobId !== found.id && (await legacyHeld(deps.db, found.id))) {
          await deps.db.tx((t) => retireLegacyJob(t, found.id, read.jobId, nowIso(deps)), { label: 'import: a held job read' });
        }
        await landed(read.jobId);
        if (read.held && read.created) {
          await heldByImport(deps, runId, read.jobId);
          return done('added', null, read.jobId, true);
        }
        if (read.held) return heldAgain(deps, runId, read.jobId, url, null, true); // v37 INT-A: read open now
        await repostNow(deps, row, read.jobId);
        return done('reposted', null, read.jobId);
      }
      if (read.kind === 'closed') {
        if (state.active) await closeGoneJob(deps, found.id);
        return done('closed', 'closed', found.id);
      }
      if (read.reason === 'unreadable_host' || read.reason === 'terms') return done('failed', read.reason, null); // v37 FIX-37B (E8)
      await landed(found.id);
      return unreadableKnown(deps, row, runId, url, { id: found.id, active: state.active, held: state.held }, read.reason, rejected);
    });
  }

  // 2. TailorIT's read.
  return withRejectionLifted(deps, url, async (rejected) => {
    const read = await readLink(deps, url, inFlight, page, { readAt: given, importRead, timeoutMs });
    const again = retryOf(read, lastTry);
    if (again) return again;
    if (read.kind === 'shared') {
      await landed(read.jobId);
      if (read.created && read.held) await heldByImport(deps, runId, read.jobId);
      if (read.created) return done('added', null, read.jobId, read.held);
      if (read.held) return heldAgain(deps, runId, read.jobId, url, null, true); // v37 INT-A: read open now
      await repostNow(deps, row, read.jobId);
      return done('reposted', null, read.jobId);
    }
    if (read.kind === 'closed') return done('closed', 'closed', null);
    if (read.reason === 'unreadable_host' || read.reason === 'terms') return done('failed', read.reason, null); // v37 FIX-37B (E8)
    if (!rowHasTitleAndCompany(details)) return done('needs_details', read.reason, null);
    const source = (row.source_id !== null ? await getSourceRecord(deps.db, Number(row.source_id)) : null) ?? (await pastedLinksSource(deps.db, nowIso(deps)));
    const made = await jobFromRow(deps, source, { url, details, reason: read.reason });
    if (made.created) return done('review', read.reason, made.jobId);
    // v35 FIX-PIPE (decision 5): the row named a job TailorIT has by an exact match (its keys, or the same company, title
    // and text), the store's writes undone: H5, as for a job TailorIT has that it cannot read now.
    const existing = await jobState(deps.db, made.jobId);
    if (!existing || existing.owner !== null) return done('needs_details', read.reason, null);
    await landed(made.jobId);
    return unreadableKnown(deps, row, runId, url, { id: made.jobId, active: existing.active, held: existing.held }, read.reason, rejected);
  });
}
