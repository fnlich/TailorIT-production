// v31 FIX-LINK: the SQL of a job a review holds, in a module that imports nothing (held.ts, autofill/jobs.ts and
// job-reviews/new-jobs.ts build SQL with it when they load: a leaf is never part of an import cycle, so it is always
// defined by then).

/**
 * The SQL condition of a job `j` held by a review (holdNewJob's `new_job` review, origin `ats`, subject 'job:<id>':
 * pending, or rejected: the job stays held). A new job's review never expires (job-reviews/housekeeping.ts). A held job
 * without one is held by the legacy pass (jobs/add/legacy.ts).
 */
export const REVIEW_HELD_SQL = `EXISTS (SELECT 1 FROM job_reviews r WHERE r.job_id = j.id AND r.kind = 'new_job' AND r.origin = 'ats'
  AND r.state IN ('pending', 'rejected'))`;
