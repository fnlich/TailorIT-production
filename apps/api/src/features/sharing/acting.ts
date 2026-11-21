import type { ActingTable } from '../../core/feature';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §2 "Routes", §3): what each sharing route does when a request names a
// shared profile (SHARE-1's guard reads it from this feature's index). Reads are `self`: they always answer the
// signed-in person's own sharing (the profiles shared with them, their invites, the people they share with, the
// activity, the overview), whatever profile the tab works on. Every write is `never`: sharing itself is always locked,
// so nobody passes access on, accepts or leaves for someone else.
export const SHARING_ACTING = {
  'GET /profiles': 'self',
  'GET /grants': 'self',
  'GET /activity': 'self',
  'GET /overview': 'self',
  'POST /grants': 'never',
  'PATCH /grants/:key': 'never',
  'POST /grants/:key/stop': 'never',
  'POST /profiles/:key/accept': 'never',
  'POST /profiles/:key/decline': 'never',
  'POST /profiles/:key/leave': 'never',
} as const satisfies ActingTable;
