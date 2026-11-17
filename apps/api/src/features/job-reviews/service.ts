import type { AdminReviewBulkBody, AdminReviewBulkResultSchema, AdminReviewDecisionBody, AdminReviewDetail } from '@tailorit/shared';
import type { z } from 'zod';
import type { AdminActor } from '../../core/admin/index';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { reviewDetail } from './admin';
import { approveReview, rejectReview, reopenReview, runFollowUps, type FollowUp } from './decide';
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
  const found = await deps.db.tx(
    async (t): Promise<{ followUps: FollowUp[] } | null> => {
      const review = await reviewById(t, id, true);
      if (!review) return null;
      if (body.decision === 'approve') return { followUps: await approveReview(deps, t, review, decider, at) };
      if (body.decision === 'reject') await rejectReview(t, review, decider, at);
      else await reopenReview(deps, t, review, decider.note, now);
      return { followUps: [] };
    },
    { label: 'decide review' },
  );
  if (!found) return null;
  await runFollowUps(deps, found.followUps);
  return reviewDetail(deps, id);
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
      const outcome = await deps.db.tx(
        async (t): Promise<{ result: BulkResult['results'][number]; followUps: FollowUp[] }> => {
          const review = await reviewById(t, id, true);
          if (!review) return { result: { id, outcome: 'failed', message: 'That review was not found.' }, followUps: [] };
          if (review.state !== 'pending') return { result: { id, outcome: 'skipped', message: 'This review was decided already.' }, followUps: [] };
          if (bulk.decision === 'approve') {
            return { result: { id, outcome: 'approved' }, followUps: await approveReview(deps, t, review, decider, at) };
          }
          await rejectReview(t, review, decider, at);
          return { result: { id, outcome: 'rejected' }, followUps: [] };
        },
        { label: 'decide reviews' },
      );
      results.push(outcome.result);
      if (outcome.result.outcome === 'approved' || outcome.result.outcome === 'rejected') changed.push(id);
      await runFollowUps(deps, outcome.followUps);
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
