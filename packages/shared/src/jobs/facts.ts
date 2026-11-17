import { z } from 'zod';
import { INDUSTRY_IDS } from './taxonomy';

// v2.0: job analysis version 2's structured facts (docs/design/v2.0/06-filters-analysis.md). The AI's v2 answer is
// stored, normalized, on its job_analyses row (`facts`, 0825); the facts every filter reads are kept per job in
// job_facts and its two child tables (built by P4's buildJobFacts from the analysis, the deterministic extraction and
// the ingest columns). A null is "unknown", and every filter passes an unknown.

/** Employment types the analysis tells apart: jobs.employment_type's four, plus `unpaid` and `temporary`. */
export const EMPLOYMENT_TYPES_V2 = ['full_time', 'part_time', 'contract', 'internship', 'unpaid', 'temporary'] as const;
export type EmploymentTypeV2 = (typeof EMPLOYMENT_TYPES_V2)[number];

/** The highest degree a posting requires (and the person's own, for the qualification filter), lowest first. */
export const DEGREE_LEVELS_V2 = ['none', 'high_school', 'associate', 'bachelor', 'master', 'doctorate'] as const;
export type DegreeLevelV2 = (typeof DEGREE_LEVELS_V2)[number];

/** The work authorization a posting requires: a citizenship, permanent residence, or any authorization. */
export const AUTHORIZATION_REQUIREMENTS = ['citizen', 'permanent_resident', 'any'] as const;
export type AuthorizationRequirement = (typeof AUTHORIZATION_REQUIREMENTS)[number];

/** The security clearance a posting requires, lowest first. */
export const CLEARANCE_REQUIREMENTS = ['public-trust', 'confidential', 'secret', 'top-secret', 'ts-sci'] as const;
export type ClearanceRequirement = (typeof CLEARANCE_REQUIREMENTS)[number];

/** Whether the extension can open a posting: Run auto-apply (`agent`), the Queue tab alone (`tab`), or neither. */
export const JOB_AUTO_APPLY_SUPPORT = ['agent', 'tab', 'none'] as const;
export type JobAutoApplySupport = (typeof JOB_AUTO_APPLY_SUPPORT)[number];

/** jobs.sponsors_h1b, read as the sponsorship filter's input. */
export const SPONSORSHIP_STATES = ['offered', 'not_offered'] as const;
export type SponsorshipState = (typeof SPONSORSHIP_STATES)[number];

/** The kinds of a candidate-location rule's rows (job_facts_eligibility.kind). */
export const ELIGIBILITY_KINDS = ['country', 'region', 'utc_offset'] as const;
export type EligibilityKind = (typeof ELIGIBILITY_KINDS)[number];
/** Who found a rule row: the deterministic extraction, or the AI's v2 answer. */
export const ELIGIBILITY_SOURCES = ['rules', 'ai'] as const;
export type EligibilitySource = (typeof ELIGIBILITY_SOURCES)[number];

/** ISO 3166-1 alpha-2, upper case ("US"). */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code, like US');
/** ISO 3166-2, "<country>-<subdivision>" ("US-TX", "CA-ON"). */
export const RegionCode = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, 'Use a region code, like US-TX');
/** A standard-time UTC offset, "±HHMM" ("-0800" is Pacific). */
export const UtcOffset = z.string().regex(/^[+-](0\d|1[0-4])[0-5]\d$/, 'Use an offset such as -0800');

/** An office or site the posting names as where the role sits (not where candidates must live). */
export const OfficeLocationSchema = z.object({
  city: z.string().max(100).nullable(),
  /** A state or province code, such as "TX". */
  region: z.string().max(6).nullable(),
  country: CountryCode.nullable(),
});
export type OfficeLocation = z.infer<typeof OfficeLocationSchema>;

/**
 * The AI's v2 answer, as stored in job_analyses.facts (normalized: codes upper-cased, values outside their lists
 * dropped, time zones turned into offsets by the extraction's normalizeTimeZones). The prompt's own lenient reading
 * (each new field `.optional().catch(undefined)`) lives with the job analysis feature.
 */
export const JobAnalysisV2FactsSchema = z.object({
  employmentType: z.enum(EMPLOYMENT_TYPES_V2).nullable(),
  industry: z.enum(INDUSTRY_IDS).nullable(),
  officeLocations: z.array(OfficeLocationSchema).max(10),
  /** Who may apply because of where they live or work from; null when the posting sets no such rule. */
  candidateEligibility: z
    .object({
      countries: z.array(CountryCode).max(60),
      regions: z.array(RegionCode).max(80),
      /** As the posting writes them ("PST", "US time zones", "within 2 hours of EST"). */
      timeZones: z.array(z.string().max(60)).max(20),
      /** The posting's sentence, at most 200 characters. */
      quote: z.string().max(200).nullable(),
    })
    .nullable(),
  requiredQualifications: z.object({
    degreeLevel: z.enum(DEGREE_LEVELS_V2).nullable(),
    /** True when the posting accepts equivalent experience instead of the degree. */
    orEquivalent: z.boolean(),
    minYears: z.number().int().min(0).max(40).nullable(),
    skills: z.array(z.string().max(80)).max(20),
    authorization: z.enum(AUTHORIZATION_REQUIREMENTS).nullable(),
    citizenshipCountry: CountryCode.nullable(),
    clearance: z.enum(CLEARANCE_REQUIREMENTS).nullable(),
  }),
  requiredCertifications: z.array(z.string().max(120)).max(10),
  preferredCertifications: z.array(z.string().max(120)).max(10),
  /** True: the posting says a cover letter is required; false: it says none is needed; null: it says nothing. */
  coverLetterRequired: z.boolean().nullable(),
});
export type JobAnalysisV2Facts = z.infer<typeof JobAnalysisV2FactsSchema>;

/**
 * job_facts.details: what no filter searches by, kept for the job's detail ("What TailorIT read") and the kit view.
 * v2.0 build: `degreeOrEquivalent` and `citizenshipCountry` are kept here too, because the qualification filter needs
 * them (06's filter 6) and job_facts (0825) has no column for either.
 */
export const JobFactsDetailsSchema = z.object({
  officeLocations: z.array(OfficeLocationSchema).max(10).default([]),
  skills: z.array(z.string().max(80)).max(20).default([]),
  eligibilityQuote: z.string().max(200).nullable().default(null),
  preferredCertifications: z.array(z.string().max(120)).max(10).default([]),
  degreeOrEquivalent: z.boolean().default(false),
  citizenshipCountry: CountryCode.nullable().default(null),
});
export type JobFactsDetails = z.infer<typeof JobFactsDetailsSchema>;
