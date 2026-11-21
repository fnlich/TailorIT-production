import type { Feature } from '../../core/feature';
import { ADMIN_CONSTANTS_ACTING } from './acting'; // v33 SHARE-6
import { createAdminConstantsRouter } from './router';

// v2.0 (P6b): Admin › Constants, GET /api/admin/constants, PUT and DELETE /api/admin/constants/:key, through the
// constants service (core/constants: list, set, clear). Admin only.
export const adminConstantsFeature: Feature = {
  name: 'admin-constants',
  routes: [{ path: '/api/admin/constants', router: createAdminConstantsRouter, acting: ADMIN_CONSTANTS_ACTING /* v33 SHARE-6 */ }],
};
