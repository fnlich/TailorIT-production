import type { ActingSpec, ActingTable } from '../../core/feature'; // v33 SHARE-6: ActingTable

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §3, §5): the AI job search on a profile shared with the signed-in person
// (B): B searches the jobs as A sees them (Job Tracker's See, as job_search tasks read with getTaskFor) and B pays, on
// B's plan (assertFeature(payer): a Free B gets 403 paid_feature on a Paid A's profile). The jobs feature's other mounts
// are SHARE-6's (wave 4).

/** /api/jobs/ai-search: POST /. */
export const AI_SEARCH_ACTING: ActingSpec = 'tracker:view';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Job Tracker": "applications, jobs with A's marks, saved searches";
// "Change: save, add, ..., Save all"; §4 "Explicit changes"): the Jobs page on a shared profile is the jobs as the owner
// sees them (their own jobs, their hidden and saved marks, their match): the Job Tracker's See. Opening a job never marks
// it viewed for the owner (jobs-router.ts), and a lazy analysis it asks for counts in the actor's hour. Hiding a job is
// the owner's mark (Change). A report goes to the administrators in the reporter's name (and counts in the reporter's
// day): never on someone else's profile (the person reports from their own). Save all saves into the owner's tracker
// (Change), its runs an hour counted for the actor (rateKeyOf); its confirm's numbers are a read. The saved searches are
// the owner's (See to read, Change to keep one).

/** /api/jobs/save-all. */
export const SAVE_ALL_ACTING = {
  'GET /preview': 'tracker:view',
  'POST /': 'tracker:edit',
} as const satisfies ActingTable;

/** /api/jobs: the list, the count, facets, matches, a job, its analysis, match and insights, hide, report. */
export const JOBS_ACTING = {
  'GET /': 'tracker:view',
  'GET /count': 'tracker:view',
  'GET /matches': 'tracker:view',
  'GET /facets/summary': 'tracker:view',
  'GET /facets/:facet': 'tracker:view',
  'GET /:id': 'tracker:view',
  'GET /:id/analysis': 'tracker:view',
  'GET /:id/match': 'tracker:view',
  'GET /:id/insights': 'tracker:view',
  'POST /:id/hide': 'tracker:edit',
  'DELETE /:id/hide': 'tracker:edit',
  'POST /:id/report': 'never',
} as const satisfies ActingTable;

/** /api/saved-searches. */
export const SAVED_SEARCHES_ACTING = {
  'GET /': 'tracker:view',
  'POST /': 'tracker:edit',
  'PATCH /:id': 'tracker:edit',
  'DELETE /:id': 'tracker:edit',
} as const satisfies ActingTable;
