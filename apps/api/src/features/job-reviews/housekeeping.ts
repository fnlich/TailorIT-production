import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';
import { DAY_MS } from '@tailorit/shared';

// v30 X1-API: the reviews' daily housekeeping (docs/design/part2/14-extension-reports.md §5.1 step 7, §8, §9), each a
// Feature.daily step, in batches:
// - expire: a pending closed review with no new report for EXT_REVIEW_EXPIRE_DAYS becomes `expired` (a new job's review
//   never expires: its job stays held, and its adders' tracker entries with it, until an admin decides);
// - prune: a decided review older than EXT_REVIEW_KEEP_DAYS is deleted with its report rows and checks (who reported is
//   kept no longer than that, 14 §8). v30 FIX-B (REV-BEH's known item): a REJECTED new job's review stays while its
//   posting can come back (an ATS job still held, or a page posting: any account may capture it again), so a later add
//   bumps the admin's rejection (new-jobs.ts reviewForAdd) instead of opening a fresh pending review of a job the admin
//   rejected; only its report rows older than EXT_REVIEW_KEEP_DAYS go (they name the accounts).

/** Rows one statement changes at most. */
const BATCH = 1000;
/** Batches one pass runs at most (the next day's pass takes the rest). */
const MAX_BATCHES = 100;

async function inBatches(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const changed = await run();
    total += changed;
    if (changed < BATCH) break;
  }
  return total;
}

/** Pending closed reviews quiet for EXT_REVIEW_EXPIRE_DAYS become `expired`. Answers how many. */
export async function expireQuietReviews(deps: AppDeps): Promise<number> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - constantsOf(deps).get('EXT_REVIEW_EXPIRE_DAYS') * DAY_MS).toISOString();
  const at = now.toISOString();
  return inBatches(async () => {
    const { changes } = await deps.db.run(
      `UPDATE job_reviews SET state = 'expired', decided_at = ?, updated_at = ? WHERE id IN (
         SELECT id FROM job_reviews WHERE kind = 'closed' AND state = 'pending' AND last_reported_at < ? ORDER BY id LIMIT ${BATCH})`,
      [at, at, cutoff],
    );
    return changes;
  });
}

/** A rejected new job's review that stays (see above): its ATS job is still held, or it is a page posting's. */
const KEPT_REJECTION = `v.kind = 'new_job' AND v.state = 'rejected'
  AND (v.origin = 'page' OR EXISTS (SELECT 1 FROM jobs j WHERE j.id = v.job_id AND j.held_since IS NOT NULL))`;

/**
 * Decided reviews older than EXT_REVIEW_KEEP_DAYS go, with their report rows and checks; a kept rejection (see above)
 * loses only its report rows older than that. Answers how many reviews went.
 */
export async function pruneDecidedReviews(deps: AppDeps): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - constantsOf(deps).get('EXT_REVIEW_KEEP_DAYS') * DAY_MS).toISOString();
  const pruned = await inBatches(async () => {
    const { changes } = await deps.db.run(
      `DELETE FROM job_reviews WHERE id IN (
         SELECT v.id FROM job_reviews v WHERE v.state <> 'pending' AND v.decided_at < ? AND NOT (${KEPT_REJECTION})
         ORDER BY v.decided_at LIMIT ${BATCH})`,
      [cutoff],
    );
    return changes;
  });
  await inBatches(async () => {
    const { changes } = await deps.db.run(
      `DELETE FROM job_review_reports WHERE (review_id, user_id) IN (
         SELECT r.review_id, r.user_id FROM job_reviews v JOIN job_review_reports r ON r.review_id = v.id
         WHERE v.state = 'rejected' AND v.decided_at < ? AND r.updated_at < ? AND ${KEPT_REJECTION} LIMIT ${BATCH})`,
      [cutoff, cutoff],
    );
    return changes;
  });
  return pruned;
}

export const JOB_REVIEWS_DAILY: readonly DailyStep[] = [
  { name: 'expire-reviews', run: expireQuietReviews },
  { name: 'prune-reviews', run: pruneDecidedReviews },
];
