import type { DbQueries } from '../../../core/db/types';
import { projectJob } from '../../../core/seams';

// v36 IMPORTTIME (SP v36 PLAN.md I1, the owner's addendum of 2026-11-23: "when admin import the jobs, post time or
// reposted time of all imported jobs will be today ... so that user can see all imported jobs by admin in today
// filter"): every job an admin's import brings in counts as posted at the import, whatever date its board gives.
//   - jobs.reposted_at (migration 0057) = the import's time, in the transaction that creates, reposts or holds the job:
//     a new job TailorIT's read made (published or held: autofill/jobs.ts readAndStore, page.ts readPageToSharedJob,
//     through the import's ImportRead), a job made from a row TailorIT could not read and a known job held again for
//     Couldn't verify (import-jobs.ts holdImported), a held job the import names (import-pipeline.ts heldAgain), and
//     v3.5's reposts (import-jobs.ts repostJob);
//   - a job that waits in Admin › Review after an admin's import is dated again when it is approved (it reaches people
//     then): approve.ts (Couldn't verify), job-reviews/decide.ts (New jobs): a review or note of the import's, or a held
//     job an import named while it waited (DATE_APPROVED_SQL);
//   - the job's own posted date (jobs.posted_at) is kept; search sorts and filters from the later of the two (the
//     search projection's GREATEST), and every place a person reads a posting time shows the later one ("Reposted
//     today" beside "Posted 3 weeks ago" in the header, "Reposted 1 hour ago" on a row: v3.5's words);
//   - never moved back (GREATEST), and no source run, re-verification sweep or re-read writes it.
// Rows an import does not bring in (Closed, Needs a title and company, Can't import, over a limit, a repeat) date
// nothing, and people's own imports never do (their board's date counts, as before).

/**
 * Dates a shared job at an admin's import (or the approval that publishes it): binds [at, jobId]. The caller re-projects
 * the job (projectJob) in the same transaction.
 */
export const DATE_IMPORTED_SQL =
  'UPDATE jobs SET reposted_at = GREATEST(reposted_at, CAST(? AS timestamptz)) WHERE id = ? AND owner_user_id IS NULL';

/**
 * An approval that publishes a held job now dates it when an admin's import brought it in: its review or note is the
 * import's (`imported`), or an import named it while it waited (dated already: a job a person's add held, "Already
 * waiting for review"). Binds [at, jobId, imported]. The caller re-projects the job in the same transaction.
 */
export const DATE_APPROVED_SQL =
  `${DATE_IMPORTED_SQL} AND held_since IS NOT NULL AND (reposted_at IS NOT NULL OR CAST(? AS boolean))`;

/** Dates a shared job at an admin's import (see the top) and rebuilds its search row. In the caller's transaction. */
export async function dateImported(t: DbQueries, jobId: number, at: string): Promise<void> {
  const { changes } = await t.run(DATE_IMPORTED_SQL, [at, jobId]);
  if (changes > 0) await projectJob(t, jobId);
}
