import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { IsoDate, IsoDateTime, listResponse } from '../core/list';
import { CompanyLinkSchema, CompanyParentRefSchema, CompanySourceLineSchema, JobSummarySchema } from '../jobs/dto';
import { COMPANY_SIZE_IDS, INDUSTRY_IDS } from '../jobs/taxonomy';
import {
  adminBulkIds,
  AdminCursorSchema,
  AdminPageSizeSchema,
} from '../reviews/bulk';
import { JOB_SOURCE_KINDS } from '../sourcing/kinds';
import { LINKEDIN_COMPANY_URL_PATTERN } from './aliases';
import {
  COMPANY_ALIAS_KINDS,
  COMPANY_ENRICHMENT_STEPS,
  COMPANY_FOUNDED_KINDS,
  COMPANY_FOUNDED_YEAR_MAX,
  COMPANY_FOUNDED_YEAR_MIN,
  COMPANY_LICENCES,
  COMPANY_MATCH_REVIEW_KINDS,
  COMPANY_MATCH_REVIEW_STATUSES,
  COMPANY_PROFILE_FIELDS,
  COMPANY_RELATION_KINDS,
  COMPANY_SOURCE_KINDS,
  COMPANY_SOURCE_STATUSES,
  COMPANY_STAGES,
  COMPANY_SUMMARY_MAX,
  COMPANY_SUMMARY_ORIGINS,
  COMPANY_TAGLINE_MAX,
  COMPANY_VENDOR_SOURCE_PATTERN,
} from './enums';

// v30 CT: the companies' shared contracts (docs/design/part2/13-company-enrichment.md §2, §5, §6, §10;
// 11-database.md §5.4; SP\p2\PLAN.md E0-API and E0-WEB): the profile, the company page (/companies/:id: the profile,
// its open positions and its closed history), the admin editor (fields with their sources and locks, merge, split,
// refresh, the opt-out), the opt-out list and the match review queue. E0-API names the routes.

const Id = z.number().int().positive();
const text = (max: number) => z.string().trim().max(max, messageError('MSG_TEXT_TOO_LONG', { max }));
/** A registrable domain in lower case ("acme.com"): what the opt-out list and the domain alias hold. */
export const RegistrableDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);

/** A company_sources row's kind: one of COMPANY_SOURCE_KINDS, or a licensed vendor's `vendor:<name>`. */
export const CompanySourceKindSchema = z.union([z.enum(COMPANY_SOURCE_KINDS), z.string().regex(COMPANY_VENDOR_SOURCE_PATTERN)]);

// The profile --------------------------------------------------------------------------------------------------------

/**
 * A company's profile (company_profiles; 13 §2): the values shown, each from its source (or an admin's, locked). A
 * field below COMPANY_FIELD_MIN_CONFIDENCE is stored but answered as null to people (the editor shows it).
 */
