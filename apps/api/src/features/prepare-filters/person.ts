import { certKey, standardOffsetOf, type DegreeLevelV2, type PersonFacts } from '@tailorit/shared';
import type { DegreeLevel } from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import { readAutofillProfile, readSensitiveAnswers } from '../autofill/profile/repository';
import { getPreferences } from '../me/preferences';

// v2.0 P4 (06-filters-analysis.md, "The person's facts"): the person's side of the filters. Read on the server only:
// never sent to an AI, never logged, never answered by a route (the routes say only whether the location and time zone
// are known). Every value the person has not given is null (unknown), and the filter part that reads it passes.
//
// The sensitive answers (citizenships, clearance) are read for this check alone, as the filters need them (06's table).
// A route never returns them.

/** The profile's degree levels as the filters' levels; `other` says nothing. */
const DEGREE_OF: Record<DegreeLevel, DegreeLevelV2 | null> = {
  highSchool: 'high_school',
  associate: 'associate',
  bachelor: 'bachelor',
  master: 'master',
  doctorate: 'doctorate',
  professional: 'doctorate',
  other: null,
};

/** "2021" or "2021-09" as a month count (January for a year alone); null when malformed. */
function monthOf(text: string | null | undefined): number | null {
  const match = typeof text === 'string' ? /^(\d{4})(?:-(\d{2}))?$/.exec(text) : null;
  if (!match) return null;
  const month = match[2] === undefined ? 1 : Number(match[2]);
  return Number(match[1]) * 12 + (month - 1);
}

/**
 * Whole years of experience from date ranges: overlaps merged, an ongoing role counted to `now`. A range with no start,
 * or with neither an end nor "current", is left out; null when none is left.
 */
export function yearsOfExperience(
  entries: ReadonlyArray<{ startDate: string | null; endDate: string | null; current: boolean }>,
  now: Date,
): number | null {
  const today = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const ranges: Array<[number, number]> = [];
  for (const entry of entries) {
    const start = monthOf(entry.startDate);
    const end = entry.current ? today : monthOf(entry.endDate);
    if (start === null || end === null || end < start) continue;
    // An end month counts as worked through (2020-01 to 2020-12 is twelve months).
    ranges.push([start, Math.min(end, today) + 1]);
  }
  if (ranges.length === 0) return null;
  ranges.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [from, to] = ranges[0]!;
  for (const [start, end] of ranges.slice(1)) {
    if (start <= to) to = Math.max(to, end);
    else {
      months += to - from;
      [from, to] = [start, end];
    }
  }
  months += to - from;
  return Math.max(0, Math.floor(months / 12));
}

const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z0-9]{1,6}$/;

/**
 * The person's location and time zone (user_preferences, 0824, A22), as the filters and the routes read them: through
 * the preferences' own reader (features/me getPreferences), so a bad stored value reads as unknown; a time zone Intl
 * does not know is unknown too.
 */
export async function personLocation(deps: Pick<AppDeps, 'db'>, userId: string): Promise<{
  country: string | null;
  region: string | null;
  timeZoneOffset: string | null;
}> {
  const preferences = await getPreferences(deps, userId);
  const country = typeof preferences.homeCountry === 'string' && COUNTRY.test(preferences.homeCountry) ? preferences.homeCountry : null;
  const region = country && typeof preferences.homeRegion === 'string' && REGION.test(preferences.homeRegion) ? preferences.homeRegion : null;
  return { country, region, timeZoneOffset: standardOffsetOf(preferences.timeZone ?? null) };
}

/**
 * v2.0 (INT): what the filters read from the autofill profile (the highest degree, the certifications, the citizenships,
 * the clearance, the years of experience) as one comparable string. A profile save that changes it bumps the filters
 * revision (features/autofill/profile/router.ts), so every stored verdict is computed again.
 */
export async function profileFilterKey(deps: Pick<AppDeps, 'db' | 'now'>, userId: string): Promise<string> {
  const facts = await personFacts(deps, userId);
  const sorted = (values: readonly string[] | null) => (values === null ? null : [...values].sort());
  return JSON.stringify([
    facts.highestDegree,
    facts.yearsExperience,
    sorted(facts.certKeys),
    sorted(facts.citizenships),
    facts.clearance,
    // v20 FIX-A (A22): the location read from the profile address while the preferences hold none.
    facts.country,
    facts.region,
  ]);
}

/** The person's facts for the filters (06's table). Server only. */
export async function personFacts(deps: Pick<AppDeps, 'db' | 'now'>, userId: string): Promise<PersonFacts> {
  const location = await personLocation(deps, userId);
  const profile = (await readAutofillProfile(deps, userId)).value;
  const sensitive = (await readSensitiveAnswers(deps, userId)).value;

  const levels = profile.education
    .map((entry) => DEGREE_OF[entry.degree.level])
    .filter((level): level is DegreeLevelV2 => level !== null);
  const order: readonly DegreeLevelV2[] = ['none', 'high_school', 'associate', 'bachelor', 'master', 'doctorate'];
  const highestDegree = levels.length > 0 ? levels.reduce((best, level) => (order.indexOf(level) > order.indexOf(best) ? level : best)) : null;

  const citizenships = sensitive.legal.citizenships.state === 'value' ? [...sensitive.legal.citizenships.value] : null;
  const clearance = sensitive.legal.clearance.state === 'value' ? sensitive.legal.clearance.value.level : null;

  return {
    country: location.country,
    region: location.region,
    timeZoneOffset: location.timeZoneOffset,
    highestDegree,
    yearsExperience: yearsOfExperience(profile.experience, deps.now()),
    certKeys: [...new Set(profile.certifications.map((entry) => certKey(entry.name)).filter(Boolean))],
    citizenships,
    clearance,
  };
}
