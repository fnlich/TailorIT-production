import { Router } from 'express';
import {
  PrepareFiltersPutBodySchema,
  MINUTE_MS,
  type PrepareFilters,
  type PrepareFiltersPreview,
  type PrepareFiltersResponse,
} from '@tailorit/shared';
import { holds, requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { perAccountLimit } from '../autofill/auth';
import type { PrepareFilterServiceInternals } from './service';
import { readFilterSettings, saveFilterSettings } from './settings';

// v2.0 P4 (06-filters-analysis.md, "Routes"), mounted at /api/prepare/filters, session only:
//   GET  /          → PrepareFiltersResponse {filters, revision, locationKnown, timeZoneKnown}
//   PUT  /          {filters} → the same, saved (filters_revision + 1); a Custom filter that is on needs a prompt of at
//                   most CUSTOM_FILTER_PROMPT_MAX_CHARS (400 validation_failed)
//   POST /preview   {filters} → PrepareFiltersPreview over the person's Saved jobs (deterministic filters only, no AI)
// The person's facts themselves (location, degree, years, citizenships, clearance) are never answered.
// v33 SHARE-5 (PLAN F9 "Sensitive answers"; SP v33 PLAN-sharing.md §4): someone the profile is shared with, without the
// Sensitive answers permission, reads the eligibility switches (noSponsorship, clearanceMismatch) as off, a change of
// theirs keeps the stored switches unless they may change sensitive answers (`sensitive:edit`), and the preview treats
// the owner's citizenship and clearance as unknown with eligibility reasons as one (no oracle).
// v33 FIX-2: the qualification filter is kept likewise (KEPT_SWITCHES), though read as stored.

/** The eligibility switches: they tell an eligibility answer (a visa need, a clearance). */
const ELIGIBILITY_SWITCHES = ['noSponsorship', 'clearanceMismatch'] as const satisfies ReadonlyArray<keyof PrepareFilters>;
/**
 * v33 FIX-2 (final review, sharing 1): the switches only someone who may change sensitive answers changes: the
 * eligibility switches, and the qualification filter, whose citizenship part decides by the owner's citizenships. Its
 * value tells nothing (it is read unmasked), but turned on by B it would make the Saved pane, Prepare and filter_jobs
 * decide by A's citizenship (two owners differing only there would read apart), which only A's own switch may do.
 */
const KEPT_SWITCHES = [...ELIGIBILITY_SWITCHES, 'qualificationMismatch'] as const satisfies ReadonlyArray<keyof PrepareFilters>;

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

export function createPrepareFiltersRouter(deps: AppDeps, service: PrepareFilterServiceInternals): Router {
  const router = Router();
  router.use(requireUser);
  const previewLimit = perAccountLimit('prepare-filters-preview', 30, MINUTE_MS);

  router.get('/', async (req, res) => {
    const answer: PrepareFiltersResponse = await service.settingsOf(userOf(req).id);
    res.json({ ...answer, filters: maskedFilters(answer.filters, holds(req, 'sensitive:view')) }); // v33 SHARE-5
  });

  router.put('/', async (req, res) => {
    const body = parseInput(PrepareFiltersPutBodySchema, req.body ?? {}, 'filters');
    const userId = userOf(req).id;
    // v33 SHARE-5: the eligibility switches change only with `sensitive:edit` (always on one's own profile).
    const filters = holds(req, 'sensitive:edit')
      ? body.filters
      : keptEligibility(body.filters, (await readFilterSettings(deps, userId)).filters);
    await saveFilterSettings(deps, userId, filters);
    const answer: PrepareFiltersResponse = await service.settingsOf(userId);
    res.json({ ...answer, filters: maskedFilters(answer.filters, holds(req, 'sensitive:view')) });
  });

  router.post('/preview', previewLimit, async (req, res) => {
    const body = parseInput(PrepareFiltersPutBodySchema, req.body ?? {}, 'filters');
    // v33 SHARE-5: without the Sensitive answers permission, the owner's eligibility answers are unknown to it.
    const viewer = { sensitive: holds(req, 'sensitive:view') };
    const answer: PrepareFiltersPreview = await service.preview(userOf(req).id, body.filters, viewer);
    res.json(answer);
  });

  return router;
}
