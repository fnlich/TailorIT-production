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
import { addablePosting } from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { aliasValueHash } from '../../autofill/alias-key';
import { heldJobOf, newInFlight } from '../../autofill/jobs';
import { findPageJob, readPage, type PageReading } from '../../autofill/lookup';
import { importBoardOfPosting, rememberImportBoard } from '../../ingest/import-sources'; // v35 INT-A: ADMIN's
import { getSourceRecord } from '../../ingest/sources';
import { IngestError } from '../../ingest/types';
import { reopenReview } from '../../job-reviews/decide'; // v35 FIX-PIPE (data D4)
import { isRefusedPageHost } from '../../job-reviews/hosts';
import { noteImportedHold } from '../../job-reviews/new-jobs'; // v35 INT-A: ADMIN's
import { reviewById } from '../../job-reviews/store'; // v35 FIX-PIPE (data D4)
import { sharedAddress } from './address';
import { closeGoneJob, fillPayFromRate, fillReadPosting, holdImported, jobFromRow, repostJob } from './import-jobs';
import { pastedLinksSource, type QueueOutcome } from './import-store';
import { TRANSIENT_REASONS } from './legacy';
import type { ImportRead } from './page';
import { addJobByLink, isAddableLink, readLink, type LinkRead } from './pipeline';
import { LISTED, rejectionCovers } from './verification';

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
// A person's import (the queue row names their profile): Add job's pipeline (addJobByLink) on their profile, the job
// saved to its Job Tracker: a job TailorIT has is `known` ("Already in TailorIT"); read, `added`; unreadable (after the
// queue's tries), their own job from the row (`added_private`, Add job with details: "From you, not verified", Retry
// read, Couldn't verify) when it has a title and a company, else `needs_details`. A person's row never writes to a job
// others see, nor reposts one (H5: people's imports never repost).

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

/** What settling an import's link came to: an outcome for its rows, or a try again later (a failure for now). */
export type ImportSettle = ({ retry: false } & QueueOutcome) | { retry: true; reason: JobVerifyReason };

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

