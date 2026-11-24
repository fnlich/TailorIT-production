import type { ActingTable } from '../../core/feature';

// v33 SHARE-5 (PLAN F9; SP v33 PLAN-sharing.md §3, §4 "Sensitive facts and what can be inferred"): the prepare filters
// on a shared profile. Reading them and the preview are Prepare's See; changing them is a Job setting (the
// Prepare settings). Without the Sensitive answers permission the eligibility switches read as off and a change keeps
// the stored ones (router.ts), and the preview treats the owner's citizenship and clearance as unknown.
export const PREPARE_FILTERS_ACTING = {
  'GET /': 'prepare:view',
  'PUT /': 'settings:edit',
  'PATCH /': 'settings:edit', // v34 FANOUT: some of the filters, the same rules as the PUT
  'POST /preview': 'prepare:view',
} as const satisfies ActingTable;
