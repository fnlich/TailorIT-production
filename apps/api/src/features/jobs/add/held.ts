import { jobReviewSubject, type JobAddState } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { projectJob } from '../../../core/seams';
import { openReview } from '../../job-reviews/store';
import { REVIEW_HELD_SQL } from './review-held';

// v31 FIX-LINK (REV-BEH BEH-4, decision D12; docs/design/v3.1/21-jobs-from-links.md §6, §9): what TailorIT's own read
// does to a job it already had that the legacy pass holds. Two kinds of hold exist:
//   - a review's: a new job held for Admin › Review (NEW_JOBS_ADMIN_APPROVAL, or D12's page jobs), its `new_job` review
//     pending or rejected: only an admin's decision ends it;
//   - the legacy pass's (legacy.ts): a job stored before v3.1 from what a row or a browser said, held until TailorIT
//     reads its link: no review.
// A read that lands on a legacy-held job (the store's dedupe: an add's, a queued link's, the legacy row's own) settles it
// at once, in the read's transaction: the store rewrote it from the read (a reader outranks a row: store.ts), so it is
// published, or, for a page read while PAGE_JOBS_AUTO_PUBLISH is off (any read while NEW_JOBS_ADMIN_APPROVAL is on),
// handed to Admin › Review (its new-job review opened: waiting for an admin, D12). Its legacy read is then done.

// The SQL condition of a job `j` a review holds: review-held.ts (a leaf module), re-exported.
export { REVIEW_HELD_SQL };

/**
 * v35 IMPORT: a held import job's AI input back as its sources say (bool_and of their ai_input) once it is published (an
 * approval, or a read that settled it): import-jobs.ts kept it out of the AI job analysis while held. Binds the job id.
 */
export const RESTORE_AI_INPUT_SQL = `UPDATE jobs j SET ai_input = COALESCE((SELECT bool_and(s.ai_input) FROM job_source_links l
    JOIN job_sources s ON s.id = l.source_id WHERE l.job_id = j.id), true)
  WHERE j.id = ? AND NOT j.ai_input
    AND EXISTS (SELECT 1 FROM job_verifications v WHERE v.job_id = j.id AND v.origin = 'import' AND v.user_id IS NULL)`;

/** Whether a shared job is held by the legacy pass (held, and no review holds it). */
export async function legacyHeld(db: DbQueries, jobId: number): Promise<boolean> {
  const row = await db.one<{ found: number }>(
    `SELECT 1 AS found FROM jobs j WHERE j.id = ? AND j.owner_user_id IS NULL AND j.held_since IS NOT NULL AND NOT ${REVIEW_HELD_SQL}`,
    [jobId],
  );
  return row !== undefined;
}

/**
 * Whether a read's new job waits for an admin (D12): a page read (no ATS API) while PAGE_JOBS_AUTO_PUBLISH is off, or
 * any read while NEW_JOBS_ADMIN_APPROVAL is on; never a read under a source an admin enabled (its runs list it anyway),
 * nor one an admin's approval asked for (`approved`).
 */
export function readWaitsForAdmin(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  read: { page: boolean; sourceEnabled: boolean; approved?: boolean },
): boolean {
  if (read.approved || read.sourceEnabled) return false;
  const constants = constantsOf(deps);
  return constants.get('NEW_JOBS_ADMIN_APPROVAL') || (read.page && !constants.get('PAGE_JOBS_AUTO_PUBLISH'));
}

/**
 * Settles a legacy-held job TailorIT's read landed on (see the top), in the read's transaction. Answers the job's state
 * after it, or null when the job is no legacy-held job (not held, or a review holds it: nothing changes).
 */
export async function settleHeldAfterRead(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  t: DbQueries,
  jobId: number,
  read: { page: boolean; sourceEnabled: boolean; approved?: boolean; at: string },
): Promise<Extract<JobAddState, 'published' | 'waiting_admin'> | null> {
  if (!(await legacyHeld(t, jobId))) return null;
  let state: 'published' | 'waiting_admin';
  if (readWaitsForAdmin(deps, read)) {
    await openReview(t, { kind: 'new_job', subjectKey: jobReviewSubject(jobId), jobId, origin: 'ats', at: read.at });
    state = 'waiting_admin';
  } else {
    await t.run('UPDATE jobs SET held_since = NULL, updated_at = ? WHERE id = ? AND held_since IS NOT NULL', [read.at, jobId]);
    await projectJob(t, jobId);
    state = 'published';
  }
  // v35 IMPORT: a job an admin import's row made was kept out of the AI job analysis while held (import-jobs.ts): read
  // now (TailorIT's own words), it goes back in as its sources say, before its note goes.
  await t.run(RESTORE_AI_INPUT_SQL, [jobId]);
  // Its legacy read is done: the "Couldn't verify" note with no adder, and its queued row (one being read now ends
  // as it ends: legacy.ts finds the job settled).
  await t.run('DELETE FROM job_verifications WHERE job_id = ? AND user_id IS NULL', [jobId]);
  await t.run(
    `UPDATE job_link_queue SET state = 'done', result = ?, reason = NULL, job_id = ?, lease_until = NULL, done_at = ?
     WHERE for_job_id = ? AND origin = 'legacy' AND state = 'queued'`,
    [state, jobId, read.at, jobId],
  );
  return state;
}
