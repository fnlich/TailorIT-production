import type { ActingTable } from '../../../core/feature';

// v34 FANOUT (PLAN G1): the routes of one action on several profiles are the signed-in person's own (`self`): whatever
// profile the tab works on, the request names its targets in its body (`'me'`, keys or `'all'`) and the router checks
// each one itself (targets.ts: a live grant holding the action's box, through core/auth/grants.ts), counting each
// shared profile's call in its activity. A tab acting on a profile that ended still reaches them (the answer carries
// X-TailorIT-Profile-State: ended, as every `self` route's does).
export const PROFILES_ACTING = {
  'POST /jobs/save': 'self',
  'GET /jobs/save-all/preview': 'self',
  'POST /jobs/save-all': 'self',
  'POST /jobs/add': 'self',
  'GET /jobs/saved-on': 'self',
  'POST /applications/copy': 'self',
  'POST /applications/bulk': 'self',
  'PATCH /prepare/filters': 'self',
  'PATCH /prepare/settings': 'self',
  'PATCH /auto-apply/rule': 'self',
  'GET /settings': 'self',
} as const satisfies ActingTable;
