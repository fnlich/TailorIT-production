import type { PrepareFilters, PrepareFiltersExtra } from './schema';

// v2.0 P4 (07-mcp.md, "Extra filters narrow only"): MCP filter_jobs' `extra` on top of the person's saved filters. Each
// list of allowed values is intersected with the saved one ([] is "any"); a switch can be turned on, never off; the
// minimum salary can only rise; the industries can only lose ids or gain exclusions; the Custom filter is the saved
// prompt alone. Nothing the saved filters fail can pass.

/** The lists of allowed values a merge can empty. */
export type NarrowableFilter = 'locationTypes' | 'jobTypes' | 'experienceLevels' | 'industries';

/**
 * Filters after a merge. `none` names the lists the merge left with no value at all (the saved list and the extra one
 * share none): every known value fails them, as an unknown one still passes.
 */
export interface MergedFilters extends PrepareFilters {
  none?: NarrowableFilter[];
}

/** `saved` ∩ `extra`: `extra` alone when `saved` allows any ([]); `saved` when `extra` says nothing. Null: nothing left. */
function intersect<T>(saved: readonly T[], extra: readonly T[] | undefined): T[] | null {
  if (extra === undefined) return [...saved];
  if (saved.length === 0) return [...extra];
  if (extra.length === 0) return [...saved];
  const both = saved.filter((value) => extra.includes(value));
  return both.length > 0 ? both : null;
}

/**
 * The saved industries with the extra ones on top: include ∩ include, exclude ∪ exclude, an include less the
 * exclusions. Null for nothing filtered; `{mode: 'include', ids: []}` when nothing is left to allow.
 */
function mergeIndustries(
  saved: PrepareFilters['industries'],
  extra: PrepareFiltersExtra['industries'],
): { value: PrepareFilters['industries']; emptied: boolean } {
  // A saved include with no ids is "nothing chosen" (evaluateFilters reads it as off).
  const base = saved && (saved.mode === 'exclude' || saved.ids.length > 0) ? saved : null;
  if (!extra || (extra.mode === 'include' && extra.ids.length === 0)) return { value: base, emptied: false };
  if (!base) return { value: { mode: extra.mode, ids: [...extra.ids] }, emptied: false };
  if (base.mode === 'exclude' && extra.mode === 'exclude') {
    return { value: { mode: 'exclude', ids: [...new Set([...base.ids, ...extra.ids])].slice(0, 50) }, emptied: false };
  }
  const include = base.mode === 'include' ? base.ids : extra.ids;
  const other = base.mode === 'include' ? extra : base;
  const ids = other.mode === 'include' ? include.filter((id) => other.ids.includes(id)) : include.filter((id) => !other.ids.includes(id));
  return { value: { mode: 'include', ids }, emptied: ids.length === 0 };
}

/** The saved filters narrowed by `extra` (never loosened). Without `extra`, the saved filters as they are. */
export function mergeExtra(saved: PrepareFilters, extra?: PrepareFiltersExtra | null): MergedFilters {
  if (!extra) return { ...saved };
  const none: NarrowableFilter[] = [];
  const list = <T>(key: 'locationTypes' | 'jobTypes' | 'experienceLevels', savedList: readonly T[], extraList: readonly T[] | undefined): T[] => {
    const merged = intersect(savedList, extraList);
    if (merged === null) {
      none.push(key);
      return [...savedList];
    }
    return merged;
  };
  const industries = mergeIndustries(saved.industries, extra.industries);
  if (industries.emptied) none.push('industries');
  const minimums = [saved.minSalaryUsd, extra.minSalaryUsd].filter((value): value is number => typeof value === 'number');
  return {
    locationTypes: list('locationTypes', saved.locationTypes, extra.locationTypes),
    jobTypes: list('jobTypes', saved.jobTypes, extra.jobTypes),
    industries: industries.value,
    locationMismatch: saved.locationMismatch || extra.locationMismatch === true,
    qualificationMismatch: saved.qualificationMismatch || extra.qualificationMismatch === true,
    certificationMismatch: saved.certificationMismatch || extra.certificationMismatch === true,
    autoApplySupport: saved.autoApplySupport === 'supported' || extra.autoApplySupport === 'supported' ? 'supported' : 'all',
    minSalaryUsd: minimums.length > 0 ? Math.max(...minimums) : null,
    experienceLevels: list('experienceLevels', saved.experienceLevels, extra.experienceLevels),
    noSponsorship: saved.noSponsorship || extra.noSponsorship === true,
    clearanceMismatch: saved.clearanceMismatch || extra.clearanceMismatch === true,
    custom: { ...saved.custom },
    ...(none.length > 0 ? { none } : {}),
  };
}
