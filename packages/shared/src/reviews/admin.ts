import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { IsoDateTime } from '../core/list';
import { JOB_REPORT_REASONS } from '../jobs/taxonomy';
import { JOB_SOURCE_KINDS } from '../sourcing/kinds';
import {
  ADMIN_PAGE_MAX, // v37 REVIEW
  adminBulkIds,
  adminBulkResultSchema,
  AdminCursorSchema,
} from './bulk';
import {
  JOB_REVIEW_CHECK_STATES,
  JOB_REVIEW_DECIDERS,
  JOB_REVIEW_DETAILS_MAX,
  JOB_REVIEW_KINDS,
  JOB_REVIEW_NOTE_MAX,
  JOB_REVIEW_ORIGINS,
  JOB_REVIEW_SIGNALS,
  JOB_REVIEW_STATES,
  JOB_REVIEW_STRENGTHS,
  JOB_REVIEW_VIA,
  NEW_JOB_FROM_FILTERS,
  REVIEW_GROUPS,
  REVIEW_PAGE_SIZE, // v37 REVIEW
  REVIEW_STATE_DEFAULT, // v37 REVIEW
  REVIEW_STATE_FILTERS,
} from './enums';

// v30 CT: Admin › Review's lists, rows, detail sheet, decisions and bulk actions (docs/design/part2/14-extension-reports.md
// §6; SP\p2\PLAN.md X1-API and X1-WEB). The Closed links and New jobs lanes list job_reviews; the Flags lane lists the
// Jobs page's other flags (job_reports, today's Admin › Reports). The auto-approve switches are constants
// (EXT_AUTO_APPROVE_*), written through the Admin › Constants API. X1-API names the routes.

const Id = z.number().int().positive();
const NoteSchema = z.string().trim().max(JOB_REVIEW_NOTE_MAX, messageError('MSG_TEXT_TOO_LONG', { max: JOB_REVIEW_NOTE_MAX }));

/** A review's job, as a row shows it (the title links to the job). */
export const ReviewJobRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  companyId: z.number().int(),
  companyName: z.string(),
  active: z.boolean(),
  /** Held for review (a new job not approved yet). */
  held: z.boolean(),
  applyUrl: z.string(),
});
export type ReviewJobRef = z.infer<typeof ReviewJobRefSchema>;

// The lists ----------------------------------------------------------------------------------------------------------

/**
 * A lane's filters: the lane, the state filter, a search (title or company). v35 ADMIN (PLAN H3): on the New jobs lane,
 * where its jobs came from (`from`: all, an admin's imports, people's link reads) and one import (`importRunId`, the
 * import's run; it implies `imports`). The Closed links lane reads neither.
 */
export const AdminReviewsFilterSchema = z.object({
  lane: z.enum(JOB_REVIEW_KINDS),
  // v37 REVIEW (R2): Waiting by default (every pending review, what the lane's count counts).
  state: z.enum(REVIEW_STATE_FILTERS).default(REVIEW_STATE_DEFAULT),
  q: z.string().trim().max(200, messageError('MSG_TEXT_TOO_LONG', { max: 200 })).optional(),
  /** Absent: all. */
  from: z.enum(NEW_JOB_FROM_FILTERS).optional(),
  importRunId: z.coerce.number().int().positive().optional(),
});
export type AdminReviewsFilter = z.infer<typeof AdminReviewsFilterSchema>;

/**
 * v37 REVIEW (R1): a Review lane's page size from a query string: 1 to ADMIN_PAGE_MAX, REVIEW_PAGE_SIZE (100) when
 * absent (the lists load the next page as you scroll).
 */
export const ReviewPageSizeSchema = z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(REVIEW_PAGE_SIZE);

/** The Closed links and New jobs lanes' query string: the lane's filters (AdminReviewsFilterSchema) and a page. */
export const AdminReviewsQuerySchema = AdminReviewsFilterSchema.extend({
  cursor: AdminCursorSchema.optional(),
  limit: ReviewPageSizeSchema, // v37 REVIEW (R1): 100 a page
});
export type AdminReviewsQuery = z.infer<typeof AdminReviewsQuerySchema>;

/** The items needing a decision in each lane: the header's count and the lane tabs' (n). */
export const AdminReviewCountsSchema = z.object({
  closed: z.number().int().nonnegative(),
  newJob: z.number().int().nonnegative(),
  flags: z.number().int().nonnegative(),
});
export type AdminReviewCounts = z.infer<typeof AdminReviewCountsSchema>;

