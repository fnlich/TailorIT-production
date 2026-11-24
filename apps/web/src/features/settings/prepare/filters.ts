import {
  FILTER_REASONS,
  PrepareFiltersSchema,
  type FilterReason,
  type PrepareFilters,
  type PrepareFiltersPreview,
} from '@tailorit/shared/filters';
import type { PrepareFilterKey, PrepareFiltersPatch } from '@tailorit/shared/sharing';
import {
  EMPLOYMENT_TYPES_V2,
  EXPERIENCE_LEVELS,
  INDUSTRY_IDS,
  WORK_ARRANGEMENTS,
  type EmploymentTypeV2,
  type ExperienceLevel,
  type IndustryId,
  type WorkArrangement,
} from '@tailorit/shared/jobs';
import { defaultTooLong, type TooLongText } from '../../../lib/constants';

// v2.0: Settings › Prepare › Prepare filters, as a form (docs/design/v2.0/08-ui.md; 06-filters-analysis.md).
// Pure: the saved filters become the form's state and the form's state becomes PrepareFiltersSchema again, so the
// tests read the mapping without a page. Lists keep the vocabulary's order, so a saved value and the same value
// clicked in another order compare equal (the save bar shows only for a real change).

/** The form's state: the filters, with the salary as typed and the industry choice kept apart. */
export interface FilterForm {
  locationTypes: WorkArrangement[];
  jobTypes: EmploymentTypeV2[];
  /** "Only" these industries, or "Skip" them. Kept while no industry is picked. */
  industryMode: 'include' | 'exclude';
  industryIds: IndustryId[];
  locationMismatch: boolean;
  qualificationMismatch: boolean;
  certificationMismatch: boolean;
  autoApplySupport: 'all' | 'supported';
  /** The minimum pay as typed ("150000", "$150,000", "150k"); '' for none. */
  minSalary: string;
  experienceLevels: ExperienceLevel[];
  noSponsorship: boolean;
  clearanceMismatch: boolean;
  customEnabled: boolean;
  /** Kept while the Custom filter is off, so turning it back on finds the words again. */
  customPrompt: string;
}

export type FilterFormErrors = Partial<Record<'minSalary' | 'customPrompt', string>>;

/** The largest yearly pay the schema takes. */
export const MIN_SALARY_MAX = 10_000_000;

export const FILTER_ERRORS = {
  minSalary: 'Enter a yearly amount in dollars, such as 90000 or 90k',
  customEmpty: 'Describe the jobs to skip or keep, or turn the Custom filter off',
} as const;

/** `values` in `order`'s order, each once. */
function ordered<V extends string>(values: readonly V[], order: readonly V[]): V[] {
  const wanted = new Set(values);
  return order.filter((value) => wanted.has(value));
}

/** Adds `value` to the list, or takes it out, keeping the vocabulary's order. */
export function toggleIn<V extends string>(list: readonly V[], value: V, order: readonly V[]): V[] {
  return ordered(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value], order);
}

/** The saved filters as the form shows them. */
export function filtersToForm(input: PrepareFilters): FilterForm {
  const filters = PrepareFiltersSchema.parse(input);
  return {
    locationTypes: ordered(filters.locationTypes, WORK_ARRANGEMENTS),
    jobTypes: ordered(filters.jobTypes, EMPLOYMENT_TYPES_V2),
    industryMode: filters.industries?.mode ?? 'include',
    industryIds: ordered(filters.industries?.ids ?? [], INDUSTRY_IDS),
    locationMismatch: filters.locationMismatch,
    qualificationMismatch: filters.qualificationMismatch,
    certificationMismatch: filters.certificationMismatch,
    autoApplySupport: filters.autoApplySupport,
    minSalary: filters.minSalaryUsd === null ? '' : String(filters.minSalaryUsd),
    experienceLevels: ordered(filters.experienceLevels, EXPERIENCE_LEVELS),
    noSponsorship: filters.noSponsorship,
    clearanceMismatch: filters.clearanceMismatch,
    customEnabled: filters.custom.enabled,
    customPrompt: filters.custom.prompt,
  };
}

/** The form with nothing filtered (`{}` parsed). */
export const EMPTY_FILTER_FORM: FilterForm = filtersToForm(PrepareFiltersSchema.parse({}));

/**
 * "150000", "$150,000", "150k", "150.5k" → whole dollars a year; '' → null; anything else, or past the schema's
 * ceiling → undefined (not a pay).
 */
