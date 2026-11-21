import type { ActingTable } from '../../core/feature';

// v33 SHARE-9 (PLAN F9; SP v33 PLAN-sharing.md §3 "Job Tracker" and "Exports", §8 "The Tracker's All profiles view"):
// what each /api/applications route does when a request names a shared profile (SHARE-1's guard reads this table from
// the feature's index). The Job Tracker row of the grid: reading the applications (the board, the list, the counts,
// the chart, an application, its questions, its resume match) needs `tracker:view`; every change (add, save, status,
// dates, notes, favorite, archive and restore, questions, bulk, archive all, import) needs `tracker:edit`; the CSV export
// is `exports` (it implies `tracker:view`). The board's lanes are the person's own (`/api/me/tracker-lanes`, `self`:
// SHARE-1). The other features mounted at /api/applications (prepare's draft, resume-match, resume-zip) declare their own.
//
// v33 SHARE-9 fix (review): F9's Change box is "save, add, status, notes, archive, import, Save all": a grantee archives
// but never deletes (deleting takes the submitted answers, Prepare's work and the apply history with it), so
// `DELETE /:id` is `never` and the router refuses `POST /bulk`'s `delete` while acting. An application's cover letters
// are Documents (`documents:view`, PLAN-sharing.md §3), not the Job Tracker.
//
// Two reads carry what a B without the sensitive permission must never see (PLAN-sharing.md §4 "Sensitive facts"):
// - the submitted answers keep every sensitive row (EEO, visa, disability, veteran, pay): `never` until the router leaves
//   those rows out for an actor without `sensitive:view`; then `tracker:view` (`sensitive:view` alone would open a Job
//   Tracker read to a grant without it);
// - one apply record's documents carry the answers it was sent with (`answersUsed`, sensitive ones included) and the
//   resume and letter themselves: `never` until the router masks the answers (sensitive:view) and the documents
//   (documents:view); then `tracker:view`.
// v33 SHARE-6 (SHARE-9's edit 1): both are filtered now (router.ts: the submitted answers without every sensitive row,
// an apply record's kept answers likewise and its resume and letter only with Documents' See): `tracker:view`.
export const APPLICATIONS_ACTING = {
  // Reads: tracker:view.
  'GET /board': 'tracker:view',
  'GET /counts': 'tracker:view',
  'GET /companies': 'tracker:view',
  'GET /sankey': 'tracker:view',
  'GET /insights': 'tracker:view',
  'GET /': 'tracker:view',
  'GET /:id': 'tracker:view',
  'GET /:id/apply-records': 'tracker:view',
  'GET /:id/cover-letters': 'documents:view', // v33 SHARE-9 fix
  'GET /:id/resume-score': 'tracker:view',
  'GET /:id/questions': 'tracker:view',
  'GET /:id/submitted-answers': 'tracker:view', // v33 SHARE-9 fix; SHARE-6: sensitive rows left out (router.ts)
  'GET /:id/apply-records/:recordId/documents': 'tracker:view', // v33 SHARE-6: masked (router.ts)
  // The CSV export (fetched with the profile header, never loaded by the browser itself: no `query`).
  'GET /export.csv': 'exports',
  // Changes: tracker:edit (the import wizard's company lookup is part of importing).
  'POST /import': 'tracker:edit',
  'POST /import/companies': 'tracker:edit',
  'POST /bulk': 'tracker:edit',
  'POST /archive-all': 'tracker:edit',
  'POST /': 'tracker:edit',
  'PATCH /:id': 'tracker:edit',
  'DELETE /:id': 'never', // v33 SHARE-9 fix
  'PUT /:id/status': 'tracker:edit',
  'PUT /:id/events/:status': 'tracker:edit',
  'DELETE /:id/events/:status': 'tracker:edit',
  'POST /:id/archive': 'tracker:edit',
  'POST /:id/restore': 'tracker:edit',
  'POST /:id/questions': 'tracker:edit',
  'PATCH /:id/questions/:questionId': 'tracker:edit',
  'DELETE /:id/questions/:questionId': 'tracker:edit',
} as const satisfies ActingTable;