/** One row of the Closed links or New jobs lane (job_reviews). */
export const AdminReviewRowSchema = z.object({
  id: z.number().int(),
  kind: z.enum(JOB_REVIEW_KINDS),
  /** A new job's origin; null for a closed link. */
  origin: z.enum(JOB_REVIEW_ORIGINS).nullable(),
  /** A new job read from an ATS: its platform ("Read from Greenhouse"); null otherwise. */
  platform: z.string().max(40).nullable(),
  /** A new job from a page: the page's host ("From a page on careers.example.com"); null otherwise. */
  pageHost: z.string().max(253).nullable(),
  job: ReviewJobRefSchema,
  state: z.enum(JOB_REVIEW_STATES),
  group: z.enum(REVIEW_GROUPS),
  /** Distinct accounts that reported or added it ("3 people"), and those that count toward automatic decisions. */
  reporters: z.number().int().nonnegative(),
  trustedReporters: z.number().int().nonnegative(),
  strongest: z.enum(JOB_REVIEW_STRENGTHS).nullable(),
  /** The strongest report's signal, for its words (a closed link). */
  strongestSignal: z.enum(JOB_REVIEW_SIGNALS).nullable(),
  checkState: z.enum(JOB_REVIEW_CHECK_STATES),
  checkedAt: IsoDateTime.nullable(),
  firstReportedAt: IsoDateTime,
  lastReportedAt: IsoDateTime,
  decidedBy: z.enum(JOB_REVIEW_DECIDERS).nullable(),
  decidedAt: IsoDateTime.nullable(),
  note: z.string().nullable(),
  /**
   * v30 INT-3 (decision 3): when a source listed the job again after this closed review was approved (14 §5.1 step 6,
   * the reporters' trust rule: "Reopened by its source"). Absent or null: never.
   */
  reopenedAt: IsoDateTime.nullable().optional(),
  // v35 ADMIN (PLAN H3)
  /** A new job an admin's import read (held for review); absent or false otherwise. */
  imported: z.boolean().optional(),
  /** That import's run (Admin › Runs), and its name ("jobs.csv", a sheet's, "24 pasted links"); null once it is gone. */
  importRunId: z.number().int().nullable().optional(),
  importName: z.string().nullable().optional(),
  // end v35 ADMIN
});
export type AdminReviewRow = z.infer<typeof AdminReviewRowSchema>;

/**
 * v37 REVIEW (R2, R3): what a lane's header and "Select all" count. `total` is every row the query matches (the list
 * holds that many, page after page); `decidable` those a decision can take (pending reviews, open flags: "Select all
 * 340"); `unfiltered` the rows of the view without the search or the From filter, Waiting for Needs review and Checking
 * (the "of 340" of "12 of 340").
 */
const LaneTotalsShape = {
  total: z.number().int().nonnegative(),
  decidable: z.number().int().nonnegative(),
  unfiltered: z.number().int().nonnegative(),
};

/** A lane's page: its rows, every lane's count, the matches counted, and the next page's cursor. */
export const AdminReviewListSchema = z.object({
  items: z.array(AdminReviewRowSchema),
  counts: AdminReviewCountsSchema,
  ...LaneTotalsShape, // v37 REVIEW
  nextCursor: AdminCursorSchema.optional(),
});
export type AdminReviewList = z.infer<typeof AdminReviewListSchema>;

// The detail sheet ---------------------------------------------------------------------------------------------------

