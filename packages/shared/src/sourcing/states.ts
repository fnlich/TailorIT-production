// v30 CT: the closed lists of job sourcing's tables (docs/design/part2/11-database.md §5.3, §5.3a, §5.5; 12 §4, §8,
// §9), as their CHECKs write them, with the admin pages' words.

/** A source's cadence tier (12 §9.3). */
export const JOB_SOURCE_TIERS = ['hot', 'normal', 'quiet', 'empty', 'failing', 'not_found'] as const;
export type JobSourceTier = (typeof JOB_SOURCE_TIERS)[number];
export const JOB_SOURCE_TIER_LABEL: Record<JobSourceTier, string> = {
  hot: 'Hot',
  normal: 'Normal',
  quiet: 'Quiet',
  empty: 'Empty',
  failing: 'Failing',
  not_found: 'Not found',
};

/** Whether a source's terms allow automated access (the owner's rule: only allowed sources run). */
export const JOB_SOURCE_TERMS_STATUSES = ['unchecked', 'allowed', 'allowed_with_conditions', 'needs_contract', 'forbidden'] as const;
export type JobSourceTermsStatus = (typeof JOB_SOURCE_TERMS_STATUSES)[number];
export const JOB_SOURCE_TERMS_LABEL: Record<JobSourceTermsStatus, string> = {
  unchecked: 'Not checked',
  allowed: 'Allowed',
  allowed_with_conditions: 'Allowed with conditions',
  needs_contract: 'Needs a contract',
  forbidden: 'Forbidden',
};

/** A source's robots.txt verdict for the paths it reads (refreshed when its host's file changes). */
export const JOB_SOURCE_ROBOTS_STATUSES = ['unchecked', 'allowed', 'disallowed', 'not_applicable', 'error'] as const;
export type JobSourceRobotsStatus = (typeof JOB_SOURCE_ROBOTS_STATUSES)[number];
export const JOB_SOURCE_ROBOTS_LABEL: Record<JobSourceRobotsStatus, string> = {
  unchecked: 'Not checked',
  allowed: 'Allowed',
  disallowed: 'Disallowed',
  not_applicable: 'Not needed (keyed API)',
  error: 'Could not be read',
};

/** The terms and robots statuses a source must have to be scheduled (the due index's condition). */
export const JOB_SOURCE_RUNNABLE_TERMS = ['allowed', 'allowed_with_conditions'] as const satisfies readonly JobSourceTermsStatus[];
export const JOB_SOURCE_RUNNABLE_ROBOTS = ['allowed', 'not_applicable'] as const satisfies readonly JobSourceRobotsStatus[];

/** How a board or site was found (12 §4.1); a candidate never names a person. */
export const JOB_SOURCE_DISCOVERED_VIA = [
  'extension',
  'application_link',
  'common_crawl',
  'company_site',
  'cross_link',
  'probe',
  'vendor',
  'admin',
] as const;
export type JobSourceDiscoveredVia = (typeof JOB_SOURCE_DISCOVERED_VIA)[number];
export const JOB_SOURCE_DISCOVERED_VIA_LABEL: Record<JobSourceDiscoveredVia, string> = {
  extension: 'Added from the extension',
  application_link: 'A link in applications',
  common_crawl: 'Common Crawl',
  company_site: "A company's website",
  cross_link: 'A link in another posting',
  probe: 'A name probe',
  vendor: 'A licensed feed',
  admin: 'An admin',
};

/** What started a run (job_source_runs, today's ingest_runs renamed; `liveness` is a per-posting read). */
export const JOB_SOURCE_RUN_TRIGGERS = ['schedule', 'manual', 'upload', 'startup', 'liveness'] as const;
export type JobSourceRunTrigger = (typeof JOB_SOURCE_RUN_TRIGGERS)[number];
/**
 * How a run ended; `not_modified` is a 304: the listing is complete and unchanged. v31 RUNS: `paused`, an admin paused it
 * (or every run) and it stopped at its next safe point: what it saved stays, it closed nothing, and Continue reads the
 * source again from the top.
 */
export const JOB_SOURCE_RUN_STATUSES = ['running', 'succeeded', 'failed', 'partial', 'not_modified', 'paused'] as const;
export type JobSourceRunStatus = (typeof JOB_SOURCE_RUN_STATUSES)[number];

