import {
  EXPERIENCE_LEVELS,
  EXPERIENCE_LEVEL_SHORT,
  formatLocation,
  formatLocationLine,
  formatSalaryRange,
  relativeTime,
  standardOffsetOf,
  type DateInput,
  type ExperienceLevel,
  type JobAnalysisView,
  type JobLocation,
  type JobSort,
  type JobSummary,
  type SaveAllPreview,
  type SaveAllResponse,
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
 * "Recently updated".
 */
export function cardAge(job: Pick<JobSummary, 'postedAt' | 'updatedAt'>, sort: JobSort, now: DateInput): string {
  if (sort === 'updated') {
    const when = relativeTime(job.updatedAt ?? job.postedAt, now);
    return when ? `Updated ${when}` : '';
  }
  return relativeTime(job.postedAt, now);
}

/** The card's last line: salary and age joined with " · ". */
export function cardMetaLine(job: Pick<JobSummary, 'salary' | 'postedAt' | 'updatedAt'>, sort: JobSort, now: DateInput): string {
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

// ------------------------------------------------------------------------------------------------- Save all

/**
 * The Save all button's tooltip, for one click's batch (v2.0: the public constant SAVE_BATCH_MAX, which the button reads
 * with usePublicConstants). v2.0 fix (SEC-5): no default read from the whole constants table here, which would put
 * every constant (budgets and prices included) in the browser's bundle.
 */
export function saveAllHint(limit: number): string {
  return `Save the jobs that match your filters, up to ${limit.toLocaleString('en-US')} at a time`;
}
/** Toast titles of Save all's failures; the server's sentence follows. */
export const SAVE_ALL_FAILED = 'The jobs could not be saved';
export const UNDO_SAVE_ALL_FAILED = 'The jobs could not be removed from saved jobs';

/** A toast's two lines. */
export interface ToastCopy {
  title: string;
  description: string;
}

const number = (count: number) => count.toLocaleString('en-US');
/** "1 job", "1,250 jobs". */
const jobCount = (count: number) => `${number(count)} ${count === 1 ? 'job' : 'jobs'}`;

/**
 * Save all found nothing to save: the matches are all in the Job Tracker already, or nothing matches any more. v30
 * WEB-JOBS: `cap` is JOB_SEARCH_COUNT_CAP ("All 10,000+ jobs").
 */
export function nothingToSaveCopy(matched: number, cap?: number): ToastCopy {
  let description = `All ${matchCount(matched, cap)} jobs are already in your Job Tracker.`;
  if (matched === 0) description = 'No jobs match these filters any more.';
  else if (matched === 1) description = 'This job is already in your Job Tracker.';
  return { title: 'Nothing new to save', description };
}

export interface SaveAllConfirmCopy {
  title: string;
  description: string;
  /** The matches left as they are (in the Job Tracker already), or null when there are none. */
  note: string | null;
  confirmLabel: string;
  busyLabel: string;
}

/**
 * The "Save N jobs?" confirm, for the preview's numbers. v30 WEB-JOBS: with `cap` (JOB_SEARCH_COUNT_CAP) a count past it
 * reads "10,000+", and the matches already tracked are "some" when the match count is past it (then it is a floor).
 */
export function saveAllConfirmCopy(preview: SaveAllPreview, cap?: number): SaveAllConfirmCopy {
  const count = preview.willSave;
  const tracked = Math.max(0, preview.matched - preview.saveable);
  let description = count === 1 ? 'It goes to your Job Tracker under Saved.' : 'They go to your Job Tracker under Saved.';
  // v2.0: one click saves willSave = min(saveable, SAVE_BATCH_MAX), so fewer than saveable means the batch is full.
  if (preview.saveable > count) {
    description =
      `You can save up to ${number(count)} jobs at a time. These are the first ${number(count)} of ` +
      `${matchCount(preview.saveable, cap)} jobs you haven't saved, in the order the list shows them.`;
  }
  let note: string | null = null;
  if (tracked > 0 && isCapped(preview.matched, cap)) note = 'Some matching jobs are already in your Job Tracker and keep their status.';
  else if (tracked === 1) note = '1 matching job is already in your Job Tracker and keeps its status.';
  else if (tracked > 1) note = `${number(tracked)} matching jobs are already in your Job Tracker and keep their status.`;
  return { title: `Save ${jobCount(count)}?`, description, note, confirmLabel: `Save ${jobCount(count)}`, busyLabel: 'Saving...' };
}

/**
 * The toast after Save all. Saved none (the jobs were saved meanwhile): "Nothing new to save". v30 WEB-JOBS: the
 * server counts the saveable matches up to `cap` (JOB_SEARCH_COUNT_CAP), so when what was saved and what is left reach
 * it, the number left is a floor and the toast names none.
 */
export function saveAllResultCopy(result: Pick<SaveAllResponse, 'items' | 'remaining' | 'incomplete'>, cap?: number): ToastCopy {
  const saved = result.items.length;
  if (saved === 0) return { title: 'Nothing new to save', description: 'These jobs are already in your Job Tracker.' };
  let description = saved === 1 ? 'Find it in your Job Tracker under Saved.' : 'Find them in your Job Tracker under Saved.';
  if (result.incomplete) description += ' Some jobs could not be saved. Click Save all to try the rest.';
  else if (result.remaining > 0 && cap !== undefined && result.remaining + saved >= cap) description += ' More can be saved with Save all.';
  else if (result.remaining > 0) description += ` ${number(result.remaining)} more can be saved with Save all.`;
  return { title: `Saved ${jobCount(saved)}`, description };
}

/** The toast after Save all's Undo, for how many applications it archived. */
export function saveAllUndoneCopy(removed: number): ToastCopy {
  if (removed === 0) {
    return { title: 'Nothing was removed from saved jobs', description: 'These jobs have moved past Saved in your Job Tracker.' };
  }
  return {
    title: `Removed ${jobCount(removed)} from saved jobs`,
    description: removed === 1 ? 'It is archived in your Job Tracker.' : 'They are archived in your Job Tracker.',
  };
}
