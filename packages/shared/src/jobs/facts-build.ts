import { agentApplicationUrl, queueCanOpen } from '../autofill/agent';
import type { JobCertification, JobFactsView } from '../filters/schema';
import { certKey, type DeterministicFacts } from './eligibility';
import { EXPERIENCE_LEVELS, WORK_ARRANGEMENTS, type ExperienceLevel, type WorkArrangement } from './enums';
import {
  AUTHORIZATION_REQUIREMENTS,
  DEGREE_LEVELS_V2,
  EMPLOYMENT_TYPES_V2,
  JobFactsDetailsSchema,
  type AuthorizationRequirement,
  type DegreeLevelV2,
  type EligibilityKind,
  type EligibilitySource,
  type EmploymentTypeV2,
  type JobAnalysisV2Facts,
  type JobAutoApplySupport,
  type JobFactsDetails,
  type SponsorshipState,
} from './facts';
import { INDUSTRY_IDS } from './taxonomy';

// v2.0 P4 (06-filters-analysis.md, "job_facts: what each filter reads"): one job's facts, merged field by field from the
// v2 AI answer, the ingest columns and the v1 analysis, and the deterministic rules, in 06's order. Pure: the API
// (features/job-facts) reads the sources and stores what this answers in job_facts and its two child tables. A null is
// unknown, and every filter passes it.

/** The job's own columns (jobs, job_locations) that the facts read. */
export interface FactsJobInput {
  applyUrl: string;
  /** jobs.work_arrangement (ingest; v1's AI arrangement is put there too, when the posting backs it). */
  workArrangement: string | null;
  /** jobs.employment_type: one of the four the column holds. */
  employmentType: string | null;
  /** jobs.industry (ingest). */
  industry: string | null;
  experienceLevels: readonly string[];
  /** jobs.sponsors_h1b: 1 offered, 0 not offered. */
  sponsorsH1b: number | null;
  requiresClearance: number | null;
  /** jobs.degree, as ingest or v1's AI wrote it ("Bachelor's"). */
  degree: string | null;
  salaryAnnualUsdMin: number | null;
  salaryAnnualUsdMax: number | null;
  /** job_locations: a remote location's place is eligibility; every location remote makes the arrangement remote. */
  locations: ReadonlyArray<{ region: string | null; countryCode: string | null; isRemote: boolean }>;
}

/** The job's best analysis (jobs.analysis_id), as the facts read it; null when it has none. */
export interface FactsAnalysisInput {
  source: 'ai' | 'ft_lake' | 'deterministic';
  version: number;
  minYears: number | null;
  requiredYears: number | null;
  experienceLevels: readonly string[];
  /** The AI's checked facts (job-analysis ai.ts AiFacts): `workArrangement`, `degree`, ... */
  extras: Readonly<Record<string, unknown>>;
  /** terms.domains: INDUSTRIES ids. */
  domains: readonly string[];
  /** The v2 answer (job_analyses.facts), normalized; null below version 2. */
  v2: JobAnalysisV2Facts | null;
}

/** One candidate-location row (job_facts_eligibility). */
export interface JobFactsEligibilityRow {
  kind: EligibilityKind;
  value: string;
  source: EligibilitySource;
}

/** What buildJobFacts answers: job_facts' columns, its child rows and its details. */
export interface BuiltJobFacts {
  workArrangement: WorkArrangement | null;
  employmentType: EmploymentTypeV2 | null;
  industry: string | null;
  degreeLevel: DegreeLevelV2 | null;
  minYears: number | null;
  experienceLevels: ExperienceLevel[];
  clearanceRequired: boolean | null;
  sponsorship: SponsorshipState | null;
  authorization: AuthorizationRequirement | null;
  salaryMinUsd: number | null;
  salaryMaxUsd: number | null;
  coverLetterRequired: boolean | null;
  autoApply: JobAutoApplySupport;
  questionsKnown: number;
  eligibility: JobFactsEligibilityRow[];
  certifications: JobCertification[];
  details: JobFactsDetails;
}

