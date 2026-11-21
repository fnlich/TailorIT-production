import type { Feature } from '../../core/feature';
import { ADMIN_USERS_ACTING } from './acting'; // v33 SHARE-6
import { createAdminUsersRouter } from './router';

// Administrator: list accounts, change role, disable. Owned by work package F3. v2.0 (P6b): the paged list with each
// account's type, term, AI budget, credit and day so far; the entitlement, AI budget and credit changes; the history.
export const adminUsersFeature: Feature = {
  name: 'admin-users',
  routes: [
    { path: '/api/admin/users', router: createAdminUsersRouter, acting: ADMIN_USERS_ACTING /* v33 SHARE-6 */ },
  ],
};
