import {
  EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_SHORT,
  formatLocation,
  formatLocationLine,
  formatSalaryRange,
  relativeTime,
  repostedAgo, // v36 IMPORTTIME
  standardOffsetOf,
  type DateInput,
  type ExperienceLevel,
  type JobAnalysisView,
  type JobLocation,
  type JobSort,
  type JobSummary,
} from '@tailorit/shared';
import { industryWords, sizeWords } from '@/features/companies/format';

/* Wording of the Jobs page that is more than one shared formatter. Pure: `now` is always passed in. */

// v30 WEB-JOBS (11-database.md §7.5, owner question 3): the search counts its matches up to JOB_SEARCH_COUNT_CAP (a
// public constant) and answers the cap plus one past it, so a count above `cap` reads "10,000+". Without a cap (a
// caller that has none) the number is shown as it is.

/** A count of matches: "1,234", or "10,000+" when it is past `cap`. */
export function matchCount(count: number, cap?: number): string {
  return cap !== undefined && count > cap ? `${cap.toLocaleString('en-US')}+` : count.toLocaleString('en-US');
}

/** Whether a count is past the search's cap (so it is "more than the cap", not exact). */
export function isCapped(count: number, cap?: number): boolean {
  return cap !== undefined && count > cap;
}

/** "Found 17,480 jobs", "Found 1 job", and past the cap "Found 10,000+ jobs". */
export function foundJobsLabel(total: number, cap?: number): string {
  return `Found ${matchCount(total, cap)} ${total === 1 ? 'job' : 'jobs'}`;
}

/** All filters' button: "Show 1,234 jobs", "Show 10,000+ jobs", "Show jobs" before the count is in. */
export function showJobsLabel(total: number | undefined, cap?: number): string {
  if (total === undefined) return 'Show jobs';
  return `Show ${matchCount(total, cap)} ${total === 1 ? 'job' : 'jobs'}`;
}

/**
 * v30 WEB-JOBS (11 §7.3, owner question 3): "Most relevant" ranks the newest SEARCH_RELEVANCE_WINDOW matches (a public
 * constant) by how well they match the words; the sort menu says so while the search has words.
 */
export function relevanceHint(window: number): string {
  return `Best matches among the newest ${window.toLocaleString('en-US')}`;
}

/**
 * v30 WEB-JOBS: the card's line under the company's name, its industry and size when known (13 §2; the words of
 * features/companies/format.ts): "Energy & Utilities · 1,001-5,000 employees"; '' when neither is known.
 */
