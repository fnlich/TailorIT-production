import type { ActingTable } from '../../core/feature';

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §3, §5): what the tailoring routes do on a profile shared with the
// signed-in person (B). Tailoring is a Documents change (the grid's "Change: edits, uploads, Tailor, bullets, copies"):
// B tailors A's resume and pays for it (payerOf: B's plan, budget, credit and tailorings an hour). Reading a tailoring's
// progress and the template list is Documents' See. The extension's token never names a profile (attachActing refuses
// it), so on /api/autofill these policies are the Settings page's.

/** /api/tailor (the web pages). */
export const TAILOR_ACTING: ActingTable = {
  'POST /': 'documents:edit',
  'GET /:taskId': 'documents:view',
};

/** /api/autofill's tailoring routes (the Settings page; a token never acts). */
export const AUTOFILL_TAILOR_ACTING: ActingTable = {
  'POST /tailor': 'documents:edit',
  'GET /tailor/:id': 'documents:view',
  'GET /templates': 'documents:view',
};
