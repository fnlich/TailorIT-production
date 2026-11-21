import type { ActingTable } from '../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Documents"): the resume editor's skill picker. On a shared profile it
// is the owner's library (the shared one with the owner's own skills laid over it): reading it and grouping skills
// under its headings (a read: POST only for the list it takes) are Documents' See; a skill added to the owner's own list
// is Documents' Change, as the resume edit it comes with.

/** /api/skills. */
export const SKILLS_ACTING = {
  'GET /': 'documents:view',
  'POST /': 'documents:edit',
  'POST /group': 'documents:view',
} as const satisfies ActingTable;
