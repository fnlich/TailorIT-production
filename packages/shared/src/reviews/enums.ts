import { AUTOFILL_CLOSED_SIGNALS, AUTOFILL_CLOSED_STRENGTHS, type AutofillClosedSignal } from '../autofill/closed';

// v30 CT: Admin › Review's vocabulary (docs/design/part2/14-extension-reports.md §5, §6, §9): the closed lists of
// job_reviews and job_review_reports, as 0908 checks them, and the queue's lanes, state filters, groups and words.

/** A review is about a closed link, or a new job from the extension. */
export const JOB_REVIEW_KINDS = ['closed', 'new_job'] as const;
export type JobReviewKind = (typeof JOB_REVIEW_KINDS)[number];

/** A new job's origin: a posting read from an ATS (Add job), or a job made from a page's text (From page). */
export const JOB_REVIEW_ORIGINS = ['ats', 'page'] as const;
export type JobReviewOrigin = (typeof JOB_REVIEW_ORIGINS)[number];

/** A review's state: one pending review per subject; a second report bumps it. */
export const JOB_REVIEW_STATES = ['pending', 'approved', 'rejected', 'superseded', 'expired'] as const;
export type JobReviewState = (typeof JOB_REVIEW_STATES)[number];

/** A report's strength, from the autofill contract's closed list (never the reporter's word). */
export const JOB_REVIEW_STRENGTHS = AUTOFILL_CLOSED_STRENGTHS;
export type JobReviewStrength = (typeof JOB_REVIEW_STRENGTHS)[number];

/** The server's own check of a reported posting: queued, then gone, live or unreadable; not possible on some hosts. */
export const JOB_REVIEW_CHECK_STATES = ['none', 'queued', 'gone', 'live', 'unreadable', 'not_possible'] as const;
export type JobReviewCheckState = (typeof JOB_REVIEW_CHECK_STATES)[number];

/** Who decided: an admin, the automatic rules, TailorIT's check, or the job's source (a listing). */
export const JOB_REVIEW_DECIDERS = ['admin', 'auto', 'server_check', 'source'] as const;
export type JobReviewDecider = (typeof JOB_REVIEW_DECIDERS)[number];

/**
 * How a report came: the extension's four ways (AUTOFILL_CLOSED_VIA), the Jobs page's flag (`web`), and an add from the
 * extension (`add`: a new job's report row).
 */
export const JOB_REVIEW_VIA = ['page', 'agent', 'queue', 'person', 'web', 'add'] as const;
export type JobReviewVia = (typeof JOB_REVIEW_VIA)[number];

/** A closed report's signal: the autofill contract's closed list (the web's flag files `person`). */
export const JOB_REVIEW_SIGNALS = AUTOFILL_CLOSED_SIGNALS;
export type JobReviewSignal = AutofillClosedSignal;

/** job_reviews' and job_review_reports' text caps (0908's checks): an admin's note, a web flag's own words. */
export const JOB_REVIEW_NOTE_MAX = 500;
export const JOB_REVIEW_DETAILS_MAX = 1000;
/** A review's subject key's cap: 'job:<id>', or 'page:<linkKey of the posting address>'. */
export const JOB_REVIEW_SUBJECT_MAX = 2100;

/** The subject of a closed review, or of a new job read from an ATS: its job. */
export function jobReviewSubject(jobId: number): string {
  return `job:${jobId}`;
}
/** The subject of a new job from pages: the posting's stored address, as the lookup keys it (linkKey). */
export function pageReviewSubject(linkKey: string): string {
  return `page:${linkKey}`;
}

// The queue ------------------------------------------------------------------------------------------------------------

/** Admin › Review's lanes: Closed links, New jobs, and Flags (the Jobs page's other flags, today's Reports). */
export const REVIEW_LANES = ['closed', 'new_job', 'flags'] as const;
export type ReviewLane = (typeof REVIEW_LANES)[number];
export const REVIEW_LANE_LABEL: Record<ReviewLane, string> = { closed: 'Closed links', new_job: 'New jobs', flags: 'Flags' };

/**
 * The state filter: `needs_review` (pending, not being checked), `checking` (pending, TailorIT's check queued),
 * `decided` (any other state), `all`. On the Flags lane: open, decided (resolved or dismissed), all.
 */
export const REVIEW_STATE_FILTERS = ['needs_review', 'checking', 'decided', 'all'] as const;
export type ReviewStateFilter = (typeof REVIEW_STATE_FILTERS)[number];
export const REVIEW_STATE_FILTER_LABEL: Record<ReviewStateFilter, string> = {
  needs_review: 'Needs review',
  checking: 'Checking',
  decided: 'Decided',
  all: 'All',
};

/** The groups rows show in, like the Queue pane's (14 §6.2). */
export const REVIEW_GROUPS = ['needs_review', 'checking', 'server_live', 'decided_today', 'decided'] as const;
export type ReviewGroup = (typeof REVIEW_GROUPS)[number];
export const REVIEW_GROUP_LABEL: Record<ReviewGroup, string> = {
  needs_review: 'Needs review',
  checking: 'Checking',
  server_live: 'Server says live',
  decided_today: 'Decided today',
  decided: 'Decided',
};

/**
 * A row's group: a pending review TailorIT is checking is `checking`, one its check found live is `server_live`, any
 * other pending one `needs_review`; a decided one `decided_today` when it was decided on today's day key, else
 * `decided`.
 */
export function reviewGroupOf(
  review: { state: JobReviewState; checkState: JobReviewCheckState },
  decidedToday: boolean,
): ReviewGroup {
  if (review.state !== 'pending') return decidedToday ? 'decided_today' : 'decided';
  if (review.checkState === 'queued') return 'checking';
  return review.checkState === 'live' ? 'server_live' : 'needs_review';
}

/** The strongest signal, in words, on a row. */
export const REVIEW_SIGNAL_LABEL: Record<JobReviewSignal, string> = {
  marker: 'The page says it expired',
  valid_through_past: "The posting's end date has passed",
  no_posting: 'The page showed no posting',
  redirected: "The link led to the board's list",
  person: 'Reported by a person',
};

/** TailorIT's check, in words. */
export const REVIEW_CHECK_LABEL: Record<JobReviewCheckState, string> = {
  none: 'Not checked',
  queued: 'TailorIT is checking',
  gone: 'TailorIT checked: gone',
  live: 'TailorIT checked: still open',
  unreadable: "TailorIT can't read this site",
  not_possible: "TailorIT can't read this site",
};

/** Who decided, in words ("Approved by an admin"). */
export const REVIEW_DECIDER_LABEL: Record<JobReviewDecider, string> = {
  admin: 'by an admin',
  auto: 'automatically',
  server_check: "by TailorIT's check",
  source: 'by its source',
};

/** A review's state, in words. */
export const REVIEW_STATE_LABEL: Record<JobReviewState, string> = {
  pending: 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Listed by its source',
  expired: 'Expired',
};
