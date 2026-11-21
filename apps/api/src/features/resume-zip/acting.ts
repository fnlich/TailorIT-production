import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Exports": "Tracker CSV and resume ZIP"): the resume ZIP (the Job
// Tracker's Build resumes, the Documents page's batch download), its progress and its file are Exports (which implies
// the Job Tracker's and Documents' See). B's plan decides the batch download (assertFeature(payerOf(req)): SHARE-3). The
// file is fetched by the page with the profile header (downloadFrom), never loaded by the browser itself: no `query`.

/** /api/applications/resume-zip: every route. */
export const RESUME_ZIP_ACTING: ActingSpec = 'exports';
