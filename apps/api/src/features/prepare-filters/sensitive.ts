import type { PrepareFilters } from '@tailorit/shared';
import { FILTER_KEPT_SWITCHES } from '@tailorit/shared/sharing';

// v33 SHARE-5 (PLAN F9 "Sensitive answers"; SP v33 PLAN-sharing.md §4), moved here from router.ts by v34 FANOUT (the
// PATCH's merge, patch.ts, reads them too): someone the profile is shared with, without the Sensitive answers
// permission, reads the eligibility switches (noSponsorship, clearanceMismatch) as off, and a change of theirs keeps
// the stored switches unless they may change sensitive answers (`sensitive:edit`). v33 FIX-2: the qualification filter
// is kept likewise (KEPT_SWITCHES), though read as stored.

/** The eligibility switches: they tell an eligibility answer (a visa need, a clearance). */
export const ELIGIBILITY_SWITCHES = ['noSponsorship', 'clearanceMismatch'] as const satisfies ReadonlyArray<keyof PrepareFilters>;
/**
 * v33 FIX-2 (final review, sharing 1): the switches only someone who may change sensitive answers changes: the
 * eligibility switches, and the qualification filter, whose citizenship part decides by the owner's citizenships. Its
 * value tells nothing (it is read unmasked), but turned on by B it would make the Saved pane, Prepare and filter_jobs
 * decide by A's citizenship (two owners differing only there would read apart), which only A's own switch may do.
 * v34 FANOUT: the shared contracts' FILTER_KEPT_SWITCHES (one list for the PUT, the PATCH and the fan-out).
 */
export const KEPT_SWITCHES = FILTER_KEPT_SWITCHES;

/** The filters as `sensitive` may read them: the eligibility switches off without the permission. */
export function maskedFilters(filters: PrepareFilters, sensitive: boolean): PrepareFilters {
  if (sensitive) return filters;
  const masked = { ...filters };
  for (const key of ELIGIBILITY_SWITCHES) masked[key] = false;
  return masked;
}

/** A change of filters by someone who may not change eligibility answers: the stored switches kept (KEPT_SWITCHES). */
export function keptEligibility(next: PrepareFilters, stored: PrepareFilters): PrepareFilters {
  const kept = { ...next };
  for (const key of KEPT_SWITCHES) kept[key] = stored[key];
  return kept;
}
