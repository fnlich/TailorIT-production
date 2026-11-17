import { Router } from 'express';
import {
  IdParam,
  PrepareSettingsBodySchema,
  PrepareStartRequestSchema,
  MINUTE_MS,
  type PrepareStartResponse,
} from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { perAccountLimit } from '../autofill/auth';
import { applicationDraft } from './kit';
import { prepareServiceOf } from './service';
import { prepareSettingsOf, savePrepareSettings } from './settings';

// Prepare & Queue's session routes (docs/design/v2.0/05-prepare-flow.md; the web pages only, never an extension token):
//   POST /api/prepare                 PrepareStartRequest {applicationIds, rebuild?} → 202 PrepareStartResponse (each
//                                     job's outcome), or one error for the whole request
//   GET  /api/prepare/settings        → PrepareSettings {letterMode, resumeMode, skipConfirm}
//   PUT  /api/prepare/settings        PrepareSettingsBody (any of the three) → PrepareSettings, as saved
//   POST /api/prepare/:id/cancel      → PrepareJob; 404 for another account's
//   GET  /api/applications/:id/draft  → ApplicationDraftResponse (the Tracker's "Prepared" tab; the owner's alone)

/** Mounted at /api/prepare. */
export function createPrepareRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const startLimit = perAccountLimit('prepare-start', 10, MINUTE_MS);

  router.post('/', startLimit, async (req, res) => {
    const body = parseInput(PrepareStartRequestSchema, req.body ?? {}, 'request');
    const answer: PrepareStartResponse = await prepareServiceOf(deps).startPrepare(userOf(req).id, body, 'server');
    res.status(202).json(answer);
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
