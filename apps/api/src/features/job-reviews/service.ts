import {
  ADMIN_BULK_MAX,
  type AdminReviewBulkBody,
  type AdminReviewBulkResultSchema,
  type AdminReviewDecisionBody,
  type AdminReviewDetail,
  type AdminReviewsAllBody,
  type AdminReviewsAllCount,
  type AdminReviewsAllFilter,
  type AdminReviewsAllResult,
  type JobVerifyReason,
} from '@tailorit/shared';
import { constantsOf } from '../../core/constants/index'; // v35 ADMIN
import type { SqlParam } from '../../core/db/types'; // v35 ADMIN
import type { z } from 'zod';
import type { AdminActor } from '../../core/admin/index';
import type { AppDeps } from '../../core/context';
import { AppError, conflict, validationFailed } from '../../core/http/errors';
import { reviewDetail, reviewsWhere } from './admin';
import { approveReview, rejectReview, reopenReview, runFollowUps, type CapturedApproval, type FollowUp, type PageReviewRead } from './decide';
import { pageReviewUrl, readPageReview, readPageReviewLink } from './page-read'; // v31 LINK
import { linkNoticeTarget, noticeVerification } from '../jobs/add/notify'; // v31 LINK; v33 SHARE-6: linkNoticeTarget
import type { LinkAdder } from '../jobs/add/verification'; // v33 SHARE-6
import { assertPublishable, giveWayToApproved, takeApprovalSlot } from '../jobs/add/approve'; // v32 ADMINAPP (E6)
import { sharedAddress } from '../jobs/add/address'; // v32 ADMINAPP (E6)
import { reviewById } from './store';

// v30 X1-API: an admin's decisions in Admin › Review (docs/design/part2/14-extension-reports.md §6.2): one review
// (PATCH /api/admin/reviews/:id: approve, reject or reopen, with an optional note) or up to ADMIN_BULK_MAX at once
// (POST /api/admin/reviews/bulk: approve or reject), each review in a transaction of its own, so one that fails or was
// decided already never undoes the others; each row of a bulk answer says what happened. An approval's follow-ups (page
// jobs giving way to their published copy) run after its commit.

/** PATCH /api/admin/reviews/:id: the decision, then the review's detail; null when there is no such review. */
export async function decideReview(
  deps: AppDeps,
  id: number,
  body: AdminReviewDecisionBody,
  admin: AdminActor,
): Promise<AdminReviewDetail | null> {
  const now = deps.now();
  const at = now.toISOString();
  const decider = { by: 'admin' as const, userId: admin.id, note: body.note ? body.note : null };
  // v31 LINK (D2): a page review's approval reads its link first (outside the transaction); only that read is published.
  const reading: { read?: PageReviewRead; unread: JobVerifyReason | null } =
    body.decision === 'approve' ? await readPageReview(deps, id) : { unread: null };
  const read = reading.read;
  // v32 ADMINAPP (E6): unread, the admin may approve it as captured (`captured`): the link checked, the admin's hour.
  const captured =
    body.decision === 'approve' && body.captured === true && !read ? await capturedApprovalOf(deps, id, admin, reading.unread) : undefined;
  let found: { followUps: FollowUp[] } | null;
  try {
    found = await deps.db.tx(
      async (t): Promise<{ followUps: FollowUp[] } | null> => {
        const review = await reviewById(t, id, true);
        if (!review) return null;
        if (body.decision === 'approve') return { followUps: await approveReview(deps, t, review, decider, at, read, captured) };
        if (body.decision === 'reject') await rejectReview(t, review, decider, at);
        else await reopenReview(deps, t, review, decider.note, now);
        return { followUps: [] };
      },
      { label: 'decide review' },
    );
  } catch (error) {
    captured?.release(); // v32 FIX-API: a refused approval uses none of the admin's hour
    throw error;
  }
  if (!found) {
    captured?.release();
    return null;
  }
  await runFollowUps(deps, found.followUps);
  if (body.decision === 'approve') await noticeApprovedJob(deps, id); // v31 LINK
  // v32 ADMINAPP (E6): the other accounts' own jobs of the link ("Couldn't verify") give way to the approved job too.
  const approvedJob = found.followUps[0]?.sharedJobId;
  if (captured && approvedJob !== undefined) {
    await giveWayToApproved(deps, { jobId: approvedJob, url: captured.url, told: [], approvedByAdmin: found.followUps[0]?.approvedByAdmin === true });
  }
  return reviewDetail(deps, id);
}