/** One report on the review (job_review_reports), without its account (the reporters are a separate, admin-only read). */
export const AdminReviewReportSchema = z.object({
  via: z.enum(JOB_REVIEW_VIA),
  signal: z.enum(JOB_REVIEW_SIGNALS).nullable(),
  marker: z.string().max(60).nullable(),
  strength: z.enum(JOB_REVIEW_STRENGTHS).nullable(),
  /** It counts toward automatic decisions (the trust rule). */
  trusted: z.boolean(),
  /** The web flag's own words (plain text). */
  details: z.string().max(JOB_REVIEW_DETAILS_MAX).nullable(),
  /** A new job from a page: this account's page job. */
  pageJobId: z.number().int().nullable(),
  seenAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AdminReviewReport = z.infer<typeof AdminReviewReportSchema>;

/** One of the job's links and its state: live, or missing since a listing (or an approved report) closed it. */
export const AdminReviewLinkSchema = z.object({
  sourceId: z.number().int(),
  sourceKind: z.enum(JOB_SOURCE_KINDS),
  sourceName: z.string(),
  sourceJobId: z.string(),
  state: z.enum(['live', 'missing']),
  missCount: z.number().int().nonnegative(),
  missingSince: IsoDateTime.nullable(),
  /** When it was last verified: its own read, or its source's last complete listing. */
  lastVerifiedAt: IsoDateTime.nullable(),
  /** The link the reports name (a closed review's link_source_id and link_source_job_id). */
  reported: z.boolean(),
});
export type AdminReviewLink = z.infer<typeof AdminReviewLinkSchema>;

/** A new job's posting, as the Jobs page's detail draws it (the HTML is sanitised; page text is shown as text). */
export const AdminReviewPostingSchema = z.object({
  title: z.string(),
  companyName: z.string(),
  locations: z.array(z.string()),
  descriptionHtml: z.string(),
  applyUrl: z.string(),
});

/** A likely duplicate: an open public job of the same company and title with a near text fingerprint. */
export const AdminReviewDuplicateSchema = z.object({
  jobId: z.number().int(),
  title: z.string(),
  companyName: z.string(),
  postedAt: IsoDateTime.nullable(),
  /** The fingerprints' distance in bits (null when either has none). */
  distanceBits: z.number().int().min(0).max(64).nullable(),
});

/** How a new job's company resolved (13 §5.3): by a board alias, a domain, its name alone, or as a new company. */
export const REVIEW_COMPANY_MATCHES = ['board', 'domain', 'name', 'new'] as const;
export const AdminReviewCompanyMatchSchema = z.object({
  companyId: z.number().int().nullable(),
  name: z.string(),
  resolvedBy: z.enum(REVIEW_COMPANY_MATCHES),
  /** The company opted out: never approved automatically, its board never a candidate. */
  doNotFetch: z.boolean(),
});

/** What approving offers to discovery: a board, or a page's host as a career site (12 §4.1). */
export const AdminReviewOfferSchema = z.object({ kind: z.enum(JOB_SOURCE_KINDS), name: z.string() });

/**
 * v30 INT-3 (decision 3): one of TailorIT's re-checks of the job (job_review_checks, 14 §5.1 step 3): what its read
 * said, when, and whether an enabled source that lists the job was made due instead of a read of the posting.
 */
export const AdminReviewCheckSchema = z.object({
  state: z.enum(JOB_REVIEW_CHECK_STATES),
  checkedAt: IsoDateTime,
  sourceMadeDue: z.boolean(),
});
export type AdminReviewCheck = z.infer<typeof AdminReviewCheckSchema>;

/** The checks the detail sheet lists, newest first. */
export const ADMIN_REVIEW_CHECKS_MAX = 20;

/** The detail sheet: the row, each report, the job's links, and for a new job its posting, duplicates and company. */
export const AdminReviewDetailSchema = AdminReviewRowSchema.extend({
  reports: z.array(AdminReviewReportSchema),
  links: z.array(AdminReviewLinkSchema),
  posting: AdminReviewPostingSchema.nullable(),
  duplicates: z.array(AdminReviewDuplicateSchema).max(20),
  company: AdminReviewCompanyMatchSchema.nullable(),
  /** "Approving offers this board to discovery"; null when it would offer none. */
  offersToDiscovery: AdminReviewOfferSchema.nullable(),
  /** v30 INT-3 (decision 3): the job's re-checks, newest first (at most ADMIN_REVIEW_CHECKS_MAX). Absent: not read. */
  checks: z.array(AdminReviewCheckSchema).max(ADMIN_REVIEW_CHECKS_MAX).optional(),
});
export type AdminReviewDetail = z.infer<typeof AdminReviewDetailSchema>;

/** The reporting accounts, on expand: admins only (owner question 28), gone with the review after its keep days. */
export const AdminReviewReportersSchema = z.object({
  items: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      name: z.string(),
      via: z.enum(JOB_REVIEW_VIA),
      trusted: z.boolean(),
      reportedAt: IsoDateTime,
    }),
  ),
});
export type AdminReviewReporters = z.infer<typeof AdminReviewReportersSchema>;

// Decisions ----------------------------------------------------------------------------------------------------------

/**
 * An admin's decision on one review: approve (a closed link closes as its own read's 404 would; a new job is
 * published and offered to discovery), reject, or reopen a decided one from the history. An optional note.
 */
