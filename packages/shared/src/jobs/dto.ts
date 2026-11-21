import { z } from 'zod';
import { COMPANY_FOUNDED_KINDS, COMPANY_STAGES, COMPANY_SUMMARY_ORIGINS } from '../companies/enums';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';
import { IsoDate, IsoDateTime, listResponse } from '../core/list';
import { JobKeywordsSchema, JobTermsSchema, LevelMatchSchema, MatchResultSchema } from '../match/schemas';
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, LEADERSHIP, SALARY_PERIODS, WORK_ARRANGEMENTS } from './enums';
import { JobVerificationSchema } from './add'; // v31 LINK
import { DEGREE_LEVELS_V2 } from './facts'; // v33 JOBDETAIL
import { JobsQuerySchema } from './query';
import { COMPANY_SIZE_IDS, JOB_REPORT_REASONS } from './taxonomy';

// Contracts of the Jobs endpoints (GET /api/jobs and friends). Job and company ids are integers (identity columns).

export const JobIdParam = z.coerce.number().int().positive();

/** A posting's pay as stated. `period` null means the posting did not say (shown without a suffix). */
export const SalarySchema = z.object({
  min: z.number().nonnegative().nullable(),
  max: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  period: z.enum(SALARY_PERIODS).nullable(),
});
export type Salary = z.infer<typeof SalarySchema>;

export const JobLocationSchema = z.object({
  raw: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  countryCode: z.string().nullable(),
  isRemote: z.boolean(),
});
export type JobLocation = z.infer<typeof JobLocationSchema>;

export const CompanyRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  logoUrl: z.string().nullable(),
});
export type CompanyRef = z.infer<typeof CompanyRefSchema>;

export const CompanySummarySchema = CompanyRefSchema.extend({
  tagline: z.string().nullable(),
  website: z.string().nullable(),
  /** Active postings, when the endpoint counts them. */
  jobCount: z.number().int().nonnegative().optional(),
});
export type CompanySummary = z.infer<typeof CompanySummarySchema>;

// v30 WEB-JOBS
/**
 * A job card's company (13 §2): the reference, plus the industry and size of the company's profile when the list
 * knows them (the Jobs page's list does; absent from an API older than v3.0 and from the other lists).
 */
export const JobCardCompanySchema = CompanyRefSchema.extend({
  /** An INDUSTRIES id (industryLabel), or null when the profile has none. */
  industry: z.string().nullable().optional(),
  sizeBucket: z.enum(COMPANY_SIZE_IDS).nullable().optional(),
});
export type JobCardCompany = z.infer<typeof JobCardCompanySchema>;
// end v30 WEB-JOBS

export const CompanyLinkSchema = z.object({ label: z.string(), url: z.string() });

// v30 CT
/**
 * A credit line a source's terms ask for on the jobs it gives (12 §3.6-3.7, owner question 16: Himalayas, Jobicy;
 * USAJOBS' is only encouraged): the words, and the source's https link when it asks for one. Also a source kind's
 * `attribution` (sourcing/kinds).
 */
export const JobCreditSchema = z.object({
  text: z.string().trim().min(1).max(200),
  url: z.string().max(2048).regex(/^https:\/\/\S+$/).optional(),
});
export type JobCredit = z.infer<typeof JobCreditSchema>;

/** The company a company is part of (13 §5.4), for "Part of {parent}". */
export const CompanyParentRefSchema = z.object({ id: z.number().int(), name: z.string() });
export type CompanyParentRef = z.infer<typeof CompanyParentRefSchema>;

/** One name of the Company section's sources line (13 §6.3): "the company's website", "Wikidata", with its link. */
export const CompanySourceLineSchema = z.object({ label: z.string().min(1).max(120), url: z.string().max(2048).optional() });
export type CompanySourceLine = z.infer<typeof CompanySourceLineSchema>;
// end v30 CT

