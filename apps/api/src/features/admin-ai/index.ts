import type { Feature } from '../../core/feature';
import { ADMIN_AI_ACTING } from './acting'; // v33 SHARE-6
import { createAdminAiRouter } from './router';

// Administrator: Claude CLI health and a test prompt. Owned by work package F4.
export const adminAiFeature: Feature = {
  name: 'admin-ai',
  routes: [{ path: '/api/admin/ai', router: createAdminAiRouter, acting: ADMIN_AI_ACTING /* v33 SHARE-6 */ }],
};