/**
 * v32 ADMINAPP (E6): a pending page review TailorIT could not read, about to be approved as captured: its link in its
 * shared form, refused (409) when its job may never be published (jobs/add/approve.ts assertPublishable), and one of
 * the admin's approvals this hour. Undefined for any other review (its approval goes on as before). v32 FIX-API: refused
 * too when the read found the posting closed or its company or site opted out (SB-6); `release` gives the hour's slot
 * back when the approval is then refused.
 */
async function capturedApprovalOf(
  deps: AppDeps,
  id: number,
  admin: AdminActor,
  unread: JobVerifyReason | null,
): Promise<(CapturedApproval & { release: () => void }) | undefined> {
  const review = await reviewById(deps.db, id);
  if (!review || review.kind !== 'new_job' || review.origin !== 'page' || review.state !== 'pending') return undefined;
  const url = sharedAddress(pageReviewUrl(review));
  if (!url) return undefined;
  if (unread === 'closed') throw conflict('TailorIT found this posting closed, so there is nothing to publish.');
  if (unread === 'opted_out') throw conflict('This company asked TailorIT not to list its jobs, so this job is never published.');
  await assertPublishable(deps.db, url);
  const release = takeApprovalSlot(deps, admin.id);
  return { url, adminId: admin.id, release };
}

/**
 * v31 LINK: after an approval of a held new job read from an ATS (or its page), its adders hear it is published. A page
 * review's reporters hear it from their follow-ups (decide.ts runFollowUps). v33 SHARE-6 (PLAN-sharing §4 "Explicit
 * changes", §10: job-link notices go to the actor; the SHARE-6 review): someone who added it on an owner's profile hears
 * it there while their grant lets them (linkNoticeTarget), else the owner does.
 */
async function noticeApprovedJob(deps: AppDeps, reviewId: number): Promise<void> {
  const review = await reviewById(deps.db, reviewId);
  if (!review || review.kind !== 'new_job' || review.origin !== 'ats' || review.state !== 'approved') return;
  const adders = await deps.db.all<LinkAdder>(
    'SELECT user_id, added_by, grant_id FROM job_review_reports WHERE review_id = ? ORDER BY user_id',
    [reviewId],
  );
  for (const adder of adders) {
    const target = await linkNoticeTarget(deps, adder); // v33 SHARE-6
    await noticeVerification(deps, { userId: target.userId, profile: target.profile, jobId: review.job_id, state: 'published' });
  }
}

type BulkResult = z.infer<typeof AdminReviewBulkResultSchema>;

/** POST /api/admin/reviews/bulk: approve or reject the chosen reviews (see above). */
export async function decideReviews(deps: AppDeps, bulk: AdminReviewBulkBody, admin: AdminActor): Promise<{ ids: number[]; body: BulkResult }> {
  const results: BulkResult['results'] = [];
  const changed: number[] = [];
  for (const id of bulk.ids) {
    const now = deps.now();
    const at = now.toISOString();
    const decider = { by: 'admin' as const, userId: admin.id, note: bulk.note ? bulk.note : null };
    try {
      // v31 LINK (D2): a page review's approval reads its link first (outside the transaction).
      const read: PageReviewRead | undefined = bulk.decision === 'approve' ? await readPageReviewLink(deps, id) : undefined;
      const outcome = await deps.db.tx(
        async (t): Promise<{ result: BulkResult['results'][number]; followUps: FollowUp[] }> => {
          const review = await reviewById(t, id, true);
          if (!review) return { result: { id, outcome: 'failed', message: 'That review was not found.' }, followUps: [] };
          if (review.state !== 'pending') return { result: { id, outcome: 'skipped', message: 'This review was decided already.' }, followUps: [] };
          if (bulk.decision === 'approve') {
            return { result: { id, outcome: 'approved' }, followUps: await approveReview(deps, t, review, decider, at, read) };
          }
          await rejectReview(t, review, decider, at);
          return { result: { id, outcome: 'rejected' }, followUps: [] };
        },
        { label: 'decide reviews' },
      );
      results.push(outcome.result);
      if (outcome.result.outcome === 'approved' || outcome.result.outcome === 'rejected') changed.push(id);
      await runFollowUps(deps, outcome.followUps);
      if (outcome.result.outcome === 'approved') await noticeApprovedJob(deps, id); // v31 LINK
    } catch (error) {
      // An AppError's words are the admin's to read (a page job gone, a decision made meanwhile); any other is logged.
      if (!(error instanceof AppError)) deps.log.warn('[job-reviews] a bulk decision failed', error instanceof Error ? error.name : 'unknown');
      results.push({ id, outcome: 'failed', message: error instanceof AppError ? error.message.slice(0, 400) : 'It could not be decided. Try again.' });
    }
  }
  const counts: BulkResult['counts'] = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  return { ids: changed, body: { results, counts } };
}