/** The detail panel's Company section: about, plus whichever stats are known. */
export const CompanyDetailSchema = CompanySummarySchema.extend({
  about: z.string().nullable(),
  sizeBucket: z.enum(COMPANY_SIZE_IDS).nullable(),
  /** v30 E0-API (CT edit E): a COMPANY_STAGES id (v2.0's free text is mapped by migration 0014 and at ingest). */
  stage: z.enum(COMPANY_STAGES).nullable(),
  funding: z.string().nullable(),
  headquarters: z.string().nullable(),
  foundedYear: z.number().int().nullable(),
  industry: z.string().nullable(),
  links: z.array(CompanyLinkSchema),
  sponsorsH1b: z.boolean().nullable(),
  // v30 CT (13 §10, additive until E0 fills them); E0-API narrowed `stage` to a COMPANY_STAGES id (companyStageLabel
  // shows its words).
  /** The company's LinkedIn page, only as an allowed source names it (never read from LinkedIn). */
  linkedinUrl: z.string().nullable().optional(),
  /** Whether foundedYear is a founding ("Founded") or a registry's incorporation ("Incorporated"). */
  foundedKind: z.enum(COMPANY_FOUNDED_KINDS).nullable().optional(),
  /** "Part of {parent}". */
  parent: CompanyParentRefSchema.nullable().optional(),
  /** Where `about` came from: the company's own words, the AI (labelled), or an admin. */
  summaryOrigin: z.enum(COMPANY_SUMMARY_ORIGINS).nullable().optional(),
  /** The sources line ("Sources: the company's website, Wikidata. Updated November 2026."). */
  sources: z.array(CompanySourceLineSchema).optional(),
  updatedAt: IsoDateTime.nullable().optional(),
  // end v30 CT
});
export type CompanyDetail = z.infer<typeof CompanyDetailSchema>;