export function parseMinSalary(text: string): number | null | undefined {
  const value = text.trim().replace(/^\$/, '').replace(/[,\s]/g, '').toLowerCase();
  if (value === '') return null;
  const match = /^(\d+(?:\.\d+)?)(k?)$/.exec(value);
  if (!match) return undefined;
  const amount = Math.round(Number(match[1]) * (match[2] ? 1000 : 1));
  return Number.isSafeInteger(amount) && amount <= MIN_SALARY_MAX ? amount : undefined;
}

export type FormResult = { ok: true; filters: PrepareFilters } | { ok: false; errors: FilterFormErrors };

/**
 * The form's state as PrepareFiltersSchema: no industry picked is no industry filter; a Custom filter that is on
 * needs its words, at most `promptMax` (CUSTOM_FILTER_PROMPT_MAX_CHARS); one that is off keeps them.
 */
export function formToFilters(form: FilterForm, promptMax: number, tooLong: TooLongText = defaultTooLong): FormResult {
  const errors: FilterFormErrors = {};
  const minSalaryUsd = parseMinSalary(form.minSalary);
  if (minSalaryUsd === undefined) errors.minSalary = FILTER_ERRORS.minSalary;
  const prompt = form.customPrompt.trim();
  if (prompt.length > promptMax) errors.customPrompt = tooLong(promptMax);
  else if (form.customEnabled && prompt === '') errors.customPrompt = FILTER_ERRORS.customEmpty;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const industryIds = ordered(form.industryIds, INDUSTRY_IDS);
  const filters = PrepareFiltersSchema.parse({
    locationTypes: ordered(form.locationTypes, WORK_ARRANGEMENTS),
    jobTypes: ordered(form.jobTypes, EMPLOYMENT_TYPES_V2),
    industries: industryIds.length > 0 ? { mode: form.industryMode, ids: industryIds } : null,
    locationMismatch: form.locationMismatch,
    qualificationMismatch: form.qualificationMismatch,
    certificationMismatch: form.certificationMismatch,
    autoApplySupport: form.autoApplySupport,
    minSalaryUsd: minSalaryUsd ?? null,
    experienceLevels: ordered(form.experienceLevels, EXPERIENCE_LEVELS),
    noSponsorship: form.noSponsorship,
    clearanceMismatch: form.clearanceMismatch,
    custom: { enabled: form.customEnabled, prompt },
  });
  return { ok: true, filters };
}

/** `filters` with every list in its vocabulary's order (the server may keep another order). */
export function normalizeFilters(filters: PrepareFilters): PrepareFilters {
  const parsed = PrepareFiltersSchema.parse(filters);
  return {
    ...parsed,
    locationTypes: ordered(parsed.locationTypes, WORK_ARRANGEMENTS),
    jobTypes: ordered(parsed.jobTypes, EMPLOYMENT_TYPES_V2),
    industries: parsed.industries && { mode: parsed.industries.mode, ids: ordered(parsed.industries.ids, INDUSTRY_IDS) },
    experienceLevels: ordered(parsed.experienceLevels, EXPERIENCE_LEVELS),
  };
}

/** Whether two filter sets say the same, whatever the order of their lists (the save bar shows only for a change). */
export function sameFilters(a: PrepareFilters, b: PrepareFilters): boolean {
  return JSON.stringify(normalizeFilters(a)) === JSON.stringify(normalizeFilters(b));
}

/** How many filters are on (Saved pane's "Filters" button carries this count). */
export function activeFilterCount(filters: PrepareFilters): number {
  return [
    filters.locationTypes.length > 0,
    filters.jobTypes.length > 0,
    filters.industries !== null && filters.industries.ids.length > 0,
    filters.locationMismatch,
    filters.qualificationMismatch,
    filters.certificationMismatch,
    filters.autoApplySupport === 'supported',
    filters.minSalaryUsd !== null,
    filters.experienceLevels.length > 0,
    filters.noSponsorship,
    filters.clearanceMismatch,
    filters.custom.enabled,
  ].filter(Boolean).length;
}

// The words ------------------------------------------------------------------------------------------------------------

/** The location types' chips, as the filter's label words them ("Filtered: on-site"). */
export const LOCATION_TYPE_LABEL: Record<WorkArrangement, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };

/** The job types' chips, in the order the design lists them. */
export const JOB_TYPE_CHIPS: readonly { value: EmploymentTypeV2; label: string }[] = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'contract', label: 'Contract' },
  { value: 'internship', label: 'Internship' },
  { value: 'temporary', label: 'Temporary' },
  { value: 'unpaid', label: 'Unpaid' },
];

/** Each reason's short words in the preview line ("9 location type, 3 location, 2 job type"). */
export const REASON_SHORT: Record<FilterReason, string> = {
  auto_apply: 'auto-apply not supported',
  location_type: 'location type',
  job_type: 'job type',
  industry: 'industry',
  location_mismatch: 'location',
  qualification: 'qualifications',
  certification: 'certification',
  salary: 'pay',
  experience: 'experience level',
  sponsorship: 'no sponsorship',
  clearance: 'clearance',
  custom: 'custom filter',
  eligibility: 'eligibility', // v33 SHARE-5: the masked reason (a shared profile without Sensitive answers)
};

/**
 * The preview line: "With these filters, 38 of your 52 saved jobs can be prepared. 9 location type, 3 location." The
 * reasons are each failing job's first, most common first (ties in the filters' fixed order).
 */
export function previewLine(preview: PrepareFiltersPreview): string {
  if (preview.total === 0) return 'You have no saved jobs to check yet. Save jobs, and these filters decide which can be prepared.';
  const jobs = preview.total === 1 ? 'saved job' : 'saved jobs';
  const head =
    preview.fail === 0
      ? `With these filters, all ${preview.total === 1 ? '1' : preview.total} of your ${jobs} can be prepared.`
      : `With these filters, ${preview.pass} of your ${preview.total} ${jobs} can be prepared.`;
  const reasons = FILTER_REASONS.map((reason, index) => ({ reason, index, count: preview.byReason[reason] ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map((entry) => `${entry.count} ${REASON_SHORT[entry.reason]}`);
  return reasons.length > 0 ? `${head} ${reasons.join(', ')}.` : head;
}

// v34 FANWEB (PLAN G3: "only the fields A changed are applied"; FANOUT's PATCH semantics) -------------------------------

/** The filters' names, in PrepareFilters' order (the PATCH's keys). */
export const FILTER_KEYS = [
  'locationTypes',
  'jobTypes',
  'industries',
  'locationMismatch',
  'qualificationMismatch',
  'certificationMismatch',
  'autoApplySupport',
  'minSalaryUsd',
  'experienceLevels',
  'noSponsorship',
  'clearanceMismatch',
  'custom',
] as const satisfies readonly PrepareFilterKey[];

/** The filters that differ between `saved` and `next` (lists compared in their vocabulary's order). */
export function changedFilters(saved: PrepareFilters, next: PrepareFilters): PrepareFilterKey[] {
  const a = normalizeFilters(saved);
  const b = normalizeFilters(next);
  return FILTER_KEYS.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/** The custom filter's part of a PATCH. */
export type CustomFilterPatch = NonNullable<PrepareFiltersPatch['custom']>;

/**
 * The PATCH of `next` for `keys` on ONE profile: each filter whole (a list replaces the saved one; `null` clears the
 * industries or the minimum pay), but the custom filter, which sends only the part that changed (its switch, its words).
 * v34 FANWEB fix (the reviews' custom-filter findings; MCPFAN's checkPatchAlone): a switch turned on always carries its
 * words, and words sent empty always carry the switch (off), so the change stands on its own for a writer who may not
 * read the filters there. Null when no key is given.
 */
export function filtersPatch(saved: PrepareFilters, next: PrepareFilters, keys: readonly PrepareFilterKey[]): PrepareFiltersPatch | null {
  if (keys.length === 0) return null;
  const b = normalizeFilters(next);
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    if (key !== 'custom') {
      patch[key] = b[key];
      continue;
    }
    const custom: { enabled?: boolean; prompt?: string } = {};
    if (saved.custom.enabled !== b.custom.enabled) custom.enabled = b.custom.enabled;
    if (saved.custom.prompt !== b.custom.prompt || custom.enabled === true) custom.prompt = b.custom.prompt;
    if (custom.prompt !== undefined && custom.prompt.trim() === '') custom.enabled = false;
    if (Object.keys(custom).length > 0) patch.custom = custom;
  }
  return Object.keys(patch).length > 0 ? (patch as PrepareFiltersPatch) : null;
}

/** What a change of the filters on SEVERAL profiles sends (severalFiltersPatch). */
export interface SeveralFiltersPatch {
  /** What every chosen profile gets: the marked filters (null: none of them goes to every profile). */
  patch: PrepareFiltersPatch | null;
  /**
   * The custom filter on, with words the person did not type in this form: the other profiles are left out of it (their
   * owners' words stay theirs). `here`: what the form's own profile gets (its switch turned on with its own words), null
   * when it is on there already.
   */
  customHeld: { here: CustomFilterPatch | null } | null;
}

/**
 * v34 FANWEB fix (both reviews' HIGH: the custom filter's words went to every profile): the marked filters of `next` for
 * several profiles. Each filter whole, as the form shows it (a marked one equal to the saved one goes as it is). The
 * custom filter (one mark for its switch and its words): turned off, the switch goes alone (every owner keeps their
 * words); on with words the person typed here, the switch and the words go together; on with the words as they were,
 * nothing of it goes to the other profiles (`customHeld`).
 */
export function severalFiltersPatch(saved: PrepareFilters, next: PrepareFilters, keys: readonly PrepareFilterKey[]): SeveralFiltersPatch {
  const b = normalizeFilters(next);
  const patch: Record<string, unknown> = {};
  let customHeld: SeveralFiltersPatch['customHeld'] = null;
  for (const key of keys) {
    if (key !== 'custom') patch[key] = b[key];
    else if (!b.custom.enabled) patch.custom = { enabled: false };
    else if (customWordsTyped(saved, b)) patch.custom = { enabled: true, prompt: b.custom.prompt };
    else customHeld = { here: saved.custom.enabled ? null : { enabled: true, prompt: b.custom.prompt } };
  }
  return { patch: Object.keys(patch).length > 0 ? (patch as PrepareFiltersPatch) : null, customHeld };
}

/** Whether the custom filter's words in `next` are not the saved ones (typed in this form). */
export function customWordsTyped(saved: PrepareFilters, next: Pick<PrepareFilters, 'custom'>): boolean {
  return next.custom.prompt.trim() !== saved.custom.prompt.trim();
}

/** A filter's name as the form shows it (a kept switch's words, a mark's label). */
export const FILTER_FIELD_LABEL: Record<PrepareFilterKey, string> = {
  locationTypes: 'Location type',
  jobTypes: 'Job type',
  industries: 'Industry',
  locationMismatch: 'Location mismatch',
  qualificationMismatch: 'Qualifications',
  certificationMismatch: 'Certifications',
  autoApplySupport: 'Auto-apply support',
  minSalaryUsd: 'Minimum pay',
  experienceLevels: 'Experience level',
  noSponsorship: 'I need visa sponsorship',
  clearanceMismatch: 'Clearance',
  custom: 'Custom (AI)',
};

/** Whole dollars in the page's style ("90,000"). */
const dollars = (amount: number) => amount.toLocaleString('en-US');

/**
 * The Profiles page's one line of a profile's filters ("Remote, Full-time, Location, Pay from $90,000"): each filter
 * that is on (filtersOn), a list by its values, the rest by their names.
 */
export function filtersLineWords(filters: PrepareFilters, on: readonly PrepareFilterKey[]): string[] {
  const jobType = new Map(JOB_TYPE_CHIPS.map((chip) => [chip.value, chip.label] as const));
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return on.map((key) => {
    switch (key) {
      case 'locationTypes':
        return ordered(filters.locationTypes, WORK_ARRANGEMENTS)
          .map((value) => LOCATION_TYPE_LABEL[value])
          .join('/');
      case 'jobTypes':
        return ordered(filters.jobTypes, EMPLOYMENT_TYPES_V2)
          .map((value) => jobType.get(value) ?? value)
          .join('/');
      case 'industries': {
        const ids = filters.industries?.ids.length ?? 0;
        return `${filters.industries?.mode === 'exclude' ? 'Skip' : 'Only'} ${count(ids, 'industry', 'industries')}`;
      }
      case 'locationMismatch':
        return 'Location';
      case 'autoApplySupport':
        return 'Auto-apply only';
      case 'minSalaryUsd':
        return 'Pay from $' + dollars(filters.minSalaryUsd ?? 0);
      case 'experienceLevels':
        return count(filters.experienceLevels.length, 'level', 'levels');
      case 'noSponsorship':
        return 'Visa sponsorship';
      default:
        return FILTER_FIELD_LABEL[key];
    }
  });
}