// v35 ADMIN (PLAN H3) ---------------------------------------------------------------------------- Approve all / Reject all

/** The failures one "all" answer names (the rest are counted). */
const ALL_FAILURES_MAX = 20;

/** v37 REVIEW (R3): one batch's decisions, as a selection's bulk answers them (each row's outcome). */
export interface TurnDecisions<O extends string> {
  ids: number[];
  results: ReadonlyArray<{ id: number | string; outcome: O; message?: string | undefined }>;
}

/** v37 REVIEW (R3): what one "all" request did: the rows it took, each outcome's count, a few failures, where it stopped. */
export interface InTurns<O extends string> {
  changed: number[];
  matched: number;
  counts: Partial<Record<O, number>>;
  failures: Array<{ id: number; message: string }>;
  done: boolean;
  after: number;
}

/**
 * v37 REVIEW (SP v37 PLAN.md R3: one chunked, time-bound "all" path for every lane): New jobs' v3.5 loop, apart from
 * what it decides. `nextIds(after)` names the next ADMIN_BULK_MAX rows after `after`, oldest first; `decide` decides
 * them (each row in its own transaction, a failure named); the loop goes on until no row is left (`done`) or
 * ADMIN_BULK_ALL_SECONDS have passed (`done` false: the same request with `after` goes on past every row it took, so a
 * row that failed is never tried twice in one run).
 */
export async function decideInTurns<O extends string>(
  deps: AppDeps,
  start: number,
  nextIds: (after: number) => Promise<number[]>,
  decide: (ids: number[]) => Promise<TurnDecisions<O>>,
  clock: () => number = Date.now,
): Promise<InTurns<O>> {
  const budgetMs = constantsOf(deps).get('ADMIN_BULK_ALL_SECONDS') * 1000;
  const started = clock();
  const counts: Partial<Record<O, number>> = {};
  const failures: InTurns<O>['failures'] = [];
  const changed: number[] = [];
  let after = start;
  let matched = 0;
  let done = false;
  for (;;) {
    const ids = await nextIds(after);
    if (ids.length === 0) {
      done = true;
      break;
    }
    const decided = await decide(ids);
    matched += ids.length;
    changed.push(...decided.ids);
    for (const result of decided.results) {
      counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
      if (result.outcome === 'failed' && failures.length < ALL_FAILURES_MAX) {
        failures.push({ id: Number(result.id), message: (result.message ?? 'It could not be decided.').slice(0, 400) });
      }
    }
    after = ids[ids.length - 1]!;
    if (ids.length < ADMIN_BULK_MAX) {
      done = true;
      break;
    }
    if (clock() - started >= budgetMs) break;
  }
  return { changed, matched, counts, failures, done, after };
}

/** v37 REVIEW (R3): an `upTo` for a count of rows up to `lastId` at `at` (reviews' and flags' alike). */
export function upToOf(lastId: number, at: Date): string {
  return `${lastId}@${at.getTime()}`;
}

/** The pending reviews of the lane's filter, on `r` joined with its job and company (the lane's own condition). */
function pendingWhere(deps: AppDeps, filter: AdminReviewsAllFilter) {
  const where = reviewsWhere(deps, filter);
  where.add("r.state = 'pending'");
  return where;
}

const ALL_FROM = 'FROM job_reviews r JOIN jobs j ON j.id = r.job_id JOIN companies c ON c.id = j.company_id';

