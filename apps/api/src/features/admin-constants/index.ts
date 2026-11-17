import type { Feature } from '../../core/feature';
import { createAdminConstantsRouter } from './router';

// v2.0 (P6b): Admin › Constants, GET /api/admin/constants, PUT and DELETE /api/admin/constants/:key, through the
// constants service (core/constants: list, set, clear). Admin only.
export const adminConstantsFeature: Feature = {
  name: 'admin-constants',
  routes: [{ path: '/api/admin/constants', router: createAdminConstantsRouter }],
};
