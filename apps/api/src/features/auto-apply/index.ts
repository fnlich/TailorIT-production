import type { Feature } from '../../core/feature';
import { createAutoApplyRouter } from './router';

// v2.0: the Auto-Apply page's read models (05-prepare-flow.md, "Read models for the web"): GET /api/auto-apply/saved,
// /queue and /items/:queueId/kit. The queue's writes stay in features/autofill/agent (the extension's routes, Mark as
// applied, the queue insert at the end of a Prepare).

export const autoApplyFeature: Feature = {
  name: 'auto-apply',
  routes: [{ path: '/api/auto-apply', router: createAutoApplyRouter }],
};
