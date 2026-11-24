import { z } from 'zod';
import type { ClearanceLevel } from '../autofill/profile';
import type { MessageKey } from '../constants/constants';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';
import { EXPERIENCE_LEVELS, WORK_ARRANGEMENTS, type ExperienceLevel, type WorkArrangement } from '../jobs/enums';
import {
  EMPLOYMENT_TYPES_V2,
  type AuthorizationRequirement,
  type DegreeLevelV2,
  type EmploymentTypeV2,
  type JobAutoApplySupport,
  type SponsorshipState,
} from '../jobs/facts';
import { INDUSTRY_IDS } from '../jobs/taxonomy';

// v2.0: the prepare filters (docs/design/v2.0/06-filters-analysis.md). They decide which saved jobs may be prepared,
// on the server path and the MCP path alike, with deterministic code over each job's facts (evaluateFilters, P4). A
// value the analysis does not know passes. The only filter an AI judges is the Custom filter, against the person's
// own prompt. Settings › Prepare edits them; user_settings.prepare_filters keeps them.
//   GET  /api/prepare/filters          → PrepareFiltersResponse
//   PUT  /api/prepare/filters          PrepareFiltersPutBody → PrepareFiltersResponse (filters_revision + 1)
//   POST /api/prepare/filters/preview  PrepareFiltersPutBody → PrepareFiltersPreview (Saved jobs, no AI)

/**
 * The Custom filter prompt's technical ceiling, CUSTOM_FILTER_PROMPT_MAX_CHARS's own bound (v30 CT, audit B3); the
 * route checks the resolved constant, at most this.
 */
export const CUSTOM_FILTER_PROMPT_CEILING = PUBLIC_CONSTANT_SPECS.CUSTOM_FILTER_PROMPT_MAX_CHARS.max;

const CustomFilterSchema = z.object({
  enabled: z.boolean(),
  prompt: z.string().trim().max(CUSTOM_FILTER_PROMPT_CEILING),
});

/**
 * The person's saved prepare filters. An absent field is off, so `{}` parses to "nothing filtered". Lists are the
 * values allowed (`[]`: any); switches turn a mismatch filter on. A prompt is required when `custom.enabled` (the
 * route checks it, with the prompt's length).
 */
export const PrepareFiltersSchema = z.object({
  locationTypes: z.array(z.enum(WORK_ARRANGEMENTS)).max(3).default([]),
  jobTypes: z.array(z.enum(EMPLOYMENT_TYPES_V2)).max(6).default([]),
  industries: z
    .object({ mode: z.enum(['include', 'exclude']), ids: z.array(z.enum(INDUSTRY_IDS)).max(50) })
    .nullable()
    .default(null),
  locationMismatch: z.boolean().default(false),
  qualificationMismatch: z.boolean().default(false),
  certificationMismatch: z.boolean().default(false),
  autoApplySupport: z.enum(['all', 'supported']).default('all'),
  /** Yearly, in USD. */
  minSalaryUsd: z.number().int().min(0).max(10_000_000).nullable().default(null),
  experienceLevels: z.array(z.enum(EXPERIENCE_LEVELS)).max(5).default([]),
  /** "I need visa sponsorship": drop jobs that say they do not sponsor. */
  noSponsorship: z.boolean().default(false),
  clearanceMismatch: z.boolean().default(false),
  custom: CustomFilterSchema.default({ enabled: false, prompt: '' }),
});
export type PrepareFilters = z.infer<typeof PrepareFiltersSchema>;
export type PrepareFiltersInput = z.input<typeof PrepareFiltersSchema>;

/**
 * MCP filter_jobs' `extra`: what the person asked for in this chat, on top of the saved filters. It can only narrow
 * (mergeExtra, P4): each list is intersected with the saved one, and a switch can be turned on, never off. It holds
 * no Custom filter: that is the saved prompt alone.
 */
export const PrepareFiltersExtraSchema = z
  .object({
    locationTypes: z.array(z.enum(WORK_ARRANGEMENTS)).max(3),
    jobTypes: z.array(z.enum(EMPLOYMENT_TYPES_V2)).max(6),
    industries: z.object({ mode: z.enum(['include', 'exclude']), ids: z.array(z.enum(INDUSTRY_IDS)).max(50) }),
    locationMismatch: z.literal(true),
    qualificationMismatch: z.literal(true),
    certificationMismatch: z.literal(true),
    autoApplySupport: z.literal('supported'),
    minSalaryUsd: z.number().int().min(0).max(10_000_000),
    experienceLevels: z.array(z.enum(EXPERIENCE_LEVELS)).max(5),
    noSponsorship: z.literal(true),
    clearanceMismatch: z.literal(true),
  })
  .partial()
  .strict();
export type PrepareFiltersExtra = z.infer<typeof PrepareFiltersExtraSchema>;

/**
 * The filters' reason codes, in the fixed order evaluateFilters lists every failing filter (06's table). A Saved job's
 * label ("Filtered: on-site") shows the first one.
 */
export const FILTER_REASONS = [
  'auto_apply',
  'location_type',
  'job_type',
  'industry',
  'location_mismatch',
  'qualification',
  'certification',
  'salary',
  'experience',
  'sponsorship',
  'clearance',
  'custom',
  // v33 SHARE-5 (PLAN F9 "Sensitive answers"; PLAN-sharing.md §4): never stored or evaluated; what someone the profile
  // is shared with sees, without the Sensitive answers permission, in place of a reason that comes from an eligibility
  // answer (sponsorship, clearance, a citizenship): one reason, no value (maskEligibility, evaluate.ts).
  'eligibility',
] as const;
export type FilterReason = (typeof FILTER_REASONS)[number];