/** A found board's state (12 §4.2): validated once, then a source, or tried again, or never run. */
export const JOB_SOURCE_CANDIDATE_STATUSES = ['new', 'valid', 'empty', 'not_found', 'forbidden', 'error', 'dropped'] as const;
export type JobSourceCandidateStatus = (typeof JOB_SOURCE_CANDIDATE_STATUSES)[number];
export const JOB_SOURCE_CANDIDATE_STATUS_LABEL: Record<JobSourceCandidateStatus, string> = {
  new: 'Waiting',
  valid: 'Became a source',
  empty: 'Became a source (no open jobs)',
  not_found: 'Not found',
  forbidden: 'Not allowed',
  error: 'Failed, trying again',
  dropped: 'Dropped',
};

/** Why a purge by source runs (11 §8.5), and its progress. */
export const JOB_SOURCE_PURGE_REASONS = ['contract_end', 'opt_out', 'terms_changed', 'admin'] as const;
export type JobSourcePurgeReason = (typeof JOB_SOURCE_PURGE_REASONS)[number];
export const JOB_SOURCE_PURGE_REASON_LABEL: Record<JobSourcePurgeReason, string> = {
  contract_end: 'A contract ended',
  opt_out: 'The employer opted out',
  terms_changed: 'The terms changed',
  admin: "An admin's call",
};
export const JOB_SOURCE_PURGE_STATES = ['queued', 'running', 'done', 'failed'] as const;
export type JobSourcePurgeState = (typeof JOB_SOURCE_PURGE_STATES)[number];

/** A host's robots.txt as read (RFC 9309): `no_rules` for a 4xx other than 429; `unreachable` (not now) otherwise. */
export const SITE_ROBOTS_STATUSES = ['ok', 'no_rules', 'unreachable'] as const;
export type SiteRobotsStatus = (typeof SITE_ROBOTS_STATUSES)[number];

/** Why a host is held (crawl_hosts.hold_reason). */
export const CRAWL_HOST_HOLD_REASONS = ['retry_after', 'breaker', 'bot_check', 'admin'] as const;
export type CrawlHostHoldReason = (typeof CRAWL_HOST_HOLD_REASONS)[number];
export const CRAWL_HOST_HOLD_LABEL: Record<CrawlHostHoldReason, string> = {
  retry_after: 'The host asked to wait',
  breaker: 'Failing: held by the circuit breaker',
  bot_check: 'A bot check or a 403',
  admin: 'Held by an admin',
};

/** The shared identity keys a job is known by (job_keys, 12 §7.1). */
export const JOB_KEY_KINDS = ['ats', 'link', 'ld', 'ghjid'] as const;
export type JobKeyKind = (typeof JOB_KEY_KINDS)[number];

// v30 FIX-WEB (REV-UX UX-11): a failed run's error code (job_source_runs.error_code, ingest/service.ts errorCodeOf) in
// words for Admin › Runs: the code stays a word an admin can filter on, the page says what it means.
/** The error codes a failed run writes, but `http_<status>` (any HTTP status). */
export const JOB_SOURCE_RUN_ERROR_CODES = [
  'held',
  'identity',
  'refused',
  'robots_disallowed',
  'robots_unreadable',
  'not_found',
  'unreachable',
  'invalid',
  'interrupted',
  'error',
] as const;
export type JobSourceRunErrorCode = (typeof JOB_SOURCE_RUN_ERROR_CODES)[number];
export const JOB_SOURCE_RUN_ERROR_LABEL: Record<JobSourceRunErrorCode, string> = {
  held: 'Its host is held',
  identity: "Waiting for TailorIT's bot identity",
  refused: 'A host TailorIT never reads',
  robots_disallowed: 'robots.txt disallows it',
  robots_unreadable: 'robots.txt could not be read',
  not_found: 'Board not found',
  unreachable: 'The host did not answer',
  invalid: 'The answer could not be read',
  interrupted: 'Stopped before it finished',
  error: 'Something went wrong',
};

/** A run's error code in words: "HTTP 429" for `http_429`, the label of a known code, else the code itself. */
export function runErrorLabel(code: string): string {
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `HTTP ${http[1]}`;
  return (JOB_SOURCE_RUN_ERROR_LABEL as Record<string, string>)[code] ?? code;
}
