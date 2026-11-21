import {
  certKey,
  DEGREE_LEVELS_V2,
  degreeBelowJob,
  JOB_GLANCE_CERTIFICATIONS_MAX,
  yearsBelowJob,
  yearsOf,
  type DegreeLevelV2,
  type ExperienceLevel,
  type GlanceVerdict,
  type JobFactsView,
  type JobGlance,
} from '@tailorit/shared';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { readAutofillProfile } from '../autofill/profile/repository';
import { ensureJobFacts, readJobFacts } from '../job-facts/service';
import { highestDegreeOf, yearsOfExperience } from '../prepare-filters/person';
import { storedResumeAnalysis } from '../resumes/analysis/store';

// v33 JOBDETAIL (F2): the job page's "Requirements at a glance". The job's side comes from its facts (job_facts: the
// degree level, "or equivalent", the minimum years, the required certifications), the facts Prepare's qualification
// filter reads; each row's verdict uses that filter's own rules (degreeBelowJob, yearsBelowJob with
// QUALIFICATION_YEARS_GRACE), so the page and Prepare never disagree. The answer carries `meets`, `below` or `unknown`
// per row and the job's own values; the person's degree, years and certifications stay on the server.
//
// The person's side (personQualifications) is narrower than the filters' personFacts: the Autofill profile's education,
// experience and certifications only, never the sensitive answers; where the profile says nothing, the reading of the
// resume the page scored (its years and its certifications; a reading holds no degree).
// v33 FIX-2 (final review, security 2): on a profile shared without Autofill info's See, the Autofill profile is left
// out (`withProfile: false`): the verdicts come from the scored resume's reading alone, which the match already reads
// under Job Tracker's See, so B never learns the owner's degree, years or licences from the profile, job after job.

/**
 * What the glance compares the job with. Server only: never sent to a browser or an AI, never logged. Null is unknown;
 * an empty `certKeys` is unknown too (never "has none").
 */
export interface PersonQualifications {
  highestDegree: DegreeLevelV2 | null;
  /** Whole years, overlaps merged, an ongoing role counted to today. */
  yearsExperience: number | null;
  certKeys: string[];
}

/** The certKeys of a list of names, once each, blanks left out. */
function certKeysOf(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => certKey(name)).filter(Boolean))];
}

/** Whose facts the glance may read: the Autofill profile's too, or the scored resume's reading alone (v33 FIX-2). */
export interface GlanceSources {
  /** False on a profile shared without Autofill info's See. Default true. */
  withProfile?: boolean;
}

/**
 * The person's qualifications (see above). `scoredResumeId` is the resume the page's match scored (the job's linked
 * resume, else the default one): its stored reading fills the years and the certifications the profile leaves out (all
 * of them without the profile: `withProfile: false`).
 */
export async function personQualifications(
  deps: AppDeps,
  userId: string,
  scoredResumeId: string | null,
  { withProfile = true }: GlanceSources = {},
): Promise<PersonQualifications> {
  const profile = withProfile ? (await readAutofillProfile(deps, userId)).value : null;
  let yearsExperience = profile ? yearsOfExperience(profile.experience, deps.now()) : null;
  let certKeys = profile ? certKeysOf(profile.certifications.map((entry) => entry.name)) : [];
  if ((yearsExperience === null || certKeys.length === 0) && scoredResumeId) {
    const reading = await storedResumeAnalysis(deps, userId, scoredResumeId, { compute: false });
    if (reading) {
      if (yearsExperience === null) {
        const years = yearsOf(reading.data, deps.now()).years;
        yearsExperience = years === null ? null : Math.floor(years);
      }
      if (certKeys.length === 0) certKeys = certKeysOf(reading.data.keywords.certifications);
    }
  }
  return { highestDegree: profile ? highestDegreeOf(profile.education) : null, yearsExperience, certKeys };
}