export function cardCompanyFacts(company: JobSummary['company']): string {
  return [industryWords(company.industry), sizeWords(company.sizeBucket)].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------------------------------- Jobs I can apply to

/** v30 WEB-JOBS (owner question 4): the switch's words. */
export const CAN_APPLY_COPY = {
  label: 'Jobs I can apply to',
  // v32 JOBS2 (E5): the switch's "?" and the line under it, one short sentence each.
  hint: 'Hides jobs whose rules on where you live or work leave you out.',
  chip: 'Jobs I can apply to',
  missing: {
    both: 'Add where you live and your time zone first.',
    place: 'Add where you live to check place rules.',
    zone: 'Add your time zone to check time zone rules.',
  },
  settingsLink: 'Open Settings',
} as const;

/**
 * What the switch cannot check yet: the person's country ('place'), time zone ('zone'), both, or nothing (null). A time
 * zone the browser cannot read is unknown, as the API reads it (standardOffsetOf).
 */
export function applicantGap(location: { homeCountry: string | null; timeZone: string | null }): keyof typeof CAN_APPLY_COPY.missing | null {
  const place = typeof location.homeCountry === 'string' && /^[A-Z]{2}$/.test(location.homeCountry);
  const zone = standardOffsetOf(location.timeZone) !== null;
  if (!place && !zone) return 'both';
  if (!place) return 'place';
  return zone ? null : 'zone';
}

/** The card's place line: "Fremont, CA, USA · In Person", "San Francisco, CA, USA + 2 more · Hybrid". */
export function cardLocationLine(job: Pick<JobSummary, 'primaryLocation' | 'locationCount' | 'workArrangement'>): string {
  return formatLocationLine(job.primaryLocation, job.locationCount, job.workArrangement);
}

/** The card's salary, '' when the posting names none ("£325k - £390k/yr"). */
export function cardSalary(job: Pick<JobSummary, 'salary'>): string {
  const salary = job.salary;
  return salary ? formatSalaryRange(salary.min, salary.max, salary.currency, salary.period) : '';
}

/**
 * The card's age: "5 months ago" (when it was posted), or "Updated 3 days ago" while the list is sorted by
 * "Recently updated". v36 IMPORTTIME (SP v36 PLAN.md I1): a job an admin's import dated after it was posted reads
 * "Reposted 1 hour ago" (v3.5's words, as the Jobs page's row: list/age.ts), so a company's job list never shows the
 * board's older date for it.
 */
export function cardAge(job: Pick<JobSummary, 'postedAt' | 'updatedAt' | 'repostedAt'> & PostedDateKnown, sort: JobSort, now: DateInput): string {
  if (sort === 'updated') {
    const when = relativeTime(job.updatedAt ?? job.postedAt, now);
    return when ? `Updated ${when}` : '';
  }
  const reposted = repostedAgo(job, now); // v36 IMPORTTIME
  if (reposted) return reposted;
  // v38 FIX-APP (SP v38 FIXES-38 D7; REVIEW38-ux L6): a posting that names no date reads when TailorIT first saw it.
  const when = relativeTime(job.postedAt, now);
  return when && !postedDateKnown(job) ? `First seen ${when}` : when;
}

/**
 * v38 FIX-APP (SP v38 FIXES-38 D7): whether the job's posted date is the posting's own (FIX-C's job DTO field
 * `postedDateKnown`: false when no read of the posting named a date, so the stored date is when TailorIT first saw it).
 * v38 INT-2: FIX-C's field is in JobSummary (the API always sends it); the stand-in for it before the merge is gone. An
 * answer without it (an API older than v3.8) reads as known, the DTO's own rule.
 */
export type PostedDateKnown = Pick<JobSummary, 'postedDateKnown'>;
export const postedDateKnown = (job: PostedDateKnown): boolean => job.postedDateKnown !== false;

/**
 * v38 FIX-APP (REVIEW38-ux L1): the header's places, "Remote" said once: with a remote work mode (its own pill says
 * Remote), a place that is only "Remote" is left out ("Remote in USA", a country, stays).
 */
export function headerPlacesOf(
  primary: string,
  locations: readonly JobLocation[],
  arrangement: JobSummary['workArrangement'] | null | undefined,
): { first: string; others: string[] } {
  const { first, others } = placesOf(primary, locations);
  if (arrangement !== 'remote') return { first, others };
  const kept = [first, ...others].filter((place) => place && !/^remote$/i.test(place.trim()));
  return { first: kept[0] ?? '', others: kept.slice(1) };
}

/** The card's last line: salary and age joined with " · ". */
export function cardMetaLine(job: Pick<JobSummary, 'salary' | 'postedAt' | 'updatedAt' | 'repostedAt'> & PostedDateKnown, sort: JobSort, now: DateInput): string {
  return [cardSalary(job), cardAge(job, sort, now)].filter(Boolean).join(' · ');
}

/** The facts grid's level: "Senior", "Mid, Senior" (the short labels, in level order). */
export function levelsLabel(levels: readonly ExperienceLevel[]): string {
  const set = new Set(levels);
  return EXPERIENCE_LEVELS.filter((level) => set.has(level))
    .map((level) => EXPERIENCE_LEVEL_SHORT[level])
    .join(', ');
}

/** The facts grid's place and the others behind "+N more". */
export function placesOf(primary: string, locations: readonly JobLocation[]): { first: string; others: string[] } {
  const formatted = locations.map(formatLocation).filter(Boolean);
  const first = primary || formatted[0] || '';
  const others = formatted.filter((place, index) => place !== first && formatted.indexOf(place) === index);
  return { first, others };
}

/** "Show 8 more" / "Show less". */
export function showMoreLabel(hidden: number, expanded: boolean): string {
  return expanded ? 'Show less' : `Show ${hidden} more`;
}

/** The levels a job asks for: its own, else what its analysis read from the posting. */
export function jobLevelsOf(own: readonly ExperienceLevel[], analysis: Pick<JobAnalysisView, 'experienceLevels'> | undefined): ExperienceLevel[] {
  if (own.length > 0) return [...own];
  return [...(analysis?.experienceLevels ?? [])];
}
