import type { Feature } from '../../core/feature';
import { AUTO_APPLY_ACTING } from './acting'; // v33 SHARE-5
import { createAutoApplyRouter } from './router';
import { endGrantQueueStep } from '../autofill/agent/held'; // v33 SHARE-5
import { registerEndGrantStep } from '../sharing/end-grant'; // v33 SHARE-5

// v2.0: the Auto-Apply page's read models (05-prepare-flow.md, "Read models for the web"): GET /api/auto-apply/saved,
// /queue and /items/:queueId/kit. The queue's writes stay in features/autofill/agent (the extension's routes, Mark as
// applied, the queue insert at the end of a Prepare).

// v33 SHARE-5 (PLAN F9; SP v33 PLAN-sharing.md §6 "endGrant"): ending a share removes the jobs it prepared that still
// wait for the owner's OK (and, when the owner asked, the approved ones no extension took yet).
registerEndGrantStep('queue', endGrantQueueStep);

export const autoApplyFeature: Feature = {
  name: 'auto-apply',
  routes: [{ path: '/api/auto-apply', router: createAutoApplyRouter, acting: AUTO_APPLY_ACTING /* v33 SHARE-5 */ }],
};
