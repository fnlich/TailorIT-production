import type { DbQueries } from '../../core/db/types';

// v37 FIX-REV (SP v37 FIXES-361.md D1, REVIEW361-ux H1, the owner's "Workday closed job is represented as for review
// (not closed)"): a job that closes, by ANY path, leaves nothing waiting in Admin › Review. The one close function
// (ingest/close.ts closeOrphanJobs: closeLink, a source's listing, its own read, a purge, an admin's close, a source
// deleted, the store's own read of a closed posting) calls this in the same transaction, with the ids it closed now:
//   - its pending closed reports are approved and its pending New jobs review rejected, decided by the server
//     (`server_check`) with the close's note (MSG_REVIEW_CLOSED_CONFIRMED when TailorIT's own read or listing found it
//     gone, MSG_REVIEW_JOB_CLOSED for a report, a purge or an admin): visible under Decided;
//   - its open flags are resolved by the server (resolved_by FLAG_RESOLVED_WITH_JOB: "Resolved by TailorIT · The job
//     closed" under Decided; an admin may reopen one);
//   - its Couldn't verify notes go (an import's, a person's own): a closed job is nothing to verify (the person sees it
//     Closed, with no Retry read).
// Pure statements (one round trip), no seam: ingest/close.ts imports it without a cycle. An approval that closes the job
// itself (job-reviews/decide.ts) marks its own review decided first, so it keeps the admin's (or the rule's) decision.

/**
 * job_reports.resolved_by of a flag the server resolved because its job closed (the column holds an admin's id
 * otherwise; no account id has this shape). admin.ts toFlag answers it as `jobClosed`, never as a resolver.
 */
export const FLAG_RESOLVED_WITH_JOB = 'tailorit:job_closed';

/** What one settle changed. */
export interface ClosedJobsSettled {
  reviews: number;
  flags: number;
  notes: number;
}

/** How many job ids one statement names at most (a purge's batch is 1,000). */
const IDS_PER_STATEMENT = 1000;

/**
 * Settles the reviews, flags and notes of `jobIds`, jobs that closed now (see the top), decided at `at` with `note`.
 * The caller's transaction.
 */
export async function settleClosedJobsIn(db: DbQueries, jobIds: readonly number[], at: string, note: string): Promise<ClosedJobsSettled> {
  const ids = [...new Set(jobIds.map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0);
  const settled: ClosedJobsSettled = { reviews: 0, flags: 0, notes: 0 };
  for (let start = 0; start < ids.length; start += IDS_PER_STATEMENT) {
    const batch = JSON.stringify(ids.slice(start, start + IDS_PER_STATEMENT));
    const row = await db.one<{ reviews: number; flags: number; notes: number }>(
      `WITH closed AS (SELECT CAST(value AS bigint) AS id FROM ${db.dialect.jsonEach('?')}),
       reviews AS (
         UPDATE job_reviews SET state = CASE WHEN kind = 'closed' THEN 'approved' ELSE 'rejected' END,
           decided_by = 'server_check', decided_by_user = NULL, decided_at = ?, note = ?, updated_at = ?
         WHERE state = 'pending' AND kind IN ('closed', 'new_job') AND job_id IN (SELECT id FROM closed) RETURNING 1),
       flags AS (
         UPDATE job_reports SET status = 'resolved', resolved_at = ?, resolved_by = ?
         WHERE status = 'open' AND job_id IN (SELECT id FROM closed) RETURNING 1),
       notes AS (DELETE FROM job_verifications WHERE job_id IN (SELECT id FROM closed) RETURNING 1)
       SELECT (SELECT count(*) FROM reviews) AS reviews, (SELECT count(*) FROM flags) AS flags, (SELECT count(*) FROM notes) AS notes`,
      [batch, at, note, at, at, FLAG_RESOLVED_WITH_JOB],
    );
    settled.reviews += Number(row?.reviews ?? 0);
    settled.flags += Number(row?.flags ?? 0);
    settled.notes += Number(row?.notes ?? 0);
  }
  return settled;
}
