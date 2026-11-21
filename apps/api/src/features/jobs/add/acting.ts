import type { ActingSpec, ActingTable } from '../../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Job Tracker": "Change: save, add, ..."; §4 "Explicit changes"): adding
// a job by its link (the Jobs page's Add job) and Retry read of a job only its adder sees are the Job Tracker's Change on
// a shared profile: the job and its tracker entry are the owner's, while the add takes one of the actor's own adds an
// hour (takeAddSlot(actorOf(req))), the outcome's notices go to the actor (who added it), and no admin power reaches a
// Retry read there. An administrator's links and the "Couldn't verify" list are Admin's: never.

/** /api/jobs: POST /add, POST /:id/verify. */
export const JOB_LINKS_ACTING = {
  'POST /add': 'tracker:edit',
  'POST /:id/verify': 'tracker:edit',
} as const satisfies ActingTable;

/** /api/admin/jobs: every route. */
export const ADMIN_JOB_LINKS_ACTING: ActingSpec = 'never';
