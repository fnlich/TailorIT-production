import type { ActingSpec, ActingTable } from '../../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Job Tracker": "Change: save, add, ..."; §4 "Explicit changes"): adding
// a job by its link (the Jobs page's Add job) and Retry read of a job only its adder sees are the Job Tracker's Change on
// a shared profile: the job and its tracker entry are the owner's, while the add takes one of the actor's own adds an
// hour (takeAddSlot(actorOf(req))), the outcome's notices go to the actor (who added it), and no admin power reaches a
// Retry read there. An administrator's links and the "Couldn't verify" list are Admin's: never.

/** /api/jobs: POST /add, POST /:id/verify; v35 IMPORT: a person's imports, as Add job (the Job Tracker's Change). */
export const JOB_LINKS_ACTING = {
  'POST /add': 'tracker:edit',
  'POST /:id/verify': 'tracker:edit',
  // v35 IMPORT (SP v35 PLAN.md H1 "On a shared profile a user import follows Add job's acting policy"): the jobs are
  // saved to the profile's Job Tracker; the rows count toward the person acting. Their results are the tracker's to see.
  'POST /imports/file/preview': 'tracker:edit',
  'POST /imports/file': 'tracker:edit',
  'GET /imports/sheet/account': 'tracker:edit',
  'POST /imports/sheet/preview': 'tracker:edit',
  'POST /imports/sheet': 'tracker:edit',
  'GET /imports/:id': 'tracker:view',
  // v35 FIX-STORE (the fix list's item 9; the final review's S4): the profile's imports (the latest on every device) and
  // "Download these rows", the tracker's to see as the results are.
  'GET /imports/recent': 'tracker:view',
  'GET /imports/:id/needs-details.csv': 'tracker:view',
} as const satisfies ActingTable;

/** /api/admin/jobs: every route. */
export const ADMIN_JOB_LINKS_ACTING: ActingSpec = 'never';

/** v35 IMPORT: /api/admin/imports (Admin › Import): every route. */
export const ADMIN_IMPORTS_ACTING: ActingSpec = 'never';