export const CompanyProfileSchema = z.object({
  displayName: z.string().max(300).nullable(),
  legalName: z.string().max(300).nullable(),
  tagline: z.string().max(COMPANY_TAGLINE_MAX).nullable(),
  summary: z.string().max(COMPANY_SUMMARY_MAX).nullable(),
  summaryOrigin: z.enum(COMPANY_SUMMARY_ORIGINS).nullable(),
  /** The company's own site (https). */
  website: z.string().max(2048).regex(/^https:\/\/\S+$/).nullable(),
  domain: z.string().max(253).nullable(),
  linkedinUrl: z.string().max(2048).regex(LINKEDIN_COMPANY_URL_PATTERN).nullable(),
  otherLinks: z.array(CompanyLinkSchema).max(20),
  /** A same-origin path to TailorIT's stored copy of the logo, never a remote address. */
  logoUrl: z.string().max(2048).regex(/^\/(?!\/)\S*$/).nullable(),
  industry: z.enum(INDUSTRY_IDS).nullable(),
  /** The source's own words for its industry ("Electronic Computers"). */
  industryDetail: z.string().max(200).nullable(),
  employees: z.number().int().nonnegative().nullable(),
  employeesAsOf: IsoDate.nullable(),
  sizeBucket: z.enum(COMPANY_SIZE_IDS).nullable(),
  stage: z.enum(COMPANY_STAGES).nullable(),
  ticker: z.string().max(20).nullable(),
  exchange: z.string().max(40).nullable(),
  hqCity: z.string().max(120).nullable(),
  hqRegion: z.string().max(120).nullable(),
  hqCountryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  foundedYear: z.number().int().min(COMPANY_FOUNDED_YEAR_MIN).max(COMPANY_FOUNDED_YEAR_MAX).nullable(),
  foundedKind: z.enum(COMPANY_FOUNDED_KINDS).nullable(),
  /** Only from a licensed source (none in v3.0: "Total Funding" stays hidden). */
  fundingTotalUsd: z.number().int().nonnegative().nullable(),
  fundingAsOf: IsoDate.nullable(),
  sponsorsH1b: z.boolean().nullable(),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

/** A profile with nothing known. */
export function emptyCompanyProfile(): CompanyProfile {
  const entries = Object.keys(CompanyProfileSchema.shape).map((key) => [key, key === 'otherLinks' ? [] : null] as const);
  return Object.fromEntries(entries) as unknown as CompanyProfile;
}

// The company page ---------------------------------------------------------------------------------------------------

/**
 * GET /api/companies/:id (owner question 24): the company page. A merged company answers its survivor (`id` is then
 * the survivor's); an account's own page company answers its owner only.
 */
export const CompanyPageSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  profile: CompanyProfileSchema,
  /** "Part of {parent}". */
  parent: CompanyParentRefSchema.nullable(),
  /** The sources line ("Sources: the company's website, Wikidata, SEC EDGAR."). */
  sources: z.array(CompanySourceLineSchema),
  updatedAt: IsoDateTime.nullable(),
  counts: z.object({
    openJobs: z.number().int().nonnegative(),
    closedJobs: z.number().int().nonnegative(),
    lastPostedAt: IsoDateTime.nullable(),
  }),
});
export type CompanyPage = z.infer<typeof CompanyPageSchema>;

/** The company page's two lists: its open positions (newest first) and its closed history (latest closed first). */
export const COMPANY_JOB_STATES = ['open', 'closed'] as const;
export type CompanyJobState = (typeof COMPANY_JOB_STATES)[number];
export const CompanyJobsQuerySchema = z.object({
  state: z.enum(COMPANY_JOB_STATES).default('open'),
  cursor: AdminCursorSchema.optional(),
});
export type CompanyJobsQuery = z.infer<typeof CompanyJobsQuerySchema>;
/** One job of either list: a jobs-list card, and when it closed. */
export const CompanyJobItemSchema = JobSummarySchema.extend({ closedAt: IsoDateTime.nullable() });
export type CompanyJobItem = z.infer<typeof CompanyJobItemSchema>;
export const CompanyJobsResponseSchema = listResponse(CompanyJobItemSchema);
export type CompanyJobsResponse = z.infer<typeof CompanyJobsResponseSchema>;

// The admin editor ---------------------------------------------------------------------------------------------------

/** A company_sources row as the editor lists it (13 §6.3). */
export const AdminCompanySourceSchema = z.object({
  id: z.number().int(),
  kind: CompanySourceKindSchema,
  /** Board id, URL, QID, CIK, LEI, vendor record id, prompt version. */
  ref: z.string(),
  licence: z.enum(COMPANY_LICENCES),
  attribution: z.string().nullable(),
  matchConfidence: z.number().int().min(0).max(100),
  status: z.enum(COMPANY_SOURCE_STATUSES),
  retrievedAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
  purgeGroup: z.string().nullable(),
});
export type AdminCompanySource = z.infer<typeof AdminCompanySourceSchema>;

/** One field in the editor: its value in use, where it came from, how sure, locked or not, and the other candidates. */
export const AdminCompanyFieldSchema = z.object({
  field: z.enum(COMPANY_PROFILE_FIELDS),
  /** The value in use, as CompanyProfile holds it (null: none). */
  value: z.unknown(),
  sourceId: z.number().int().nullable(),
  sourceKind: CompanySourceKindSchema.nullable(),
  confidence: z.number().int().min(0).max(100).nullable(),
  /** People see it: an admin's value, or a confidence of at least COMPANY_FIELD_MIN_CONFIDENCE. */
  shown: z.boolean(),
  locked: z.boolean(),
  /** Two shown-grade sources disagree (company_profiles.conflicts). */
  conflict: z.boolean(),
  candidates: z
    .array(
      z.object({
        sourceId: z.number().int(),
        sourceKind: CompanySourceKindSchema,
        value: z.unknown(),
        confidence: z.number().int().min(0).max(100),
      }),
    )
    .max(20),
});
export type AdminCompanyField = z.infer<typeof AdminCompanyFieldSchema>;