export const REVIEW_DECISIONS = ['approve', 'reject', 'reopen'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export const AdminReviewDecisionBodySchema = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  note: NoteSchema.optional(),
  /**
   * v32 ADMINAPP (E6): approving a page review of v3.0 whose page TailorIT cannot read publishes the posting as the
   * reporters' browsers captured it (the text most of them share), marked approved by the admin. Without it, such an
   * approval is refused (409), as in v3.1.
   */
  captured: z.boolean().optional(),
});
export type AdminReviewDecisionBody = z.infer<typeof AdminReviewDecisionBodySchema>;

/** Approve or reject chosen reviews, one request per ADMIN_BULK_MAX; each row says what happened. */
export const AdminReviewBulkBodySchema = z.object({
  ids: adminBulkIds(Id),
  decision: z.enum(['approve', 'reject']),
  note: NoteSchema.optional(),
});
export type AdminReviewBulkBody = z.infer<typeof AdminReviewBulkBodySchema>;
/** A row's outcome: approved, rejected, skipped (decided already, or superseded) or failed. */
export const REVIEW_BULK_OUTCOMES = ['approved', 'rejected', 'skipped', 'failed'] as const;
export const AdminReviewBulkResultSchema = adminBulkResultSchema(REVIEW_BULK_OUTCOMES);
export type AdminReviewBulkResult = z.infer<typeof AdminReviewBulkResultSchema>;

// v35 ADMIN (PLAN H3): Approve all / Reject all on the New jobs lane, for every pending review its filter matches. The
// count comes first (GET /api/admin/reviews/all/count?<filter>: the confirm's "Approve 1,240 jobs?"); the decisions run
// on the server in batches of ADMIN_BULK_MAX, each review in its own transaction as a bulk's are, oldest first, for at
// most ADMIN_BULK_ALL_SECONDS a request. An answer with `done: false` was cut at that time: the same request with
// `after` = its `after` goes on past the reviews it decided or skipped (one that failed is never tried twice), and the
// web sums the answers into one result line.
/**
 * Reviews the "all" decisions apply to: the New jobs lane's. v37 REVIEW (R3): and the Closed links lane's ("Select all
 * N", then Approve or Reject).
 */
export const ADMIN_REVIEW_ALL_LANES = ['closed', 'new_job'] as const;
export const AdminReviewsAllFilterSchema = AdminReviewsFilterSchema.extend({ lane: z.enum(ADMIN_REVIEW_ALL_LANES) });
export type AdminReviewsAllFilter = z.infer<typeof AdminReviewsAllFilterSchema>;
/** The pending reviews the filter matches now: what Approve all or Reject all would decide. */
export const AdminReviewsAllCountSchema = z.object({
  pending: z.number().int().nonnegative(),
  /** v35 FIX-STORE (S6): what was counted, opaque; Approve all / Reject all send it back and decide nothing beyond it. */
  upTo: z.string().max(40),
});
export type AdminReviewsAllCount = z.infer<typeof AdminReviewsAllCountSchema>;
export const AdminReviewsAllBodySchema = z.object({
  decision: z.enum(['approve', 'reject']),
  filter: AdminReviewsAllFilterSchema,
  note: NoteSchema.optional(),
  /** Go on after this review (the last answer's `after`). */
  after: z.number().int().nonnegative().optional(),
  /** v35 FIX-STORE (S6): the count's `upTo` (absent: every pending review the filter matches, as before). */
  upTo: z.string().max(40).optional(),
});
export type AdminReviewsAllBody = z.infer<typeof AdminReviewsAllBodySchema>;
/** One result: the pending reviews it took, each outcome's count, a few failures' words, and whether it is done. */
export const AdminReviewsAllResultSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  matched: z.number().int().nonnegative(),
  counts: z.partialRecord(z.enum(REVIEW_BULK_OUTCOMES), z.number().int().nonnegative()),
  /** The first failures (at most 20), each with its review and words. */
  failures: z.array(z.object({ id: z.number().int(), message: z.string().max(400) })).max(20),
  done: z.boolean(),
  /** The last review this answer took (its id): the next request's `after` while `done` is false. */
  after: z.number().int().nonnegative(),
});
export type AdminReviewsAllResult = z.infer<typeof AdminReviewsAllResultSchema>;
// end v35 ADMIN

// The Flags lane -----------------------------------------------------------------------------------------------------

/** A flag's status (job_reports), as today's Admin › Reports keeps it. */
export const FLAG_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

/**
 * The Flags lane's state filters: open (needs review), decided (resolved or dismissed), or all. v37 REVIEW (R2):
 * `waiting`, the default, is the open flags too (the other lanes' word for what waits).
 */
