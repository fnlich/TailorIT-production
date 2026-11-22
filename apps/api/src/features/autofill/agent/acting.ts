import type { ActingTable } from '../../../core/feature';

// v33 SHARE-5 (PLAN F9; SP v33 PLAN-sharing.md §3, §4, §6): what each auto-apply agent route (agent/router.ts, mounted at
// /api/autofill) does when a request names a shared profile. The extension's own routes (the next job, a run's result,
// a tab it opened) serve its token, which is always its owner's own profile (a token naming a profile is refused before
// any route): `never`; so is POST /agent/queue, the direct queueing v2.0 removed (always refused, kept one release for an
// older page). The queue's reads need Prepare & queue's See; removing a job, clearing finished ones and Mark as applied
// are Queue changes (`queue:edit`); the auto-apply rule is a Job setting.
export const AGENT_ACTING = {
  'GET /agent/next': 'never',
  'POST /agent/:id/result': 'never',
  'POST /agent/:id/opened': 'never',
  'POST /agent/queue': 'never',
  'GET /agent/queue': 'prepare:view',
  'POST /agent/queue/:id/applied': 'queue:edit',
  'POST /agent/queue/clear-finished': 'queue:edit',
  'DELETE /agent/queue/:id': 'queue:edit',
  'GET /agent/settings': 'settings:view',
  'PUT /agent/settings': 'settings:edit',
  'PATCH /agent/settings': 'settings:edit', // v34 FANOUT
} as const satisfies ActingTable;