/** A key that points at the company (company_aliases). */
export const AdminCompanyAliasSchema = z.object({
  kind: z.enum(COMPANY_ALIAS_KINDS),
  value: z.string(),
  confidence: z.number().int().min(0).max(100),
  isPrimary: z.boolean(),
  sourceId: z.number().int().nullable(),
  validFrom: IsoDate.nullable(),
  validTo: IsoDate.nullable(),
});
export type AdminCompanyAlias = z.infer<typeof AdminCompanyAliasSchema>;

/** One of the company's job sources (its boards), which a split may move to a new company. */
export const AdminCompanyBoardSchema = z.object({
  sourceId: z.number().int(),
  kind: z.enum(JOB_SOURCE_KINDS),
  name: z.string(),
  enabled: z.boolean(),
  openJobs: z.number().int().nonnegative(),
});

/** A parent or a child (company_relations), kept apart, never merged. */
export const AdminCompanyRelationSchema = z.object({
  company: CompanyParentRefSchema,
  kind: z.enum(COMPANY_RELATION_KINDS),
  confidence: z.number().int().min(0).max(100),
});

/** The admin company editor's company (13 §6.4). */
export const AdminCompanySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** The opt-out: no outside lookup, its domains on the opt-out list, its sources disabled and purged. */
  doNotFetch: z.boolean(),
  /** The company it was merged into: old links follow it. */
  mergedIntoId: z.number().int().nullable(),
  profile: CompanyProfileSchema,
  fields: z.array(AdminCompanyFieldSchema),
  aliases: z.array(AdminCompanyAliasSchema),
  sources: z.array(AdminCompanySourceSchema),
  boards: z.array(AdminCompanyBoardSchema),
  parents: z.array(AdminCompanyRelationSchema),
  children: z.array(AdminCompanyRelationSchema),
  counts: z.object({ openJobs: z.number().int().nonnegative(), closedJobs: z.number().int().nonnegative() }),
  openReviews: z.number().int().nonnegative(),
  enrichedAt: IsoDateTime.nullable(),
  nextRefreshAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
});
export type AdminCompany = z.infer<typeof AdminCompanySchema>;

/** One row of Admin › Companies. */
export const AdminCompanyRowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  domain: z.string().nullable(),
  logoUrl: z.string().nullable(),
  openJobs: z.number().int().nonnegative(),
  closedJobs: z.number().int().nonnegative(),
  doNotFetch: z.boolean(),
  mergedIntoId: z.number().int().nullable(),
  /** Its open match reviews. */
  openReviews: z.number().int().nonnegative(),
  updatedAt: IsoDateTime,
});
export type AdminCompanyRow = z.infer<typeof AdminCompanyRowSchema>;

/** The views of Admin › Companies. */
export const ADMIN_COMPANY_FILTERS = ['all', 'open_jobs', 'needs_review', 'opted_out', 'merged'] as const;
export const AdminCompaniesQuerySchema = z.object({
  q: text(200).optional(),
  filter: z.enum(ADMIN_COMPANY_FILTERS).default('all'),
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
});
export type AdminCompaniesQuery = z.infer<typeof AdminCompaniesQuerySchema>;
export const AdminCompaniesListSchema = z.object({
  items: z.array(AdminCompanyRowSchema),
  total: z.number().int().nonnegative(),
  nextCursor: AdminCursorSchema.optional(),
});

/** The values an admin may set: any profile field (null clears it); the summary's origin becomes `admin`. */
export const CompanyProfileInputSchema = CompanyProfileSchema.omit({ summaryOrigin: true }).partial();
export type CompanyProfileInput = z.infer<typeof CompanyProfileInputSchema>;

const FieldList = z.array(z.enum(COMPANY_PROFILE_FIELDS)).max(COMPANY_PROFILE_FIELDS.length);

/**
 * An admin's edit: `set` writes values, each then locked (no automated source changes it); `lock` and `unlock` lock a
 * field at its value in use, or hand it back to its sources.
 */
