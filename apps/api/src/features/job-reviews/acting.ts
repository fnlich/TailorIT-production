import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §3): Admin › Review (the reviews and the Flags lane) is an
// administrator's own: never done on a profile shared with the signed-in person (adminRouter refuses a named profile
// too). A person's own reports go through the jobs and autofill routes.

/** /api/admin/reviews and /api/admin/flags: every route. */
export const JOB_REVIEWS_ACTING: ActingSpec = 'never';
