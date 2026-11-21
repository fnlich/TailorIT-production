import type { ActingTable } from '../../core/feature';

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §3 "Documents", §9 "Editors"): what the letter-template routes do on a
// profile shared with the signed-in person (B): reading A's templates (and the system ones) is Documents' See;
// writing, importing and duplicating is Documents' Change. The export is fetched by the page (the header),
// never loaded by the browser.
// v33 FIX-2 (final review, sharing 3; a decision for the owner): deleting a template, one or in bulk, is `never` while
// acting (Documents' Change edits, never deletes; as the Job Tracker's delete, SHARE-9).

/** /api/cover-letter-templates. */
export const COVER_LETTER_TEMPLATES_ACTING: ActingTable = {
  'GET /': 'documents:view',
  'POST /': 'documents:edit',
  'POST /bulk-delete': 'never', // v33 FIX-2
  'POST /upload': 'documents:edit',
  'GET /:id': 'documents:view',
  'PATCH /:id': 'documents:edit',
  'DELETE /:id': 'never', // v33 FIX-2
  'POST /:id/duplicate': 'documents:edit',
  'POST /:id/import': 'documents:edit',
  'GET /:id/preview': 'documents:view',
  'GET /:id/export': 'documents:view',
};