/** The years row: the posting's minimum against the person's years, with the grace years. */
export function yearsVerdict(minYears: number | null, yearsExperience: number | null, grace: number): GlanceVerdict {
  if (minYears === null || yearsExperience === null) return 'unknown';
  return yearsBelowJob(minYears, yearsExperience, grace) ? 'below' : 'meets';
}

/**
 * The education row: no degree asked for meets; a degree above the person's is below unless the posting takes
 * equivalent experience (then unknown: Prepare lets it pass, and the page cannot tell); the person's degree at or above
 * it meets.
 */
export function educationVerdict(
  job: Pick<JobFactsView, 'degreeLevel' | 'degreeOrEquivalent'>,
  highestDegree: DegreeLevelV2 | null,
): GlanceVerdict {
  if (!job.degreeLevel) return 'unknown';
  if (job.degreeLevel === 'none') return 'meets';
  if (!highestDegree) return 'unknown';
  if (degreeBelowJob(job, highestDegree)) return 'below';
  return DEGREE_LEVELS_V2.indexOf(highestDegree) >= DEGREE_LEVELS_V2.indexOf(job.degreeLevel) ? 'meets' : 'unknown';
}

export interface GlanceInput {
  /** The job's facts; undefined when it has no facts row yet (every row is unknown then). */
  facts: JobFactsView | undefined;
  /** The job's levels (jobLevels: its own, else its analysis's), in level order. */
  levels: readonly ExperienceLevel[];
  /** The analysis's required years, shown while the job has no facts row (its verdict stays unknown). */
  requiredYears?: number | null;
  person: PersonQualifications;
  /** QUALIFICATION_YEARS_GRACE. */
  yearsGrace: number;
}

/** A minimum of years worth showing: a whole number from 1 (0 asks for nothing); null otherwise. */
function shownYears(years: number | null | undefined): number | null {
  return typeof years === 'number' && Number.isFinite(years) && years >= 1 ? Math.min(40, Math.floor(years)) : null;
}

/** The glance of one job for one person (pure). */
export function glanceOf(input: GlanceInput): JobGlance {
  const { facts, person } = input;
  const minYears = shownYears(facts ? facts.minYears : input.requiredYears);
  const required = (facts?.certifications ?? []).filter((entry) => entry.required).slice(0, JOB_GLANCE_CERTIFICATIONS_MAX);
  return {
    experience: {
      levels: [...input.levels],
      minYears,
      verdict: facts ? yearsVerdict(minYears, person.yearsExperience, Math.max(0, input.yearsGrace)) : 'unknown',
    },
    education: {
      degreeLevel: facts?.degreeLevel ?? null,
      orEquivalent: facts?.degreeOrEquivalent ?? false,
      verdict: facts ? educationVerdict(facts, person.highestDegree) : 'unknown',
    },
    certifications: required.map((entry) => ({
      name: entry.name,
      verdict: person.certKeys.includes(entry.key) ? ('meets' as const) : ('unknown' as const),
    })),
  };
}

/**
 * GET /api/jobs/:id/insights' glance: the job's facts brought up to date first (as Prepare does before it filters),
 * then compared with the person's qualifications (`sources`: v33 FIX-2, without the profile on a share that lacks
 * Autofill info's See).
 */
export async function jobGlance(
  deps: AppDeps,
  userId: string,
  job: { id: number; levels: readonly ExperienceLevel[]; requiredYears?: number | null },
  scoredResumeId: string | null,
  sources: GlanceSources = {},
): Promise<JobGlance> {
  try {
    await ensureJobFacts(deps, [job.id]);
  } catch (error) {
    // Facts a step behind still say more than none.
    deps.log.warn(`[jobs] the facts of job ${job.id} could not be brought up to date`, error);
  }
  const facts = (await readJobFacts(deps, [job.id])).get(job.id);
  return glanceOf({
    facts,
    levels: job.levels,
    requiredYears: job.requiredYears,
    person: await personQualifications(deps, userId, scoredResumeId, sources),
    yearsGrace: constantsOf(deps).get('QUALIFICATION_YEARS_GRACE'),
  });
}