/** One card of the jobs list. Format with `formatLocationLine`, `formatSalaryRange` and `relativeTime`. */
export const JobSummarySchema = z.object({
  id: z.number().int(),
  title: z.string(),
  company: JobCardCompanySchema, // v30 WEB-JOBS: the card's company (was CompanyRefSchema; the new fields optional)
  /** The first place, formatted ("Fremont, CA, USA"); '' when the posting names none. */
  primaryLocation: z.string(),
  /** How many places the posting names in all. */
  locationCount: z.number().int().nonnegative(),
  workArrangement: z.enum(WORK_ARRANGEMENTS).nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
  experienceLevels: z.array(z.enum(EXPERIENCE_LEVELS)),
  salary: SalarySchema.nullable(),
  postedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime.nullable(),
  active: z.boolean(),
  /** The viewer's state, from the tracker. */
  saved: z.boolean(),
  appliedOn: IsoDate.nullable(),
  /**
   * The auto-apply agent can apply to it: its posting's form is at an address the agent opens (autofill agentCanApply:
   * on Greenhouse, Lever, Ashby or Workable themselves, never a company's own page).
   */
  autoApply: z.boolean(),
  /**
   * jr7 7a: the extension's Queue tab can open it (autofill queueCanOpen: every platform the extension fills, the
   * agent's among them, so true wherever autoApply is). True with autoApply false: a job that waits for the Queue tab.
   */
  queueApply: z.boolean(),
  // v30 CT
  /**
   * Held for review (14 §4.1): a posting first read through the extension from a board no enabled source runs. Only
   * the accounts that added it see it, in their Saved Jobs and Tracker, until an admin approves it (MSG_EXT_JOB_HELD).
   * Absent or false: not held.
   */
  held: z.boolean().optional(),
  /** The credit line the job's source asks for on its card (S4), or null; absent from an API older than v3.0. */
  credit: JobCreditSchema.nullable().optional(),
  // end v30 CT
  /**
   * v31 LINK: a job others do not see, and why (21-jobs-from-links.md §6): `waiting_admin` (TailorIT read it; an admin's
   * approval comes next) or `private_unverified` (TailorIT could not read its link: the viewer's own). Absent for a job
   * everyone sees.
   */
  verification: JobVerificationSchema.optional(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

/** GET /api/jobs: 21 per page; `total` is "Found N jobs". */
export const JobsListResponseSchema = listResponse(JobSummarySchema);
export type JobsListResponse = z.infer<typeof JobsListResponseSchema>;

export const JobUserStateSchema = z.object({
  saved: z.boolean(),
  /** The tracker application for this job, when there is one. */
  applicationId: z.string().nullable(),
  appliedOn: IsoDate.nullable(),
  hidden: z.boolean(),
  companyHidden: z.boolean(),
});
export type JobUserState = z.infer<typeof JobUserStateSchema>;

/**
 * Where a job TailorIT reads from no board came from (autofill API version 5): `linkedin`, added from a LinkedIn job's
 * page, or `page`, added from another page (an iCIMS, Taleo, SuccessFactors or Oracle posting, a company's careers
 * page), from the text the person saw there (POST /api/autofill/jobs/from-page).
 */
export const JOB_ADDED_FROM = ['linkedin', 'page'] as const;
export type JobAddedFrom = (typeof JOB_ADDED_FROM)[number];

/** The detail panel's "Added from LinkedIn" chip. */
export const JOB_ADDED_FROM_LABEL: Record<JobAddedFrom, string> = {
  linkedin: 'Added from LinkedIn',
  page: 'Added from the job page',
};

// v33 JOBDETAIL (F2): the limits of the job detail's benefits and of the glance's licences.
/** The most benefits a job detail lists. */
export const JOB_BENEFITS_MAX = 12;
/** The longest benefit, in characters (longer ones are cut at a word with "…"). */
export const JOB_BENEFIT_MAX_CHARS = 200;
/** The most required licences and certifications the glance lists. */
export const JOB_GLANCE_CERTIFICATIONS_MAX = 4;

/** GET /api/jobs/:id: the detail panel. Chips and facts are derived from these fields. */
export const JobDetailSchema = JobSummarySchema.extend({
  company: CompanyDetailSchema,
  locations: z.array(JobLocationSchema),
  leadership: z.enum(LEADERSHIP).nullable(),
  categoryId: z.string().nullable(),
  subcategoryIds: z.array(z.string()),
  degree: z.string().nullable(),
  sponsorsH1b: z.boolean().nullable(),
  requiresClearance: z.boolean().nullable(),
  industry: z.string().nullable(),
  /** Sanitized HTML ("Full posting"). */
  descriptionHtml: z.string(),
  /**
   * The original posting; Apply always opens it. For a job added from its page, the employer's own link when the page
   * showed one, else the page (a LinkedIn job's).
   */
  applyUrl: z.string(),
  /** Version 5: the page a job no board lists was added from (JOB_ADDED_FROM); null for every other job. */
  addedFrom: z.enum(JOB_ADDED_FROM).nullable(),
  lastVerifiedAt: IsoDateTime.nullable(),
  closedAt: IsoDateTime.nullable(),
  userState: JobUserStateSchema,
  /**
   * v33 JOBDETAIL (F2): the posting's benefits, read from its own words without AI (a "Benefits", "Perks" or "What we
   * offer" part): at most JOB_BENEFITS_MAX items of JOB_BENEFIT_MAX_CHARS each; [] when it lists none. Absent from an API
   * older than v3.3.
   */
  benefits: z.array(z.string().min(1).max(JOB_BENEFIT_MAX_CHARS)).max(JOB_BENEFITS_MAX).optional(),
});
export type JobDetail = z.infer<typeof JobDetailSchema>;

// v33 JOBDETAIL (F2): "Requirements at a glance". The job's side as labels; the person's side only as a verdict per row,
// computed on the server (the person's degree, years and certifications never reach the browser).
/**
 * One row's verdict: `meets` (the person's profile meets it), `below` (it asks for more than the profile shows) or
 * `unknown` (either side does not say).
 */
export const GLANCE_VERDICTS = ['meets', 'below', 'unknown'] as const;
export type GlanceVerdict = (typeof GLANCE_VERDICTS)[number];
const GlanceVerdictSchema = z.enum(GLANCE_VERDICTS);

export const JobGlanceSchema = z.object({
  experience: z.object({
    /** The posting's levels, in level order; [] when it names none. */
    levels: z.array(z.enum(EXPERIENCE_LEVELS)),
    /** The years of experience the posting asks for at least; null when it does not say. */
    minYears: z.number().int().min(0).max(40).nullable(),
    /** The years against the person's, with QUALIFICATION_YEARS_GRACE (the Prepare qualification filter's rule). */
    verdict: GlanceVerdictSchema,
  }),
  education: z.object({
    /** The lowest degree the posting asks for; null when it does not say. */
    degreeLevel: z.enum(DEGREE_LEVELS_V2).nullable(),
    /** The posting takes equivalent experience instead. */
    orEquivalent: z.boolean(),
    verdict: GlanceVerdictSchema,
  }),
  /** Up to JOB_GLANCE_CERTIFICATIONS_MAX required licences and certifications, by the posting's names. */
  certifications: z
    .array(z.object({ name: z.string().min(1).max(120), verdict: z.enum(['meets', 'unknown']) }))
    .max(JOB_GLANCE_CERTIFICATIONS_MAX),
});
export type JobGlance = z.infer<typeof JobGlanceSchema>;

export const JOB_ANALYSIS_SOURCES = ['deterministic', 'ft_lake', 'ai'] as const;
export type JobAnalysisSource = (typeof JOB_ANALYSIS_SOURCES)[number];

/**
 * GET /api/jobs/:id/analysis: the "About the job" summary and the keywords the match uses. `refining` is true while an
 * AI analysis is running; the page shows this version with a quiet "Refining..." and swaps when it is ready.
 * The last three fields are optional: answers from before they were read leave them out.
 */
export const JobAnalysisViewSchema = z.object({
  source: z.enum(JOB_ANALYSIS_SOURCES),
  refining: z.boolean(),
  requirements: z.array(z.string()),
  responsibilities: z.array(z.string()),
  desired: z.array(z.string()),
  keywords: JobKeywordsSchema,
  experienceLevels: z.array(z.enum(EXPERIENCE_LEVELS)),
  categoryId: z.string().nullable(),
  subcategoryIds: z.array(z.string()),
  /** Soft skills the posting asks for, by their canonical names. */
  softSkills: z.array(z.string()).optional(),
  /** The certifications and industries it names (its "keywords" beside the skills). */
  terms: JobTermsSchema.optional(),
  /** The years of experience its requirements ask for ("Experience: N+ years"); null when it does not say. */
  requiredYears: z.number().int().min(0).max(30).nullable().optional(),
});
export type JobAnalysisView = z.infer<typeof JobAnalysisViewSchema>;

/** GET /api/jobs/:id/match: the job analysis card. */
export const JobMatchResponseSchema = MatchResultSchema;
export type JobMatchResponse = z.infer<typeof JobMatchResponseSchema>;

/** The facts grid's level check, computed with `levelMatch(job.experienceLevels, preferences.experienceLevels)`. */
export const JobLevelMatchSchema = LevelMatchSchema;

// v33 JOBDETAIL: the job page's poll, one contract for the API and the web (it was written out on both sides).
/** The job page's match: the keyword match plus the experience-level check against the person's preferences. */
export const JobMatchWithLevelSchema = MatchResultSchema.extend({ levelMatch: LevelMatchSchema.optional() });
export type JobMatchWithLevel = z.infer<typeof JobMatchWithLevelSchema>;

/**
 * GET /api/jobs/:id/insights: the analysis ("About the job"), the match computed from that same analysis (Skills), so
 * the two always change together, and (v3.3) the requirements at a glance. `match` is null when it could not be
 * computed; `glance` is absent when it could not be (and from an API older than v3.3).
 */
export const JobInsightsSchema = z.object({
  analysis: JobAnalysisViewSchema,
  match: JobMatchWithLevelSchema.nullable(),
  glance: JobGlanceSchema.optional(),
});
export type JobInsights = z.infer<typeof JobInsightsSchema>;
// end v33 JOBDETAIL

/** POST/DELETE /api/jobs/:id/hide and POST /api/companies/:id/hide. */
export const JobHideResponseSchema = z.object({ hidden: z.boolean() });

/** POST /api/jobs/:id/report. */
export const JobReportBodySchema = z.object({
  reason: z.enum(JOB_REPORT_REASONS),
  details: z.string().trim().max(2000).default(''),
});
export type JobReportBody = z.infer<typeof JobReportBodySchema>;

/**
 * Save all (the list header) saves at most SAVE_BATCH_MAX jobs per click (a central constant, 100 by default, which an
 * admin may change), in the order the list shows them. The schemas below take the constant's own maximum (500) as a
 * technical ceiling; the server saves at most the resolved value (v2.0, 02-constants.md).
 */
export const SAVE_BATCH_CEILING = PUBLIC_CONSTANT_SPECS.SAVE_BATCH_MAX.max;

/** GET /api/jobs/save-all/preview?<the list's query string>: the numbers of the "Save N jobs?" confirm. */
export const SaveAllPreviewSchema = z.object({
  /** Every match, as "Found N jobs" counts them. */
  matched: z.number().int().nonnegative(),
  /** Matches Save all can save: jobs not saved yet (never tracked, or un-saved: archived while only Saved). */
  saveable: z.number().int().nonnegative(),
  /** What one click saves: min(saveable, SAVE_BATCH_MAX). */
  willSave: z.number().int().nonnegative().max(SAVE_BATCH_CEILING),
});
export type SaveAllPreview = z.infer<typeof SaveAllPreviewSchema>;

/** POST /api/jobs/save-all?<the list's query string>. `occurredOn`: the browser's day (default today, UTC). */
export const SaveAllBodySchema = z.object({ occurredOn: IsoDate.optional() });
export type SaveAllBody = z.infer<typeof SaveAllBodySchema>;

/** One job a Save all click saved. */
export const SavedJobRefSchema = z.object({
  jobId: z.number().int().positive(),
  applicationId: z.string(),
  /** The resume linked to it: the best match, one it already had, or null (none yet, or still being chosen). */
  resumeId: z.string().nullable(),
  /** False when an application archived by an earlier un-save was brought back. */
  created: z.boolean(),
});
export type SavedJobRef = z.infer<typeof SavedJobRefSchema>;

export const SaveAllResponseSchema = z.object({
  /** The jobs this click saved, in the list's order. Undo archives exactly these applications. */
  items: z.array(SavedJobRefSchema).max(SAVE_BATCH_CEILING),
  /** Matches left as they were: saved already, or applied to (archived or not). */
  alreadyTracked: z.number().int().nonnegative(),
  /** Matches still saveable after this click (Save all again saves the next ones). */
  remaining: z.number().int().nonnegative(),
  /** Saved jobs whose best resume is still being chosen; TailorIT links it within seconds. */
  pendingMatches: z.number().int().nonnegative(),
  /** True when the server stopped part-way; `items` is what it saved. */
  incomplete: z.boolean(),
});
export type SaveAllResponse = z.infer<typeof SaveAllResponseSchema>;

export const SavedSearchSchema = z.object({
  id: z.string(),
  name: z.string(),
  query: JobsQuerySchema,
  createdAt: IsoDateTime,
});
export type SavedSearch = z.infer<typeof SavedSearchSchema>;

export const SavedSearchListSchema = listResponse(SavedSearchSchema);

/** POST /api/saved-searches. The cursor is never saved. */
export const CreateSavedSearchBodySchema = z.object({
  name: z.string().trim().min(1, 'Give the search a name').max(100),
  query: JobsQuerySchema,
});
export type CreateSavedSearchBody = z.infer<typeof CreateSavedSearchBodySchema>;

/** The facet lists the filters search over (GET /api/jobs/facets/:facet). */
export const JOB_FACETS = [
  'categories',
  'subcategories',
  'industries',
  'companySizes',
  'companies',
  'locations',
  'remoteCountries',
] as const;
export type JobFacet = (typeof JOB_FACETS)[number];

export const JobFacetQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const JobFacetItemSchema = z.object({
  value: z.string(),
  label: z.string(),
  count: z.number().int().nonnegative(),
  /** A subcategory's category. */
  parent: z.string().optional(),
});
export type JobFacetItem = z.infer<typeof JobFacetItemSchema>;

export const JobFacetResponseSchema = z.object({
  facet: z.enum(JOB_FACETS),
  items: z.array(JobFacetItemSchema),
});
export type JobFacetResponse = z.infer<typeof JobFacetResponseSchema>;

/**
 * GET /api/jobs/facets/summary: which filters the data can answer ("a filter only appears when the data has values
 * for it"), with the small facet lists inline.
 */
export const JobFacetsSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  available: z.object({
    salary: z.boolean(),
    h1b: z.boolean(),
    clearance: z.boolean(),
    leadership: z.boolean(),
    industries: z.boolean(),
    companySizes: z.boolean(),
    arrangements: z.boolean(),
    levels: z.boolean(),
  }),
  categories: z.array(JobFacetItemSchema),
  remoteCountries: z.array(JobFacetItemSchema),
});
export type JobFacetsSummary = z.infer<typeof JobFacetsSummarySchema>;