export const FLAG_STATE_FILTERS = ['waiting', 'needs_review', 'decided', 'all'] as const;
/** v37 REVIEW: the Flags lane's filters (its state and search), as its list, its count and "all" read them. */
export const AdminFlagsFilterSchema = z.object({
  state: z.enum(FLAG_STATE_FILTERS).default('waiting'),
  q: z.string().trim().max(200, messageError('MSG_TEXT_TOO_LONG', { max: 200 })).optional(),
});
export type AdminFlagsFilter = z.infer<typeof AdminFlagsFilterSchema>;
/** The Flags lane's query string: its filters and a page (v37 REVIEW: 100 a page). */
export const AdminFlagsQuerySchema = AdminFlagsFilterSchema.extend({
  cursor: AdminCursorSchema.optional(),
  limit: ReviewPageSizeSchema,
});
export type AdminFlagsQuery = z.infer<typeof AdminFlagsQuerySchema>;

/** One flag (job_reports): today's Admin › Reports row, with the job's company (company_info_wrong names it). */
export const AdminFlagSchema = z.object({
  id: z.number().int(),
  status: z.enum(FLAG_STATUSES),
  reason: z.enum(JOB_REPORT_REASONS),
  reasonLabel: z.string(),
  details: z.string(),
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
  resolvedBy: z.string().nullable(),
  reporter: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  job: ReviewJobRefSchema,
  /**
   * v37 FIX-REV (SP v37 FIXES-361.md D1): TailorIT resolved the flag because its job closed (by any path); `resolvedBy`
   * is null then. Absent otherwise.
   */
  jobClosed: z.literal(true).optional(),
});
export type AdminFlag = z.infer<typeof AdminFlagSchema>;

export const AdminFlagListSchema = z.object({
  items: z.array(AdminFlagSchema),
  counts: AdminReviewCountsSchema,
  ...LaneTotalsShape, // v37 REVIEW
  nextCursor: AdminCursorSchema.optional(),
});
export type AdminFlagList = z.infer<typeof AdminFlagListSchema>;

/** Decide a flag: reopen, resolve or dismiss it; `closeJob` closes its job through the one close function. */
export const AdminFlagDecisionBodySchema = z.object({ status: z.enum(FLAG_STATUSES), closeJob: z.boolean().optional() });
export type AdminFlagDecisionBody = z.infer<typeof AdminFlagDecisionBodySchema>;
export const AdminFlagBulkBodySchema = z.object({ ids: adminBulkIds(Id), status: z.enum(['resolved', 'dismissed']) });
export type AdminFlagBulkBody = z.infer<typeof AdminFlagBulkBodySchema>;
export const FLAG_BULK_OUTCOMES = ['resolved', 'dismissed', 'skipped', 'failed'] as const;
export const AdminFlagBulkResultSchema = adminBulkResultSchema(FLAG_BULK_OUTCOMES);

// v37 REVIEW (SP v37 PLAN.md R3): Resolve all / Dismiss all on the Flags lane, as the reviews' "all" (above): the count
// first (GET /api/admin/flags/all/count?<filter>, with `upTo`), then the decisions on the server in batches of
// ADMIN_BULK_MAX, oldest first, for at most ADMIN_BULK_ALL_SECONDS a request (`done: false`: the same request with
// `after` goes on), nothing past the count's `upTo`.
/** The open flags the filter matches now, and what was counted (opaque). */
export const AdminFlagsAllCountSchema = z.object({ pending: z.number().int().nonnegative(), upTo: z.string().max(40) });
export type AdminFlagsAllCount = z.infer<typeof AdminFlagsAllCountSchema>;
export const AdminFlagsAllBodySchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
  filter: AdminFlagsFilterSchema,
  after: z.number().int().nonnegative().optional(),
  upTo: z.string().max(40).optional(),
});
export type AdminFlagsAllBody = z.infer<typeof AdminFlagsAllBodySchema>;
export const AdminFlagsAllResultSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
  matched: z.number().int().nonnegative(),
  counts: z.partialRecord(z.enum(FLAG_BULK_OUTCOMES), z.number().int().nonnegative()),
  failures: z.array(z.object({ id: z.number().int(), message: z.string().max(400) })).max(20),
  done: z.boolean(),
  after: z.number().int().nonnegative(),
});
export type AdminFlagsAllResult = z.infer<typeof AdminFlagsAllResultSchema>;
// end v37 REVIEW
