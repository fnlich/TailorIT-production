import type { AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types';
import type { JobReviewsSeam, JobReviewSupersedeReason } from '../../core/seams';

// v30 X1-API: jobReviews, what the other packages tell the extension's reviews (core/seams.ts JobReviewsSeam; 14 §5.1
// step 6, §5.2 step 5, §11). Callers import jobReviews from core/seams. Both run in the caller's transaction and read
// nothing outside it.
// - supersede: the jobs' pending reviews (any kind) close as `superseded`, decided by `source`: a source run listed a
//   held job (`listed`: DB-INGEST's store, which clears held_since and projects the job itself), or a purge closed its
//   jobs (`purged`: S1-API). Their words are REVIEW_STATE_LABEL's "Listed by its source".
// - reopenedBySource: a source's listing or own read reopened a job that an approved closed review had closed: the
//   review stays `approved` (its link was closed then) and gets reopened_at (migrations-pg/0015), "Reopened by its
//   source", which the trust rule counts against its reporters (trust.ts).

/** How many job ids one statement names at most (a purge's batch is 1,000). */
const IDS_PER_STATEMENT = 1000;

async function supersede(
  _deps: AppDeps,
  t: DbTx,
  input: { jobIds: readonly number[]; reason: JobReviewSupersedeReason; at: string },
): Promise<number> {
  const ids = [...new Set(input.jobIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  let closed = 0;
  for (let start = 0; start < ids.length; start += IDS_PER_STATEMENT) {
    const batch = ids.slice(start, start + IDS_PER_STATEMENT);
    const { changes } = await t.run(
      `UPDATE job_reviews SET state = 'superseded', decided_by = 'source', decided_by_user = NULL, decided_at = ?, updated_at = ?
       WHERE state = 'pending' AND job_id IN (SELECT CAST(value AS bigint) FROM ${t.dialect.jsonEach('?')})`,
      [input.at, input.at, JSON.stringify(batch)],
    );
    closed += changes;
  }
  return closed;
}

async function reopenedBySource(_deps: AppDeps, t: DbTx, input: { jobId: number; at: string }): Promise<void> {
  await t.run(
    `UPDATE job_reviews SET reopened_at = ?, updated_at = ?
     WHERE job_id = ? AND kind = 'closed' AND state = 'approved' AND reopened_at IS NULL`,
    [input.at, input.at, input.jobId],
  );
}

/** What the other packages tell the extension's reviews (core/seams.ts JobReviewsSeam). */
export const jobReviews: JobReviewsSeam = { supersede, reopenedBySource };
