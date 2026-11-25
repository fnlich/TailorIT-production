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

// v35 ADMIN (PLAN H6): a source may also be found by an admin's import (job_sources.discovered_via `import`, migration
// 0058): the board of a link an import read, made a source switched off ("Found by import"). A candidate never is one
// (job_source_candidates keeps JOB_SOURCE_DISCOVERED_VIA).
/** How a source was found: discovery's ways, or an admin's import. */
export const JOB_SOURCE_FOUND_VIA = [...JOB_SOURCE_DISCOVERED_VIA, 'import'] as const;
export type JobSourceFoundVia = (typeof JOB_SOURCE_FOUND_VIA)[number];

/** How a board or source was found, in words (v35 ADMIN: a source's `import` too, JOB_SOURCE_FOUND_VIA). */
export const JOB_SOURCE_DISCOVERED_VIA_LABEL: Record<JobSourceFoundVia, string> = {
  extension: 'Added from the extension',
  application_link: 'A link in applications',
  common_crawl: 'Common Crawl',
  company_site: "A company's website",
  cross_link: 'A link in another posting',
  probe: 'A name probe',
  vendor: 'A licensed feed',
  admin: 'An admin',
  import: 'Found by import', // v35 ADMIN
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
  'workday_paused', // v37 FIX-LANE
] as const;
export type JobSourceRunErrorCode = (typeof JOB_SOURCE_RUN_ERROR_CODES)[number];
/**
 * v37 FIX-LANE (SP v37 FIXES-361 F7): the code of a run that met Workday's pause (or an admin's hold of all of Workday)
 * before it read its postings: it ends Partial with this code, never Failed, and runs again after the pause. Another
 * platform's lane writes `<platform>_paused` (the API's hosts.ts laneWaitingCodeOf), said RUN_WAITING_FOR_LANE_LABEL
 * until it has words of its own here.
 */
export const RUN_WAITING_FOR_WORKDAY = 'workday_paused' satisfies JobSourceRunErrorCode;
/** v37 FIX-LANE: a lane's waiting run whose code has no words of its own (any `<platform>_paused`). */
export const RUN_WAITING_FOR_LANE_LABEL = "Waiting for its platform's pause";
export const JOB_SOURCE_RUN_ERROR_LABEL: Record<JobSourceRunErrorCode, string> = {
  workday_paused: 'Waiting for Workday',
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

/**
 * A run's error code in words: "HTTP 429" for `http_429`, the label of a known code, a lane's waiting run's words (v37
 * FIX-LANE), else the code itself.
 */
export function runErrorLabel(code: string): string {
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `HTTP ${http[1]}`;
  const known = (JOB_SOURCE_RUN_ERROR_LABEL as Record<string, string>)[code];
  if (known) return known;
  return /^[a-z0-9]+(?:_[a-z0-9]+)*_paused$/.test(code) ? RUN_WAITING_FOR_LANE_LABEL : code; // v37 FIX-LANE
}

// v35 ADMIN (PLAN H7): why a switched-on source does not run now. Each one clears by itself (the worker looks at every
// tick: a robots.txt verdict is read again each day, a held host's sources wait for its hold's end) or by an admin's
// own change (the terms, a pause, a switch); the source then runs at once, on its schedule, with no Run now.
/** Why a switched-on source is waiting, most fundamental first (Admin › Sources' row and sheet). */
export const JOB_SOURCE_WAITING_REASONS = [
  'ingest_off',
  'runs_paused',
  'paused',
  'opted_out',
  'not_built',
  'identity',
  'outside_key',
  'career_pages_off',
  'terms',
  'robots_pending',
  'robots_disallowed',
  'robots_unreadable',
  'host_held',
] as const;
export type JobSourceWaitingReason = (typeof JOB_SOURCE_WAITING_REASONS)[number];
export const JOB_SOURCE_WAITING_LABEL: Record<JobSourceWaitingReason, string> = {
  ingest_off: 'Waiting: INGEST_ENABLED is off on this server',
  runs_paused: 'Waiting: every run is paused',
  paused: 'Waiting: paused by an admin',
  opted_out: 'Waiting: its company asked TailorIT not to read its jobs',
  not_built: 'Waiting: TailorIT does not read this kind of source yet',
  identity: 'Waiting: set BOT_USER_AGENT',
  outside_key: "Waiting: set this feed's API key",
  career_pages_off: 'Waiting: turn on Read career pages',
  terms: 'Waiting: its terms are not recorded as allowing automated access',
  robots_pending: "Waiting: reading its host's robots.txt",
  robots_disallowed: 'Waiting: robots.txt disallows this site',
  robots_unreadable: "Waiting: its host's robots.txt could not be read (tried again daily)",
  host_held: 'Waiting: its host is held',
};
// end v35 ADMIN