const is = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** A degree as a posting or v1 wrote it, as a level ("Bachelor's" -> bachelor); null when it reads as none of them. */
export function degreeLevelOf(text: string | null | undefined): DegreeLevelV2 | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const value = text.toLowerCase();
  if (/\b(?:ph\.?\s?d|doctor(?:ate|al)?|d\.?phil)\b/.test(value)) return 'doctorate';
  if (/\bmaster|\bm\.?s\.?c?\b|\bmba\b|\bm\.?eng\b|\bm\.?a\b/.test(value)) return 'master';
  if (/\bbachelor|\bb\.?s\.?c?\b|\bb\.?a\b|\bb\.?eng\b|\bundergraduate\b|\b4[- ]year\b/.test(value)) return 'bachelor';
  if (/\bassociate/.test(value)) return 'associate';
  if (/\bhigh[\s-]?school\b|\bged\b|\bdiploma\b/.test(value)) return 'high_school';
  if (/\bno degree\b|\bnone\b/.test(value)) return 'none';
  return null;
}

/** Whether the extension can open a posting: Run auto-apply (`agent`), the Queue tab alone (`tab`), or neither. */
export function autoApplySupportOf(applyUrl: string): JobAutoApplySupport {
  if (typeof applyUrl !== 'string' || !applyUrl.trim()) return 'none';
  if (agentApplicationUrl(applyUrl) !== null) return 'agent';
  return queueCanOpen(applyUrl) ? 'tab' : 'none';
}

const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z]{2}-[A-Z0-9]{1,6}$/;
const OFFSET = /^[+-]\d{4}$/;

/** The rows of one kind from the first source that has any (06: rules, then the AI, then the remote locations). */
function firstRows(kind: EligibilityKind, sources: ReadonlyArray<[readonly string[], EligibilitySource]>): JobFactsEligibilityRow[] {
  const valid = kind === 'country' ? COUNTRY : kind === 'region' ? REGION : OFFSET;
  for (const [values, source] of sources) {
    const kept = [...new Set(values)].filter((value) => valid.test(value) && value.length <= 9);
    if (kept.length > 0) return kept.map((value) => ({ kind, value, source }));
  }
  return [];
}

function wholeUsd(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * One job's facts (06's table), each field from its first source that knows it: the v2 AI answer, the ingest columns
 * and the v1 analysis, the rules. `questionsKnown` is the count of the job's known questions (job_form_questions).
 */
