import type { ActingSpec } from '../../core/feature';

// v33 SHARE-1 (PLAN F9 "Per-person, self"; SP v33 PLAN-sharing.md §3): the public constants (limits, messages) are the
// same for everyone, so a tab acting on a shared profile reads them as the signed-in person.

/** /api/constants: GET /public. */
export const PUBLIC_CONSTANTS_ACTING: ActingSpec = 'self';

/**
 * v33 SHARE-3 (PLAN-sharing §4 "Mixed routes"): /api/account, GET / (the account summary). `self`: B's plan, credit and
 * features always (B pays for what B does on any profile), and while the request names a live shared profile, that
 * profile's resume room and auto-applies plus `profile` (router.ts). It reads no document, answer or setting of A's, so
 * it needs no box: every page of a shared profile shows the usage chip and the resume room.
 */
export const ACCOUNT_ACTING: ActingSpec = 'self';