/** A read that failed for now, before the queue's last try: tried again later (its reason), else null. */
const retryReason = (read: LinkRead, lastTry: boolean): JobVerifyReason | null =>
  read.kind === 'unreadable' && TRANSIENT_REASONS.has(read.reason) && !lastTry ? read.reason : null;

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
    privateJob: false,
    save: true,
    inFlight,
    onRead: (made) => {
      read = made;
    },
    ...actor,
  });
  if (first.state === 'published' || first.state === 'waiting_admin') {
    return done(first.created ? 'added' : 'known', null, first.jobId, first.state === 'waiting_admin');
  }
  if (first.state === 'refused') {
    if (first.reason === 'closed') return done('closed', 'closed', null);
    return done('failed', first.reason ?? 'invalid_link', null);
  }
  // private_unverified: the person's own job of the link was there already, or TailorIT could not read it.
  if (first.jobId !== null) return done('known', first.reason, first.jobId);
  const reason = first.reason ?? 'unavailable';
  if (TRANSIENT_REASONS.has(reason) && !lastTry) return { retry: true, reason };
  if (reason === 'unreadable_host') return done('failed', reason, null);
  if (!rowHasTitleAndCompany(details)) return done('needs_details', reason, null);
  const known: Extract<LinkRead, { kind: 'closed' | 'unreadable' }> =
    read !== null && (read as LinkRead).kind === 'unreadable' ? (read as Extract<LinkRead, { kind: 'unreadable' }>) : { kind: 'unreadable', reason };
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
async function withRejectionLifted(deps: AppDeps, url: string, read: () => Promise<ImportSettle>): Promise<ImportSettle> {
  const lifted = await liftRejection(deps.db, url);
  let settled: ImportSettle | null = null;
  try {
    settled = await read();
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

/**
 * A shared job an admin's row landed on: its pay from the Rate when it has none (H4), its board remembered (H6: ADMIN's
 * rememberImportBoard, a source switched off and Found by import when none reads it), the board named by the row's link
 * (no read needed). A board that cannot be named is logged, never the row's failure. v35 FIX-PIPE (data D11): after
 * every outcome that lands on a shared job (added, reposted, known, to review), a read or not.
 */
async function afterLanding(deps: AppDeps, runId: number | null, page: PageReading, jobId: number, details: JobRowDetails): Promise<void> {
  await deps.db.tx((t) => fillPayFromRate(t, jobId, details.rate, nowIso(deps)), { label: 'import: a job landed on' });
  const board = importBoardOfPosting(addablePosting(page.ats));
  if (!board) return;
  const company = await deps.db.one<{ name: string }>('SELECT c.name FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?', [jobId]);
  try {
    await deps.db.tx((t) => rememberImportBoard(deps, t, { ...board, companyName: company?.name ?? null, runId }), { label: 'import: a board found' });
  } catch (error) {
    if (!(error instanceof IngestError)) throw error;
    deps.log.warn('[job-imports] the board of a read link could not be named', error.name);
  }
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
async function toCouldntVerify(deps: AppDeps, jobId: number, url: string, reason: JobVerifyReason): Promise<void> {
  await deps.db.tx(
    async (t) => {
      await liftRejection(t, url);
      await holdImported(t, jobId, url, reason, nowIso(deps));
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
 */
async function heldAgain(deps: AppDeps, runId: number | null, jobId: number, url: string, reason: JobVerifyReason | null): Promise<ImportSettle> {
  const subject = jobReviewSubject(jobId);
  const pending = await deps.db.one("SELECT 1 AS found FROM job_reviews WHERE kind = 'new_job' AND subject_key = ? AND state = 'pending'", [subject]);
  if (pending) return done('known', 'waiting_review', jobId);
  const listed = await deps.db.one(`SELECT 1 AS found FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE v.job_id = ? AND ${LISTED}`, [jobId]);
  if (listed) return done('known', 'waiting_review', jobId);
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
 * row that joined it by an exact match): held, as heldAgain says; open, reposted, the admin vouching for it; closed,
 * reopened held for Review › Couldn't verify (an approval publishes and reposts it), never published without review.
 */
async function unreadableKnown(
  deps: AppDeps,
  row: ImportQueueRow,
  runId: number | null,
  url: string,
  job: { id: number; active: boolean; held: boolean },
  reason: JobVerifyReason,
): Promise<ImportSettle> {
  if (job.held && job.active) return heldAgain(deps, runId, job.id, url, reason);
  if (job.active) {
    await repostNow(deps, row, job.id, { vouchFor: url });
    return done('reposted', reason, job.id);
  }
  await toCouldntVerify(deps, job.id, url, reason);
  return done('review', reason, job.id);
}

async function settleAdminLink(deps: AppDeps, row: ImportQueueRow, details: JobRowDetails, lastTry: boolean): Promise<ImportSettle> {
  const given = canonicalJobUrl(row.url);
  const url = sharedAddress(given);
  if (!given || !url || !isAddableLink(given) || !isAddableLink(url)) return done('failed', 'invalid_link', null);
  const page = readPage(url, undefined, aliasValueHash(deps));
  if (page.linkedIn || isRefusedPageHost(new URL(url).hostname)) return done('failed', 'unreadable_host', null);
  const inFlight = newInFlight();
  const runId = await runOf(deps, row);
  const importRead = importReadOf(runId, details); // v35 INT-A
  const landed = (jobId: number) => afterLanding(deps, runId, page, jobId, details); // v35 FIX-PIPE (data D11)

  // 1. A job TailorIT has (H5): Add job's matching, else a held job of the link (an import's, waiting for review).
  const found = (await findPageJob(deps, '', page)) ?? (await heldJobOf(deps, page)) ?? (await heldOfLink(deps.db, url));
  const state = found ? await jobState(deps.db, found.id) : null;
  if (found && state && state.owner === null) {
    if (state.held && state.active) {
      await landed(found.id);
      return heldAgain(deps, runId, found.id, url, null);
    }
    const recent = state.lastRead !== null && deps.now().getTime() - Date.parse(state.lastRead) < REPOST_RECENT_MS;
    if (state.active && recent) {
      await landed(found.id);
      await repostNow(deps, row, found.id, { lift: url });
      return done('reposted', null, found.id);
    }
    return withRejectionLifted(deps, url, async () => {
      const read = await readLink(deps, url, inFlight, page, { readAt: given, fresh: true, importRead });
      const again = retryReason(read, lastTry);
      if (again) return { retry: true, reason: again };
      if (read.kind === 'shared') {
        await landed(read.jobId);
        if (read.held && read.created) {
          await heldByImport(deps, runId, read.jobId);
          return done('added', null, read.jobId, true);
        }
        if (read.held) return heldAgain(deps, runId, read.jobId, url, null);
        await repostNow(deps, row, read.jobId);
        return done('reposted', null, read.jobId);
      }
      if (read.kind === 'closed') {
        if (state.active) await closeGoneJob(deps, found.id);
        return done('closed', 'closed', found.id);
      }
      if (read.reason === 'unreadable_host') return done('failed', read.reason, null);
      await landed(found.id);
      return unreadableKnown(deps, row, runId, url, { id: found.id, active: state.active, held: state.held }, read.reason);
    });
  }

  // 2. TailorIT's read.
  return withRejectionLifted(deps, url, async () => {
    const read = await readLink(deps, url, inFlight, page, { readAt: given, importRead });
    const again = retryReason(read, lastTry);
    if (again) return { retry: true, reason: again };
    if (read.kind === 'shared') {
      await landed(read.jobId);
      if (read.created && read.held) await heldByImport(deps, runId, read.jobId);
      if (read.created) return done('added', null, read.jobId, read.held);
      if (read.held) return heldAgain(deps, runId, read.jobId, url, null);
      await repostNow(deps, row, read.jobId);
      return done('reposted', null, read.jobId);
    }
    if (read.kind === 'closed') return done('closed', 'closed', null);
    if (read.reason === 'unreadable_host') return done('failed', read.reason, null);
    if (!rowHasTitleAndCompany(details)) return done('needs_details', read.reason, null);
    const source = (row.source_id !== null ? await getSourceRecord(deps.db, Number(row.source_id)) : null) ?? (await pastedLinksSource(deps.db, nowIso(deps)));
    const made = await jobFromRow(deps, source, { url, details, reason: read.reason });
    if (made.created) return done('review', read.reason, made.jobId);
    // v35 FIX-PIPE (decision 5): the row named a job TailorIT has by an exact match (its keys, or the same company, title
    // and text), the store's writes undone: H5, as for a job TailorIT has that it cannot read now.
    const existing = await jobState(deps.db, made.jobId);
    if (!existing || existing.owner !== null) return done('needs_details', read.reason, null);
    await landed(made.jobId);
    return unreadableKnown(deps, row, runId, url, { id: made.jobId, active: existing.active, held: existing.held }, read.reason);
  });
}