export function buildJobFacts(
  job: FactsJobInput,
  analysis: FactsAnalysisInput | null,
  deterministic: DeterministicFacts,
  questionsKnown: number,
): BuiltJobFacts {
  const ai = analysis?.source === 'ai' ? analysis : null;
  const v2 = ai && ai.version >= 2 ? ai.v2 : null;
  const v2Arrangement = v2 ? ai?.extras.workArrangement : null;
  const locations = job.locations;
  const workArrangement = is(WORK_ARRANGEMENTS, v2Arrangement)
    ? v2Arrangement
    : is(WORK_ARRANGEMENTS, job.workArrangement)
      ? job.workArrangement
      : locations.length > 0 && locations.every((location) => location.isRemote)
        ? 'remote'
        : null;

  const employmentType = v2?.employmentType ?? (is(EMPLOYMENT_TYPES_V2, job.employmentType) ? job.employmentType : null);
  const domain = analysis?.domains.find((id) => is(INDUSTRY_IDS, id)) ?? null;
  const industry = v2?.industry ?? (is(INDUSTRY_IDS, job.industry) ? job.industry : null) ?? domain;

  const qualifications = v2?.requiredQualifications ?? null;
  const v1Degree = typeof analysis?.extras.degree === 'string' ? analysis.extras.degree : job.degree;
  const degreeLevel = qualifications?.degreeLevel ?? degreeLevelOf(v1Degree);
  const v1Years = analysis?.minYears ?? analysis?.requiredYears ?? null;
  const minYears = qualifications?.minYears ?? (typeof v1Years === 'number' && v1Years >= 0 && v1Years <= 40 ? Math.round(v1Years) : null);

  const jobLevels = job.experienceLevels.filter((level): level is ExperienceLevel => is(EXPERIENCE_LEVELS, level));
  const experienceLevels = jobLevels.length > 0
    ? jobLevels
    : (analysis?.experienceLevels ?? []).filter((level): level is ExperienceLevel => is(EXPERIENCE_LEVELS, level));

  const clearanceRequired = qualifications?.clearance ? true : job.requiresClearance === 1 ? true : job.requiresClearance === 0 ? false : null;
  const sponsorship: SponsorshipState | null = job.sponsorsH1b === 1 ? 'offered' : job.sponsorsH1b === 0 ? 'not_offered' : null;
  const authorization = qualifications?.authorization ?? (is(AUTHORIZATION_REQUIREMENTS, deterministic.authorization) ? deterministic.authorization : null);
  const citizenshipCountry = qualifications?.citizenshipCountry ?? deterministic.citizenshipCountry ?? null;
  const coverLetterRequired = v2?.coverLetterRequired ?? deterministic.coverLetterRequired;

  const eligibilityAnswer = v2?.candidateEligibility ?? null;
  const rules = deterministic.eligibility;
  const remote = deterministic.remote;
  const eligibility = [
    ...firstRows('country', [[rules.countries, 'rules'], [eligibilityAnswer?.countries ?? [], 'ai'], [remote.countries, 'rules']]),
    ...firstRows('region', [[rules.regions, 'rules'], [eligibilityAnswer?.regions ?? [], 'ai'], [remote.regions, 'rules']]),
    ...firstRows('utc_offset', [[rules.utcOffsets, 'rules'], [eligibilityAnswer?.timeZones ?? [], 'ai']]),
  ];

  // Certifications: the v2 answer's, required and preferred, else the rules'. One per key; required wins.
  const named: JobCertification[] = v2 && (v2.requiredCertifications.length > 0 || v2.preferredCertifications.length > 0)
    ? [
        ...v2.requiredCertifications.map((name) => ({ name, key: certKey(name), required: true })),
        ...v2.preferredCertifications.map((name) => ({ name, key: certKey(name), required: false })),
      ]
    : deterministic.certifications.map(({ name, key, required }) => ({ name, key, required }));
  const byKey = new Map<string, JobCertification>();
  for (const entry of named) {
    const key = entry.key.slice(0, 80);
    const name = entry.name.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!key || !name) continue;
    const known = byKey.get(key);
    if (!known || (!known.required && entry.required)) byKey.set(key, { key, name, required: entry.required });
  }
  const certifications = [...byKey.values()];

  const details = JobFactsDetailsSchema.parse({
    officeLocations: v2?.officeLocations ?? [],
    skills: qualifications?.skills ?? [],
    eligibilityQuote: eligibilityAnswer?.quote ?? rules.quote ?? null,
    preferredCertifications: certifications.filter((entry) => !entry.required).map((entry) => entry.name).slice(0, 10),
    degreeOrEquivalent: Boolean(qualifications?.orEquivalent) || deterministic.degreeOrEquivalent,
    citizenshipCountry: citizenshipCountry && COUNTRY.test(citizenshipCountry) ? citizenshipCountry : null,
  });

  return {
    workArrangement,
    employmentType,
    industry,
    degreeLevel: is(DEGREE_LEVELS_V2, degreeLevel) ? degreeLevel : null,
    minYears,
    experienceLevels,
    clearanceRequired,
    sponsorship,
    authorization,
    salaryMinUsd: wholeUsd(job.salaryAnnualUsdMin),
    salaryMaxUsd: wholeUsd(job.salaryAnnualUsdMax),
    coverLetterRequired,
    autoApply: autoApplySupportOf(job.applyUrl),
    questionsKnown: Math.max(0, Math.floor(questionsKnown)),
    eligibility,
    certifications,
    details,
  };
}

/** The filters' view of built facts (what job_facts and its child tables read back as). */
export function jobFactsViewOf(jobId: number, facts: BuiltJobFacts): JobFactsView {
  const values = (kind: EligibilityKind) => facts.eligibility.filter((row) => row.kind === kind).map((row) => row.value).sort();
  return {
    jobId,
    workArrangement: facts.workArrangement,
    employmentType: facts.employmentType,
    industry: facts.industry,
    degreeLevel: facts.degreeLevel,
    degreeOrEquivalent: facts.details.degreeOrEquivalent,
    minYears: facts.minYears,
    experienceLevels: facts.experienceLevels,
    clearanceRequired: facts.clearanceRequired,
    sponsorship: facts.sponsorship,
    authorization: facts.authorization,
    citizenshipCountry: facts.details.citizenshipCountry,
    salaryMinUsd: facts.salaryMinUsd,
    salaryMaxUsd: facts.salaryMaxUsd,
    coverLetterRequired: facts.coverLetterRequired,
    autoApply: facts.autoApply,
    questionsKnown: facts.questionsKnown,
    eligibility: { countries: values('country'), regions: values('region'), utcOffsets: values('utc_offset') },
    certifications: facts.certifications,
  };
}
