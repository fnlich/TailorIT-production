import type { ActingTable } from '../../core/feature';

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §3 "Documents", §5, §9 "Editors"): what the cover-letter routes do on a
// profile shared with the signed-in person (B). Reading A's letters is Documents' See; writing, importing and
// having TailorIT write one (B pays: payerOf) is Documents' Change. The editor's fonts are the same for everyone (no
// profile). The PDF/DOCX download is loaded by the browser itself (?profile=, SHARE-4's profileUrl): `query: true`.
// v33 FIX-2 (final review, sharing 3; a decision for the owner): deleting a letter, one or in bulk, is `never` while
// acting (Documents' Change edits, never deletes; as the Job Tracker's delete, SHARE-9).

/** /api/cover-letters. */
export const COVER_LETTERS_ACTING: ActingTable = {
  'GET /fonts.css': 'self',
  'GET /fonts/:file': 'self',
  'GET /': 'documents:view',
  'POST /': 'documents:edit',
  'POST /bulk-delete': 'never', // v33 FIX-2
  'POST /upload': 'documents:edit',
  'GET /:id': 'documents:view',
  'PATCH /:id': 'documents:edit',
  'DELETE /:id': 'never', // v33 FIX-2
  'POST /:id/import': 'documents:edit',
  'POST /:id/generate': 'documents:edit',
  'GET /:id/preview': 'documents:view',
  'GET /:id/export': { policy: 'documents:view', query: true },
};
