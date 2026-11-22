import type { ActingTable } from '../../core/feature';

// v33 SHARE-5 (PLAN F9; SP v33 PLAN-sharing.md §3, §4, §6): what each Prepare & Queue route does when a request names a
// shared profile. B prepares A's saved jobs with Prepare & queue's Change (`prepare:run`: Prepare, Prepare All and its
// plan, cancelling the Prepares B started); B pays (payerOf: B's AI budget, B's Prepares an hour) within B's room on A's
// profile (A's last queue and resume places are kept). The Prepare settings are Job settings. The Tracker's "Prepared"
// tab (a kit) is Prepare & queue's See.
export const PREPARE_ACTING = {
  'POST /': 'prepare:run',
  'GET /all': 'prepare:run',
  'POST /all': 'prepare:run',
  'GET /settings': 'settings:view',
  'PUT /settings': 'settings:edit',
  'PATCH /settings': 'settings:edit', // v34 FANOUT
  'POST /:id/cancel': 'prepare:run',
} as const satisfies ActingTable;

/** The prepare feature's /api/applications mount: the kit of an entry (GET /api/applications/:id/draft). */
export const APPLICATION_DRAFT_ACTING = {
  'GET /:id/draft': 'prepare:view',
} as const satisfies ActingTable;