export const AdminCompanyEditBodySchema = z
  .object({ set: CompanyProfileInputSchema.optional(), lock: FieldList.optional(), unlock: FieldList.optional() })
  .refine((edit) => Object.keys(edit.set ?? {}).length + (edit.lock?.length ?? 0) + (edit.unlock?.length ?? 0) > 0, {
    error: 'Change a field, or lock or unlock one',
  });
export type AdminCompanyEditBody = z.infer<typeof AdminCompanyEditBodySchema>;

/** Merge company `otherId` into this one: its jobs, applications, sources and aliases move here; it keeps a pointer. */
export const AdminCompanyMergeBodySchema = z.object({ otherId: Id });
export type AdminCompanyMergeBody = z.infer<typeof AdminCompanyMergeBodySchema>;

/** Split: move these boards (sources) and their jobs to a new company of this name. */
export const AdminCompanySplitBodySchema = z.object({
  sourceIds: adminBulkIds(Id),
  name: text(300).pipe(z.string().min(1)),
});
export type AdminCompanySplitBody = z.infer<typeof AdminCompanySplitBodySchema>;

/** Refresh now: these enrichment steps (every step due, when absent). */
export const AdminCompanyRefreshBodySchema = z.object({
  steps: z.array(z.enum(COMPANY_ENRICHMENT_STEPS)).max(COMPANY_ENRICHMENT_STEPS.length).optional(),
});
export type AdminCompanyRefreshBody = z.infer<typeof AdminCompanyRefreshBodySchema>;

/** The opt-out switch, with the reason kept beside its domains on the opt-out list. */
export const AdminCompanyOptOutBodySchema = z.object({
  doNotFetch: z.boolean(),
  reason: text(500).pipe(z.string().min(1)),
});
export type AdminCompanyOptOutBody = z.infer<typeof AdminCompanyOptOutBodySchema>;

// The opt-out list ---------------------------------------------------------------------------------------------------

/** A registrable domain neither reader ever reads (crawl_opt_outs). */
export const AdminOptOutSchema = z.object({
  domain: z.string(),
  companyId: z.number().int().nullable(),
  companyName: z.string().nullable(),
  reason: z.string(),
  /** The admin who added it, by email; null when gone. */
  createdBy: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type AdminOptOut = z.infer<typeof AdminOptOutSchema>;
export const AdminOptOutCreateBodySchema = z.object({
  domain: RegistrableDomainSchema,
  reason: text(500).pipe(z.string().min(1)),
  companyId: Id.optional(),
});
export type AdminOptOutCreateBody = z.infer<typeof AdminOptOutCreateBodySchema>;
export const AdminOptOutListSchema = z.object({ items: z.array(AdminOptOutSchema), nextCursor: AdminCursorSchema.optional() });

// The match review queue ---------------------------------------------------------------------------------------------

/** A merge, homonym or weak match an admin decides (company_match_reviews), with both sides' evidence. */
export const AdminCompanyMatchReviewSchema = z.object({
  id: z.number().int(),
  kind: z.enum(COMPANY_MATCH_REVIEW_KINDS),
  status: z.enum(COMPANY_MATCH_REVIEW_STATUSES),
  company: CompanyParentRefSchema,
  otherCompany: CompanyParentRefSchema.nullable(),
  /** The candidate's evidence as the matcher kept it (keys, names, the record). */
  candidate: z.record(z.string(), z.unknown()),
  score: z.number().int().min(0).max(100),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
  /** The admin who decided, by email. */
  decidedBy: z.string().nullable(),
});
export type AdminCompanyMatchReview = z.infer<typeof AdminCompanyMatchReviewSchema>;
export const AdminCompanyMatchReviewsQuerySchema = z.object({
  status: z.enum([...COMPANY_MATCH_REVIEW_STATUSES, 'all']).default('open'),
  kind: z.enum(COMPANY_MATCH_REVIEW_KINDS).optional(),
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
});
export const AdminCompanyMatchReviewsListSchema = z.object({
  items: z.array(AdminCompanyMatchReviewSchema),
  total: z.number().int().nonnegative(),
  nextCursor: AdminCursorSchema.optional(),
});
/** v30 FIX-C UX-13: `reopen` puts a rejected review back on the open list (a decision made by mistake). */
export const AdminCompanyMatchDecisionBodySchema = z.object({ decision: z.enum(['accept', 'reject', 'reopen']) });
export type AdminCompanyMatchDecisionBody = z.infer<typeof AdminCompanyMatchDecisionBodySchema>;
