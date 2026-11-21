import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §3): Admin › AI (health, capacity, usage, background
// work, the test call) is an administrator's own: never done on a profile shared with the signed-in person (adminRouter
// refuses a named profile too: core/admin/resource.ts), and a shared profile carries no admin power (userOf's role is
// `user` there).

/** /api/admin/ai: every route. */
export const ADMIN_AI_ACTING: ActingSpec = 'never';
