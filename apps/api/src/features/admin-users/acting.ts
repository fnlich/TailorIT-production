import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §3): Admin › Users (roles, disabling, plans, AI budgets,
// credit, history) is an administrator's own: never done on a profile shared with the signed-in person (adminRouter
// refuses a named profile too).

/** /api/admin/users: every route. */
export const ADMIN_USERS_ACTING: ActingSpec = 'never';
