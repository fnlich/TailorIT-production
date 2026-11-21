import type { ActingTable } from '../../core/feature';

// v33 SHARE-5 (PLAN F9 "Always locked", "Prepare and the queue"; SP v33 PLAN-sharing.md §3, §6): the Auto-apply page's
// routes on a shared profile. Its panes and kits are Prepare & queue's See. Approving the jobs someone the profile is
// shared with prepared (and removing them) is always the owner's own: `never` while a request names a shared profile, as
// is the list of what waits for that OK.
export const AUTO_APPLY_ACTING = {
  'GET /saved': 'prepare:view',
  'GET /queue': 'prepare:view',
  'GET /items/:queueId/kit': 'prepare:view',
  'GET /held': 'never',
  'POST /approve': 'never',
  'POST /reject': 'never',
} as const satisfies ActingTable;
