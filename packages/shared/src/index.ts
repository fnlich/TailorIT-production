// Public surface of @tailorit/shared. Each feature module is also importable on its own as `@tailorit/shared/<name>`
// (see package.json "exports"), which keeps web bundles small.
export * from './core/index';
export * from './auth/index';
export * from './ai/index';
export * from './format/index';
export * from './match/index';
export * from './jobs/index';
export * from './resume/index';
export * from './letters/index';
export * from './tracker/index';
export * from './ingest/index';
// v1.4 D: tailoring a resume and a cover letter for a job (POST /api/tailor).
export * from './tailor/index';
// v2.0: Prepare & Queue (it replaces v1.5's Prebuild), the central constants, the accounts, the announcements and the
// prepare filters.
export * from './prepare/index';
export * from './constants/index';
export * from './accounts/index';
export * from './announcements/index';
export * from './filters/index';
// end v2.0
// v30 CT: v3.0's job sourcing, companies and Admin › Review (also `@tailorit/shared/sourcing`, `/companies`, `/reviews`).
export * from './sourcing/index';
export * from './companies/index';
export * from './reviews/index';
