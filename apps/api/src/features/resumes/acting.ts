import type { ActingTable } from '../../core/feature';

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §3 "Documents", §4 "Where applications go", §5): what the resume routes do
// on a profile shared with the signed-in person (B). Reading A's resumes (lists, the editor, what TailorIT read, the
// page check, thumbnails, downloads) is Documents' See; every change (make, upload, import, save, rename,
// duplicate, the editable copy, Write with AI, the Field, photos, the copy line's buttons) is Documents' Change, and B
// pays for the AI it starts (payerOf), never takes A's last resume places, and leaves A's contact email and phone as
// they are. Addresses the browser loads itself (a photo, an upload's file, a download) name the profile in the query
// (SHARE-4's profileUrl): `query: true`.
// v33 FIX-2 (final review, sharing 3; a decision for the owner): Documents' Change edits, uploads, tailors and copies
// (PLAN F9's box), never deletes: deleting a resume (one or in bulk) takes the owner's original upload or their work for
// good, so it is `never` while acting, as the Job Tracker's delete is (SHARE-9). The owner deletes on their own profile.

/** /api/resumes/copies (the copy line's view and buttons). */
export const RESUME_COPIES_ACTING: ActingTable = {
  'GET /': 'documents:view',
  'POST /:batchId/stop': 'documents:edit',
  'POST /:batchId/retry': 'documents:edit',
  'POST /:batchId/dismiss': 'documents:edit',
};

/** /api/resumes/photos. */
export const RESUME_PHOTOS_ACTING: ActingTable = {
  'POST /': 'documents:edit',
  'GET /:id': { policy: 'documents:view', query: true },
};

/** /api/resumes, the Field routes (ROLES). */
export const RESUME_ROLE_FAMILY_ACTING: ActingTable = {
  'GET /:id/role-family': 'documents:view',
  'PUT /:id/role-family': 'documents:edit',
};

/** /api/resumes. */
export const RESUMES_ACTING: ActingTable = {
  'GET /': 'documents:view',
  'POST /': 'documents:edit',
  'POST /bulk-delete': 'never', // v33 FIX-2
  'POST /upload': 'documents:edit',
  'POST /import-json': 'documents:edit',
  'POST /bullets': 'documents:edit',
  'GET /:id': 'documents:view',
  'POST /:id/layout': 'documents:view',
  'GET /:id/editor': 'documents:view',
  'GET /:id/analysis': 'documents:view',
  'PUT /:id': 'documents:edit',
  'PATCH /:id': 'documents:edit',
  'DELETE /:id': 'never', // v33 FIX-2
  'POST /:id/duplicate': 'documents:edit',
  'POST /:id/parse': 'documents:edit',
  'POST /:id/edit': 'documents:edit',
  'GET /:id/thumbnail': 'documents:view',
  'GET /:id/export': { policy: 'documents:view', query: true },
  'GET /:id/file': { policy: 'documents:view', query: true },
};

/** /api/ai/resume-bullets (Write with AI). */
export const RESUME_BULLETS_ACTING: ActingTable = {
  'POST /': 'documents:edit',
};
