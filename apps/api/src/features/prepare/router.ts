import { Router } from 'express';
import {
  IdParam,
  PrepareAllRequestSchema,
  PrepareSettingsBodySchema,
  PrepareStartRequestSchema,
  MINUTE_MS,
  type PrepareAllPlan,
  type PrepareAllResponse,
  type PrepareStartResponse,
} from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { perAccountLimit } from '../autofill/auth';
import { prepareAll, prepareAllPlan } from './all';
import { applicationDraft } from './kit';
import { prepareServiceOf } from './service';
import { prepareSettingsOf, savePrepareSettings } from './settings';

// Prepare & Queue's session routes (docs/design/v2.0/05-prepare-flow.md; the web pages only, never an extension token):
//   POST /api/prepare                 PrepareStartRequest {applicationIds, rebuild?} → 202 PrepareStartResponse (each
//                                     job's outcome), or one error for the whole request
//   GET  /api/prepare/settings        → PrepareSettings {letterMode, resumeMode, skipConfirm}
//   PUT  /api/prepare/settings        PrepareSettingsBody (any of the three) → PrepareSettings, as saved
//   POST /api/prepare/:id/cancel      → PrepareJob; 404 for another account's
//   GET  /api/prepare/all             → PrepareAllPlan (v31 AUTO, D10: Prepare All's count and AI budget; starts nothing)
//   POST /api/prepare/all             PrepareAllRequest (v31 FIX-AUTH: the jobs the confirm named) → 202
//                                     PrepareAllResponse: of them, every saved job in To prepare that passes the filters,
//                                     chosen by the server within the caps (all.ts); or one error for the whole request
//   GET  /api/applications/:id/draft  → ApplicationDraftResponse (the Tracker's "Prepared" tab; the owner's alone)

/** Mounted at /api/prepare. */
export function createPrepareRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const startLimit = perAccountLimit('prepare-start', 10, MINUTE_MS);
  // v31 AUTO: Prepare All's confirm reads its plan each time it opens.
  const planLimit = perAccountLimit('prepare-all-plan', 30, MINUTE_MS);

  router.post('/', startLimit, async (req, res) => {
    const body = parseInput(PrepareStartRequestSchema, req.body ?? {}, 'request');
    const answer: PrepareStartResponse = await prepareServiceOf(deps).startPrepare(userOf(req).id, body, 'server');
    res.status(202).json(answer);
  });

  // v31 AUTO (D10): Prepare All. The start counts toward Prepare & Queue's own per-minute limit.
  router.get('/all', planLimit, async (req, res) => {
    const user = userOf(req);
    const answer: PrepareAllPlan = await prepareAllPlan(deps, user.id, { admin: user.role === 'admin' }); // v32 ADMINAPP (E7)
    res.json(answer);
  });

  router.post('/all', startLimit, async (req, res) => {
    // v31 FIX-AUTH (BEH-8): the jobs the confirm named; no other starts.
    const body = parseInput(PrepareAllRequestSchema, req.body ?? {}, 'request');
    const answer: PrepareAllResponse = await prepareAll(deps, userOf(req).id, prepareServiceOf(deps), body.applicationIds);
    res.status(answer.results.length > 0 ? 202 : 200).json(answer);
  });

  router.get('/settings', async (req, res) => {
    res.json(await prepareSettingsOf(deps, userOf(req).id));
  });

  router.put('/settings', async (req, res) => {
    const body = parseInput(PrepareSettingsBodySchema, req.body ?? {}, 'settings');
    res.json(await savePrepareSettings(deps, userOf(req).id, body));
  });

  router.post('/:id/cancel', async (req, res) => {
    const prepareId = parseInput(IdParam, req.params.id, 'prepare id');
    res.json(await prepareServiceOf(deps).cancel(userOf(req).id, prepareId));
  });

  return router;
}

/** Mounted at /api/applications, after the tracker's own routes: the "Prepared" tab's read. */
export function createApplicationDraftRouter(deps: AppDeps): Router {
  const router = Router();
  router.use('/:id/draft', requireUser);
  router.get('/:id/draft', async (req, res) => {
    const id = parseInput(IdParam, req.params.id, 'application id');
    res.json(await applicationDraft(deps, userOf(req).id, id));
  });
  return router;
}