/** The constant whose words fill {reason} in MSG_FILTERED, for each reason (with its `value`, when it has one). */
export const FILTER_REASON_LABELS = {
  auto_apply: 'FILTER_LABEL_AUTO_APPLY',
  location_type: 'FILTER_LABEL_LOCATION_TYPE',
  job_type: 'FILTER_LABEL_JOB_TYPE',
  industry: 'FILTER_LABEL_INDUSTRY',
  location_mismatch: 'FILTER_LABEL_LOCATION_MISMATCH',
  qualification: 'FILTER_LABEL_QUALIFICATION',
  certification: 'FILTER_LABEL_CERTIFICATION',
  salary: 'FILTER_LABEL_SALARY',
  experience: 'FILTER_LABEL_EXPERIENCE',
  sponsorship: 'FILTER_LABEL_SPONSORSHIP',
  clearance: 'FILTER_LABEL_CLEARANCE',
  custom: 'FILTER_LABEL_CUSTOM',
  eligibility: 'FILTER_LABEL_ELIGIBILITY', // v33 SHARE-5
} as const satisfies Record<FilterReason, MessageKey>;

/**
 * One failing filter: its code and the word that fills the label's {value} (from the filters' fixed vocabulary:
 * "on-site", "contract", "TX, CA only", "Master's", "CISSP", "$90k", "Senior"). prepare_filter_results.reasons keeps a
 * list of these, in FILTER_REASONS' order.
 */
export const FilterReasonEntrySchema = z.object({
  code: z.enum(FILTER_REASONS),
  value: z.string().max(80).optional(),
});
export type FilterReasonEntry = z.infer<typeof FilterReasonEntrySchema>;

/** evaluateFilters' answer: every failing filter, in order; `pass` with none. */
export interface FilterVerdict {
  verdict: 'pass' | 'fail';
  reasons: FilterReasonEntry[];
}

/** The Custom filter's state for one job: its verdict, not judged yet (`pending`), or the filter is off. */
export type CustomFilterState = 'pass' | 'fail' | 'pending' | 'off';

/** A required or preferred certification, by its comparison key (certKey) and the posting's name for it. */
export interface JobCertification {
  key: string;
  name: string;
  required: boolean;
}

/**
 * A job's facts as the filters read them (job_facts and its child tables, 0825). Every null is unknown, and passes.
 * `eligibility` lists the candidate-location rule's allowed values by kind; empty lists are no rule.
 */
export interface JobFactsView {
  jobId: number;
  workArrangement: WorkArrangement | null;
  employmentType: EmploymentTypeV2 | null;
  industry: string | null;
  degreeLevel: DegreeLevelV2 | null;
  /** The posting accepts equivalent experience instead of the degree (job_facts.details). */
  degreeOrEquivalent: boolean;
  minYears: number | null;
  experienceLevels: ExperienceLevel[];
  clearanceRequired: boolean | null;
  sponsorship: SponsorshipState | null;
  authorization: AuthorizationRequirement | null;
  /** The citizenship a `citizen` authorization asks for (job_facts.details); null when unknown. */
  citizenshipCountry: string | null;
  salaryMinUsd: number | null;
  salaryMaxUsd: number | null;
  coverLetterRequired: boolean | null;
  autoApply: JobAutoApplySupport;
  questionsKnown: number;
  eligibility: {
    /** ISO 3166-1 alpha-2 ("US"). */
    countries: string[];
    /** ISO 3166-2 ("US-TX"). */
    regions: string[];
    /** Standard-time offsets ("-0800"). */
    utcOffsets: string[];
  };
  certifications: JobCertification[];
}

/**
 * The person's side of the filters (personFacts, server only: never sent to an AI, never logged). Every null is
 * unknown, and the part of a filter that reads it passes.
 */
export interface PersonFacts {
  /** user_preferences.home_country. */
  country: string | null;
  /** user_preferences.home_region, without its country ("TX"). */
  region: string | null;
  /** user_preferences.time_zone's standard offset ("-0500"). */
  timeZoneOffset: string | null;
  highestDegree: DegreeLevelV2 | null;
  /** Whole years, overlaps merged, an ongoing role counted to today. */
  yearsExperience: number | null;
  /** The profile's certifications as certKeys; empty is unknown, never "has none". */
  certKeys: string[];
  /** The profile's sensitive citizenships (alpha-2); null when not provided. */
  citizenships: string[] | null;
  /** The profile's sensitive clearance level; null when not provided. */
  clearance: ClearanceLevel | null;
}

/** GET and PUT /api/prepare/filters: the saved filters, their revision, and whether the person's location is known. */
export const PrepareFiltersResponseSchema = z.object({
  filters: PrepareFiltersSchema,
  /** user_settings.filters_revision: +1 at every change (a verdict of an older revision is stale). */
  revision: z.number().int().nonnegative(),
  /** The location filter has the person's country (and region) to compare with. */
  locationKnown: z.boolean(),
  /** ... and their time zone. */
  timeZoneKnown: z.boolean(),
});
export type PrepareFiltersResponse = z.infer<typeof PrepareFiltersResponseSchema>;

export const PrepareFiltersPutBodySchema = z.object({ filters: PrepareFiltersSchema });
export type PrepareFiltersPutBody = z.infer<typeof PrepareFiltersPutBodySchema>;

/** POST /api/prepare/filters/preview: "With these filters, 38 of your 52 saved jobs can be prepared." */
export const PrepareFiltersPreviewSchema = z.object({
  total: z.number().int().nonnegative(),
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  /** Failing jobs by their first reason. */
  byReason: z.partialRecord(z.enum(FILTER_REASONS), z.number().int().nonnegative()),
});
export type PrepareFiltersPreview = z.infer<typeof PrepareFiltersPreviewSchema>;
