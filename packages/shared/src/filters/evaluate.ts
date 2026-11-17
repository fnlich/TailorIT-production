import type { MessageKey } from '../constants/constants';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';
import { EXPERIENCE_LEVEL_SHORT, type ExperienceLevel } from '../jobs/enums';
import { DEGREE_LEVELS_V2, type DegreeLevelV2, type EmploymentTypeV2 } from '../jobs/facts';
import { industryLabel, NOT_SPECIFIED_INDUSTRY } from '../jobs/taxonomy';
import type { MergedFilters } from './merge';
import {
  FILTER_REASON_LABELS,
  type CustomFilterState,
  type FilterReason,
  type FilterReasonEntry,
  type FilterVerdict,
  type JobFactsView,
  type PersonFacts,
  type PrepareFilters,
} from './schema';

// v2.0 P4 (06-filters-analysis.md, "The filters"): the 12 prepare filters, deterministic and pure, over a job's facts
// and the person's. Every failing filter is listed, in FILTER_REASONS' order; a Saved job's label shows the first. A
// value either side does not know passes (each part of a filter on its own). The AI decides nothing here: the Custom
// filter's verdict comes in as `custom`, and `pending` is not a fail.

export interface EvaluateOptions {
  /** QUALIFICATION_YEARS_GRACE: years a posting may ask above the person's before the qualification filter fails. */
  yearsGrace?: number;
}

/** QUALIFICATION_YEARS_GRACE's default: v20 FIX-A (REQ-11) read from the constants (their public part), its one source. */
const DEFAULT_YEARS_GRACE = PUBLIC_CONSTANT_SPECS.QUALIFICATION_YEARS_GRACE.default;
/** The longest label value (FilterReasonEntrySchema). */
const VALUE_MAX = 80;

const ARRANGEMENT_WORD = { remote: 'remote', hybrid: 'hybrid', onsite: 'on-site' } as const;
const EMPLOYMENT_WORD: Record<EmploymentTypeV2, string> = {
  full_time: 'full-time',
  part_time: 'part-time',
  contract: 'contract',
  internship: 'internship',
  unpaid: 'unpaid',
  temporary: 'temporary',
};
const DEGREE_WORD: Record<DegreeLevelV2, string> = {
  none: 'No degree',
  high_school: 'High school',
  associate: "Associate's",
  bachelor: "Bachelor's",
  master: "Master's",
  doctorate: 'Doctorate',
};
/** Offsets as people name them, for a time-zone rule's label ("PT only"). */
const ZONE_NAMES: Readonly<Record<string, string>> = {
  '-1000': 'HT',
  '-0900': 'AKT',
  '-0800': 'PT',
  '-0700': 'MT',
  '-0600': 'CT',
  '-0500': 'ET',
  '-0400': 'AT',
  '-0330': 'NT',
  '+0000': 'UTC',
  '+0100': 'CET',
  '+0200': 'EET',
  '+0530': 'IST',
  '+0800': 'SGT',
  '+0900': 'JST',
  '+1000': 'AET',
};

function zoneName(offset: string): string {
  const named = ZONE_NAMES[offset];
  if (named) return named;
  const match = /^([+-])(\d{2})(\d{2})$/.exec(offset);
  if (!match) return offset;
  const hours = String(Number(match[2]));
  return `UTC${match[1]}${hours}${match[3] === '00' ? '' : `:${match[3]}`}`;
}

const cap = (text: string) => (text.length <= VALUE_MAX ? text : `${text.slice(0, VALUE_MAX - 1).trimEnd()}…`);

