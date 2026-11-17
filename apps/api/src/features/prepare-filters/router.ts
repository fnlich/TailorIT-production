import { Router } from 'express';
import { PrepareFiltersPutBodySchema, MINUTE_MS, type PrepareFiltersPreview, type PrepareFiltersResponse } from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { perAccountLimit } from '../autofill/auth';
import type { PrepareFilterServiceInternals } from './service';
import { saveFilterSettings } from './settings';

// v2.0 P4 (06-filters-analysis.md, "Routes"), mounted at /api/prepare/filters, session only:
//   GET  /          → PrepareFiltersResponse {filters, revision, locationKnown, timeZoneKnown}
//   PUT  /          {filters} → the same, saved (filters_revision + 1); a Custom filter that is on needs a prompt of at
//                   most CUSTOM_FILTER_PROMPT_MAX_CHARS (400 validation_failed)
//   POST /preview   {filters} → PrepareFiltersPreview over the person's Saved jobs (deterministic filters only, no AI)
// The person's facts themselves (location, degree, years, citizenships, clearance) are never answered.

export function createPrepareFiltersRouter(deps: AppDeps, service: PrepareFilterServiceInternals): Router {
  const router = Router();
  router.use(requireUser);
  const previewLimit = perAccountLimit('prepare-filters-preview', 30, MINUTE_MS);

  router.get('/', async (req, res) => {
    const answer: PrepareFiltersResponse = await service.settingsOf(userOf(req).id);
    res.json(answer);
  });

  router.put('/', async (req, res) => {
    const body = parseInput(PrepareFiltersPutBodySchema, req.body ?? {}, 'filters');
    const userId = userOf(req).id;
    await saveFilterSettings(deps, userId, body.filters);
    const answer: PrepareFiltersResponse = await service.settingsOf(userId);
    res.json(answer);
  });

  router.post('/preview', previewLimit, async (req, res) => {
    const body = parseInput(PrepareFiltersPutBodySchema, req.body ?? {}, 'filters');
    const answer: PrepareFiltersPreview = await service.preview(userOf(req).id, body.filters);
    res.json(answer);
  });

  return router;
}
