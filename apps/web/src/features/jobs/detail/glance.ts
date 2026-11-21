import {
  DAY_MS,
  daysBetween,
  relativeTime,
  toDate,
  type DateInput,
  type DegreeLevelV2,
  type ExperienceLevel,
  type GlanceVerdict,
  type JobGlance,
  type LevelMatch,
} from '@tailorit/shared';
import { levelsLabel } from '../format';
import { requiredExperienceText } from './facets';

/*
 * v33 JOBDETAIL (F2): the words of the job's header line and of "Requirements at a glance". Pure: the components lay
 * these out. The verdicts come from the API (GET /api/jobs/:id/insights' `glance`); the page never sees the person's
 * degree, years or certifications.
 */

/** A row's mark: the API's verdict, or `level_other` when only the level check (the person's preferences) speaks. */
export type GlanceMark = GlanceVerdict | 'level_other';

/** The education row's value: the lowest degree the posting asks for ("Bachelor's or higher"). */
export const DEGREE_LABEL: Record<DegreeLevelV2, string> = {
  none: 'No degree required',
  high_school: 'High school or higher',
  associate: "Associate's or higher",
  bachelor: "Bachelor's or higher",
  master: "Master's or higher",
  doctorate: 'Doctorate',
};

/** The experience row's value: "Senior · 5+ years", "Mid, Senior", "5+ years"; '' when the posting says neither. */
export function experienceText(levels: readonly ExperienceLevel[], minYears: number | null | undefined): string {
  return [levelsLabel(levels), requiredExperienceText(minYears)].filter(Boolean).join(' · ');
}

/**
 * The experience row's mark, where it comes from and its level lines. The years decide when both sides know them (the
 * API's verdict, as Prepare's qualification filter reads them). Otherwise the level check speaks (the v3.1 "Your level
 * fits", against the levels the person is looking for): a fit is `meets`, another level `level_other`; with neither,
 * `unknown`.
 */
export function experienceMark(
  verdict: GlanceVerdict,
  levelMatch: LevelMatch | undefined,
): { mark: GlanceMark; source: 'years' | 'level' | null; lines: readonly string[] } {
  const lines = levelMatch && levelMatch.state !== 'none' ? levelMatch.lines : [];
  if (verdict !== 'unknown') return { mark: verdict, source: 'years', lines };
  if (levelMatch?.state === 'match') return { mark: 'meets', source: 'level', lines };
  if (levelMatch?.state === 'mismatch') return { mark: 'level_other', source: 'level', lines };
  return { mark: 'unknown', source: null, lines: [] };
}

/** The education row's value, "Bachelor's or higher"; '' when the posting does not say. */
export function educationText(education: Pick<JobGlance['education'], 'degreeLevel'>): string {
  return education.degreeLevel ? DEGREE_LABEL[education.degreeLevel] : '';
}

/**
 * When TailorIT last confirmed the posting is live, for "Checked live {when}": "today" (this calendar day), "in the
 * last 24 hours" (yesterday, less than a day ago), "N days ago"; null when unknown or unreadable.
 */
export function checkedLiveWhen(lastVerifiedAt: string | null | undefined, now: DateInput): string | null {
  const checked = toDate(lastVerifiedAt ?? null);
  const reference = toDate(now);
  const days = checked && reference ? daysBetween(checked, reference) : null;
  if (!checked || !reference || days === null) return null;
  if (days <= 0) return 'today';
  const elapsed = reference.getTime() - checked.getTime();
  if (elapsed < DAY_MS) return 'in the last 24 hours';
  const whole = Math.floor(elapsed / DAY_MS);
  return `${whole} ${whole === 1 ? 'day' : 'days'} ago`;
}

/** "Posted 3 days ago"; null without a date. */
export function postedText(postedAt: string | null | undefined, now: DateInput): string | null {
  const when = relativeTime(postedAt ?? null, now);
  return when ? `Posted ${when}` : null;
}
