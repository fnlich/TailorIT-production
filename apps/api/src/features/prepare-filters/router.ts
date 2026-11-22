import { Router } from 'express';
import {
  PrepareFiltersPutBodySchema,
  MINUTE_MS,
  type PrepareFiltersPreview,
  type PrepareFiltersResponse,
} from '@tailorit/shared';
import { PrepareFiltersPatchBodySchema, type PrepareFiltersPatchResponse } from '@tailorit/shared/sharing'; // v34 FANOUT
import { actorOf, holds, rateKeyOf, requireUser, userOf } from '../../core/auth/guards'; // v34 FANOUT: actorOf, rateKeyOf
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { perAccountLimit, waitSentence } from '../autofill/auth'; // v34 FANOUT: waitSentence
import { keyedRateLimit } from '../../core/rate-limit'; // v34 FANOUT
import { patchFilterSettings, replaceFilterSettings } from './patch'; // v34 FANOUT
import { keptEligibility, maskedFilters } from './sensitive'; // v34 FANOUT
import type { PrepareFilterServiceInternals } from './service';

// v2.0 P4 (06-filters-analysis.md, "Routes"), mounted at /api/prepare/filters, session only:
//   GET  /          → PrepareFiltersResponse {filters, revision, locationKnown, timeZoneKnown}
//   PUT  /          {filters} → the same, saved (filters_revision + 1); a Custom filter that is on needs a prompt of at
//                   most CUSTOM_FILTER_PROMPT_MAX_CHARS (400 validation_failed)
//   POST /preview   {filters} → PrepareFiltersPreview over the person's Saved jobs (deterministic filters only, no AI)
//   PATCH /         v34 FANOUT: {filters: some of them} → PrepareFiltersPatchResponse (the GET's answer, `changed`, `kept`)
// The person's facts themselves (location, degree, years, citizenships, clearance) are never answered.
// v33 SHARE-5 (PLAN F9 "Sensitive answers"; SP v33 PLAN-sharing.md §4): someone the profile is shared with, without the
// Sensitive answers permission, reads the eligibility switches (noSponsorship, clearanceMismatch) as off, a change of
// theirs keeps the stored switches unless they may change sensitive answers (`sensitive:edit`), and the preview treats
// the owner's citizenship and clearance as unknown with eligibility reasons as one (no oracle).
// v33 FIX-2: the qualification filter is kept likewise (KEPT_SWITCHES), though read as stored.

// v34 FANOUT: the switches, the mask and the keep moved to ./sensitive.ts (the PATCH's merge reads them too).
export { ELIGIBILITY_SWITCHES, KEPT_SWITCHES, keptEligibility, maskedFilters } from './sensitive';

/** v34 FANOUT: filter changes (PATCH) per person per minute and profile (an anti-flood route limit). */
export const FILTER_PATCHES_PER_MINUTE = 30;

export function createPrepareFiltersRouter(deps: AppDeps, service: PrepareFilterServiceInternals): Router {
  const router = Router();
  router.use(requireUser);
  const previewLimit = perAccountLimit('prepare-filters-preview', 30, MINUTE_MS);
  // v34 FANOUT: the PATCH's anti-flood limit, in its own words (the person on each profile: rateKeyOf).
  const patchLimit = keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: FILTER_PATCHES_PER_MINUTE,
    key: (req) => `prepare-filters-patch:${rateKeyOf(req, MINUTE_MS)}`,
    message: (seconds) => `There have been too many filter changes. ${waitSentence(seconds)}`,
  });

  router.get('/', async (req, res) => {
    const answer: PrepareFiltersResponse = await service.settingsOf(userOf(req).id);
    res.json({ ...answer, filters: maskedFilters(answer.filters, holds(req, 'sensitive:view')) }); // v33 SHARE-5
  });

  router.put('/', async (req, res) => {
    const body = parseInput(PrepareFiltersPutBodySchema, req.body ?? {}, 'filters');
    const userId = userOf(req).id;
    // v33 SHARE-5: the eligibility switches change only with `sensitive:edit` (always on one's own profile). v34 FANOUT
    // (the FANOUT review, sharing 3 and 8): the custom filter's text is screened as the PATCH screens it, and the keep and
    // the write are one transaction with the owner's row locked (patch.ts replaceFilterSettings); the custom text written on
    // someone else's profile is screened (the owner's own stays theirs).
    await replaceFilterSettings(
      deps,
      { ownerId: userId, actorId: actorOf(req).id, changeEligibility: holds(req, 'sensitive:edit') },
      body.filters,
      keptEligibility,
    );
    const answer: PrepareFiltersResponse = await service.settingsOf(userId);
    res.json({ ...answer, filters: maskedFilters(answer.filters, holds(req, 'sensitive:view')) });
  });

  // v34 FANOUT (PLAN G3): only the fields given change (patch.ts: the fan-out's merge too); a kept switch given without
  // Sensitive answers' Change is reported in `kept`; the custom filter's text is screened.
  router.patch('/', patchLimit, async (req, res) => {
    const body = parseInput(PrepareFiltersPatchBodySchema, req.body ?? {}, 'filters');
    const answer: PrepareFiltersPatchResponse = await patchFilterSettings(
      deps,
      service,
      {
        ownerId: userOf(req).id,
        actorId: actorOf(req).id,
        changeEligibility: holds(req, 'sensitive:edit'),
        seeEligibility: holds(req, 'sensitive:view'),
        // The FANOUT review's sharing 1: the filters only with Prepare & queue's See, as the GET.
        seeFilters: holds(req, 'prepare:view'),
      },
      body.filters,
    );
    res.json(answer);
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
