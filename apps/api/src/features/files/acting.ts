import type { ActingTable } from '../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Documents": "single downloads come with Documents"): an uploaded file
// and its thumbnail are the profile's documents: Documents' See. The browser may load them itself (a link, an image), so
// the query form (?profile=, SHARE-4's profileUrl) is taken.

/** /api/files. */
export const FILES_ACTING = {
  'GET /:id': { policy: 'documents:view', query: true },
  'GET /:id/thumbnail': { policy: 'documents:view', query: true },
} as const satisfies ActingTable;
