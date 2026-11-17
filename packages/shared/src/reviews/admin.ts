import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { IsoDateTime } from '../core/list';
import { JOB_REPORT_REASONS } from '../jobs/taxonomy';
import { JOB_SOURCE_KINDS } from '../sourcing/kinds';
import {
  adminBulkIds,
  adminBulkResultSchema,
  AdminCursorSchema,
  AdminPageSizeSchema,
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
  REVIEW_GROUPS,
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

/** The Closed links and New jobs lanes' query string: the lane, the state filter, a search (title or company), a page. */
export const AdminReviewsQuerySchema = z.object({
  lane: z.enum(JOB_REVIEW_KINDS),
  state: z.enum(REVIEW_STATE_FILTERS).default('needs_review'),
  q: z.string().trim().max(200, messageError('MSG_TEXT_TOO_LONG', { max: 200 })).optional(),
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
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
});
export type AdminReviewRow = z.infer<typeof AdminReviewRowSchema>;

/** A lane's page: its rows, every lane's count, the matches counted, and the next page's cursor. */
export const AdminReviewListSchema = z.object({
  items: z.array(AdminReviewRowSchema),
  counts: AdminReviewCountsSchema,
  total: z.number().int().nonnegative(),
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
export const AdminReviewDecisionBodySchema = z.object({ decision: z.enum(REVIEW_DECISIONS), note: NoteSchema.optional() });
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

// The Flags lane -----------------------------------------------------------------------------------------------------

/** A flag's status (job_reports), as today's Admin › Reports keeps it. */
export const FLAG_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

/** The Flags lane's query string: open (needs review), decided (resolved or dismissed), or all. */
export const AdminFlagsQuerySchema = z.object({
  state: z.enum(['needs_review', 'decided', 'all']).default('needs_review'),
  q: z.string().trim().max(200, messageError('MSG_TEXT_TOO_LONG', { max: 200 })).optional(),
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
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
});
export type AdminFlag = z.infer<typeof AdminFlagSchema>;

export const AdminFlagListSchema = z.object({
  items: z.array(AdminFlagSchema),
  counts: AdminReviewCountsSchema,
  total: z.number().int().nonnegative(),
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
