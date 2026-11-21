import type { ActingSpec } from '../../../core/feature';

// v33 SHARE-6 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §3): Admin › Candidates (discovery) is an administrator's
// own: never done on a profile shared with the signed-in person (adminRouter refuses a named profile too).

/** /api/admin/candidates: every route. */
export const DISCOVERY_ACTING: ActingSpec = 'never';