/** "TX, CA only", "US only", "PT only", "PT to ET only"; "not in CO" when more regions are allowed than a label holds. */
function placesLabel(values: readonly string[], kind: 'country' | 'region' | 'utc_offset', personRegion: string | null): string {
  if (kind === 'utc_offset') {
    const names = values.map(zoneName);
    return cap(names.length <= 3 ? `${names.join(', ')} only` : `${names[0]} to ${names[names.length - 1]} only`);
  }
  const words = values.map((value) => (kind === 'region' ? value.slice(3) : value));
  if (words.length <= 4) return cap(`${words.join(', ')} only`);
  if (kind === 'region' && personRegion) return cap(`not in ${personRegion}`);
  return cap(`${words.slice(0, 3).join(', ')} and ${words.length - 3} more only`);
}

/** "$90k", "$1.2M": a yearly salary in USD as the label writes it. */
export function salaryWord(usd: number): string {
  if (usd >= 1_000_000) return `$${(Math.round(usd / 100_000) / 10).toString()}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}k`;
  return `$${Math.round(usd)}`;
}

/** 06's location mismatch, exactly as its pseudo-code. Null when it passes; else the label's value. */
function locationMismatch(job: JobFactsView, person: PersonFacts): string | null {
  const { countries, regions, utcOffsets } = job.eligibility;
  const allCountries = [...new Set([...countries, ...regions.map((region) => region.slice(0, 2))])].sort();
  if (allCountries.length > 0 && person.country && !allCountries.includes(person.country)) {
    return placesLabel(allCountries, 'country', null);
  }
  const regionsHere = person.country ? regions.filter((region) => region.startsWith(`${person.country}-`)) : [];
  if (regionsHere.length > 0 && person.region && !regionsHere.includes(`${person.country}-${person.region}`)) {
    return placesLabel(regionsHere, 'region', person.region);
  }
  if (utcOffsets.length > 0 && person.timeZoneOffset && !utcOffsets.includes(person.timeZoneOffset)) {
    return placesLabel([...utcOffsets].sort(byOffset), 'utc_offset', null);
  }
  return null;
}

function byOffset(a: string, b: string): number {
  const minutes = (text: string) => {
    const match = /^([+-])(\d{2})(\d{2})$/.exec(text);
    return match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1) : 0;
  };
  return minutes(a) - minutes(b);
}

/** 06's qualification mismatch: the degree, the years, the citizenship, each part on its own. Null when it passes. */
function qualificationMismatch(job: JobFactsView, person: PersonFacts, grace: number): string | null {
  if (job.degreeLevel && job.degreeLevel !== 'none' && person.highestDegree && !job.degreeOrEquivalent) {
    if (DEGREE_LEVELS_V2.indexOf(job.degreeLevel) > DEGREE_LEVELS_V2.indexOf(person.highestDegree)) return DEGREE_WORD[job.degreeLevel];
  }
  if (job.minYears !== null && person.yearsExperience !== null && person.yearsExperience + grace < job.minYears) {
    return `${job.minYears}+ years`;
  }
  if (job.authorization === 'citizen' && job.citizenshipCountry && person.citizenships && !person.citizenships.includes(job.citizenshipCountry)) {
    return `${job.citizenshipCountry} citizens`;
  }
  return null;
}

function listOn(filters: MergedFilters, key: 'locationTypes' | 'jobTypes' | 'experienceLevels'): boolean {
  return filters[key].length > 0 || Boolean(filters.none?.includes(key));
}

function allows<T>(filters: MergedFilters, key: 'locationTypes' | 'jobTypes' | 'experienceLevels', value: T): boolean {
  if (filters.none?.includes(key)) return false;
  return (filters[key] as readonly unknown[]).includes(value);
}

/**
 * The prepare filters over one job (06's table): `pass`, or `fail` with every failing filter in FILTER_REASONS' order,
 * each with its label's value. `filters` may be the saved filters or a merge with MCP's extra (mergeExtra).
 */