/**
 * v35 FIX-STORE (the final review's S6; the coordinator's decision 2: "Approve all" decides what the confirm counted):
 * a count's `upTo`, opaque to the web: the newest review counted and the time of the count ("<id>@<ms>"). The decisions
 * take only a pending review no newer than it and unchanged since (updated_at: a review reopened or reported again after
 * the count waits for the next decision), so rows that arrive while an import is still read stay pending.
 */
export function reviewsUpTo(lastId: number, at: Date): string {
  return upToOf(lastId, at);
}

/** The bound of an `upTo` (400 for one no count gave). */
export function reviewsUpToBound(upTo: string): { lastId: number; at: string } {
  const parts = /^(\d{1,15})@(\d{1,15})$/.exec(upTo);
  const at = parts ? new Date(Number(parts[2])) : null;
  if (!parts || !at || Number.isNaN(at.getTime())) throw validationFailed('Count the reviews again, then approve or reject them all.');
  return { lastId: Number(parts[1]), at: at.toISOString() };
}

/**
 * GET /api/admin/reviews/all/count: the pending reviews the New jobs lane's filter matches (the confirm's count). v37
 * REVIEW (R3): or the Closed links lane's.
 */
export async function countAllReviews(deps: AppDeps, filter: AdminReviewsAllFilter): Promise<AdminReviewsAllCount> {
  const at = deps.now(); // v35 FIX-STORE (S6): taken before the count, so nothing changed after it is in its upTo
  const where = pendingWhere(deps, filter);
  const row = await deps.db.one<{ n: number; last: number | null }>(
    `SELECT count(*) AS n, max(r.id) AS last ${ALL_FROM} ${where.sql()}`,
    where.params as Record<string, SqlParam>,
  );
  return { pending: Number(row?.n ?? 0), upTo: reviewsUpTo(Number(row?.last ?? 0), at) };
}

/**
 * POST /api/admin/reviews/all: approves or rejects every pending review the New jobs lane's filter matches, oldest first
 * (by id, after `after`), ADMIN_BULK_MAX at a time through decideReviews (each review in its own transaction, as the
 * selection's bulk: a page review's link read first, a decided one skipped, a failure named), for at most
 * ADMIN_BULK_ALL_SECONDS: an answer with `done` false stopped there, and the same request with its `after` goes on.
 * Approvals of an admin's imports are not counted against ADMIN_APPROVALS_PER_HOUR (that hour is for approving what
 * TailorIT could not read: Couldn't verify, captured pages); nor are held reads', as before. v37 REVIEW (R3): the Closed
 * links lane's too ("Select all N", then Approve or Reject), through decideInTurns.
 */
export async function decideAllReviews(
  deps: AppDeps,
  body: AdminReviewsAllBody,
  admin: AdminActor,
  clock: () => number = Date.now,
): Promise<{ ids: number[]; body: AdminReviewsAllResult }> {
  const bound = body.upTo === undefined ? null : reviewsUpToBound(body.upTo); // v35 FIX-STORE (S6)
  const nextIds = async (after: number): Promise<number[]> => {
    const where = pendingWhere(deps, body.filter);
    where.add('r.id > @after', { after });
    if (bound) {
      where.add('r.id <= @upToId', { upToId: bound.lastId });
      where.add('r.updated_at <= CAST(@upToAt AS timestamptz)', { upToAt: bound.at });
    }
    const rows = await deps.db.all<{ id: number }>(`SELECT r.id ${ALL_FROM} ${where.sql()} ORDER BY r.id LIMIT ${ADMIN_BULK_MAX}`, where.params as Record<string, SqlParam>);
    return rows.map((row) => Number(row.id));
  };
  const decide = async (ids: number[]) => {
    const decided = await decideReviews(deps, { ids, decision: body.decision, ...(body.note ? { note: body.note } : {}) }, admin);
    return { ids: decided.ids, results: decided.body.results };
  };
  const turns = await decideInTurns(deps, body.after ?? 0, nextIds, decide, clock);
  return {
    ids: turns.changed,
    body: { decision: body.decision, matched: turns.matched, counts: turns.counts, failures: turns.failures, done: turns.done, after: turns.after },
  };
}
