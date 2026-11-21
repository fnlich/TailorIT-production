import type { ActingTable } from '../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Job Tracker": "applications, jobs with A's marks, saved searches and
// resume match"): the tracker's resume picker on a shared profile. Ranking the owner's resumes for an application is the
// Job Tracker's See; "Let TailorIT choose" sets the application's resume, the Job Tracker's Change.

/** The resume-match feature's /api/applications mount. */
export const RESUME_MATCH_ACTING = {
  'GET /:id/resume-matches': 'tracker:view',
  'POST /:id/resume-match': 'tracker:edit',
} as const satisfies ActingTable;
