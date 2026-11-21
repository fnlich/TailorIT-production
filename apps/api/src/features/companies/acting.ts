import type { ActingSpec, ActingTable } from '../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Job Tracker": "jobs with A's marks"): the company page on a shared
// profile shows the jobs as the owner sees them (their own jobs, their hidden marks): the Job Tracker's See; hiding or
// unhiding a company's jobs is the owner's mark, the Job Tracker's Change. The logos are the same files for everyone
// (no profile's data): `self`. Admin › Companies, its reviews and its opt-outs are an administrator's own: never.

/** /api/companies: the company page, its jobs, hide / unhide. */
export const COMPANIES_ACTING = {
  'GET /:id': 'tracker:view',
  'GET /:id/jobs': 'tracker:view',
  'POST /:id/hide': 'tracker:edit',
  'DELETE /:id/hide': 'tracker:edit',
} as const satisfies ActingTable;

/** /api/company-logos: the logo files. */
export const COMPANY_LOGOS_ACTING: ActingSpec = 'self';

/** /api/admin/companies, /api/admin/company-reviews, /api/admin/company-opt-outs. */
export const ADMIN_COMPANIES_ACTING: ActingSpec = 'never';
