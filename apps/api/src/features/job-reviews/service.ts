import type { AdminReviewBulkBody, AdminReviewBulkResultSchema, AdminReviewDecisionBody, AdminReviewDetail, JobVerifyReason } from '@tailorit/shared';
import type { z } from 'zod';
import type { AdminActor } from '../../core/admin/index';
import type { AppDeps } from '../../core/context';
import { AppError, conflict } from '../../core/http/errors';
import { reviewDetail } from './admin';
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
