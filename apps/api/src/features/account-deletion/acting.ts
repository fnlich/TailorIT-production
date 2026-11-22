import type { ActingSpec } from '../../core/feature';

// v34 ACCTDEL (PLAN G10): deleting an account is the signed-in person's own act on their own account: never done while
// the tab works on a profile someone shared with them (403 own_profile_only), so nobody a profile is shared with can
// delete its owner's account. Admin › Users' Delete account is admin-users' (`never` too: ADMIN_USERS_ACTING).

/** /api/account/delete: GET / (may the person delete their account now) and POST / (delete it). */
export const ACCOUNT_DELETION_ACTING: ActingSpec = 'never';