export function evaluateFilters(
  filters: PrepareFilters | MergedFilters,
  job: JobFactsView,
  person: PersonFacts,
  custom: CustomFilterState,
  options: EvaluateOptions = {},
): FilterVerdict {
  const merged = filters as MergedFilters;
  const grace = Math.max(0, options.yearsGrace ?? DEFAULT_YEARS_GRACE);
  const reasons: FilterReasonEntry[] = [];
  const fail = (code: FilterReason, value?: string) => reasons.push(value === undefined ? { code } : { code, value: cap(value) });

  // 1. Auto-apply support: never unknown.
  if (merged.autoApplySupport === 'supported' && job.autoApply === 'none') fail('auto_apply');
  // 2. Location type.
  if (listOn(merged, 'locationTypes') && job.workArrangement !== null && !allows(merged, 'locationTypes', job.workArrangement)) {
    fail('location_type', ARRANGEMENT_WORD[job.workArrangement]);
  }
  // 3. Job type.
  if (listOn(merged, 'jobTypes') && job.employmentType !== null && !allows(merged, 'jobTypes', job.employmentType)) {
    fail('job_type', EMPLOYMENT_WORD[job.employmentType]);
  }
  // 4. Industry: `not_specified` is unknown; an include with no ids is nothing chosen (unless a merge emptied it).
  const industries = merged.industries;
  const emptied = Boolean(merged.none?.includes('industries'));
  if (industries && job.industry && job.industry !== NOT_SPECIFIED_INDUSTRY && (industries.ids.length > 0 || emptied || industries.mode === 'exclude')) {
    const listed = (industries.ids as readonly string[]).includes(job.industry);
    if (industries.mode === 'include' ? !listed : listed) fail('industry', industryLabel(job.industry) || job.industry);
  }
  // 5. Location mismatch.
  if (merged.locationMismatch) {
    const value = locationMismatch(job, person);
    if (value !== null) fail('location_mismatch', value);
  }
  // 6. Qualification mismatch.
  if (merged.qualificationMismatch) {
    const value = qualificationMismatch(job, person, grace);
    if (value !== null) fail('qualification', value);
  }
  // 7. Certification mismatch: the person's list empty is unknown, never "has none".
  if (merged.certificationMismatch && person.certKeys.length > 0) {
    const missing = job.certifications.find((entry) => entry.required && !person.certKeys.includes(entry.key));
    if (missing) fail('certification', missing.name);
  }
  // 8. Salary: the top of the range, else its bottom.
  if (merged.minSalaryUsd !== null && merged.minSalaryUsd !== undefined) {
    const pay = job.salaryMaxUsd ?? job.salaryMinUsd;
    if (pay !== null && pay < merged.minSalaryUsd) fail('salary', salaryWord(merged.minSalaryUsd));
  }
  // 9. Experience level: no overlap with the levels allowed.
  if (listOn(merged, 'experienceLevels') && job.experienceLevels.length > 0) {
    const overlap = job.experienceLevels.some((level) => allows(merged, 'experienceLevels', level));
    if (!overlap) fail('experience', EXPERIENCE_LEVEL_SHORT[job.experienceLevels[0] as ExperienceLevel]);
  }
  // 10. Sponsorship.
  if (merged.noSponsorship && job.sponsorship === 'not_offered') fail('sponsorship');
  // 11. Clearance: required, and the person holds none.
  if (merged.clearanceMismatch && job.clearanceRequired === true && person.clearance === 'none') fail('clearance');
  // 12. Custom: only a stored `fail`; `pending` is judged before a Prepare goes on.
  if (merged.custom.enabled && custom === 'fail') fail('custom');

  return { verdict: reasons.length > 0 ? 'fail' : 'pass', reasons };
}

/**
 * A failing filter's words, "Filtered: on-site": the reason's label (FILTER_REASON_LABELS, with its value) inside
 * MSG_FILTERED. `message` renders a constant's text with its placeholders (the API's constants service, or the web's
 * renderMessage over the public constants).
 */
export function filteredLabel(
  entry: FilterReasonEntry,
  message: (key: MessageKey, params: Record<string, string>) => string,
): string {
  const reason = message(FILTER_REASON_LABELS[entry.code], { value: entry.value ?? '' });
  return message('MSG_FILTERED', { reason });
}
