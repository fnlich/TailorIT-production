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
import { actorOf, payerOf, rateKeyOf, requireUser, userOf } from '../../core/auth/guards'; // v34 FANOUT: rateKeyOf
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { perAccountLimit, waitSentence } from '../autofill/auth'; // v34 FANOUT: waitSentence
import { keyedRateLimit } from '../../core/rate-limit'; // v34 FANOUT
import { prepareAll, prepareAllPlan } from './all';
import { applicationDraft, viewerOf } from './kit';
import { prepareServiceOf } from './service';
import { prepareSettingsOf, savePrepareSettings } from './settings';

// Prepare & Queue's session routes (docs/design/v2.0/05-prepare-flow.md; the web pages only, never an extension token):
//   POST /api/prepare                 PrepareStartRequest {applicationIds, rebuild?} → 202 PrepareStartResponse (each
//                                     job's outcome), or one error for the whole request
//   GET  /api/prepare/settings        → PrepareSettings {letterMode, resumeMode, skipConfirm}
//   PUT  /api/prepare/settings        PrepareSettingsBody (any of the three) → PrepareSettings, as saved (v34 FIX-API: on
//                                     someone else's profile skipConfirm is kept: PrepareSettingsSaved's `kept`)
//   PATCH /api/prepare/settings       v34 FANOUT: the same (the PATCH form the fan-out's forms send)
//   POST /api/prepare/:id/cancel      → PrepareJob; 404 for another account's
//   GET  /api/prepare/all             → PrepareAllPlan (v31 AUTO, D10: Prepare All's count and AI budget; starts nothing)
//   POST /api/prepare/all             PrepareAllRequest (v31 FIX-AUTH: the jobs the confirm named) → 202
//                                     PrepareAllResponse: of them, every saved job in To prepare that passes the filters,
//                                     chosen by the server within the caps (all.ts); or one error for the whole request
//   GET  /api/applications/:id/draft  → ApplicationDraftResponse (the Tracker's "Prepared" tab; the owner's alone)
// v33 SHARE-5 (PLAN F9): on a profile shared with them (acting.ts), B starts Prepares as its payer (payerOf: B's AI
// budget and Prepares an hour, within B's room there), cancels only the Prepares B started, and, without the Sensitive
// answers permission, sees eligibility filter reasons as one word and held-back questions as not ready (viewerOf).

/** v34 FANOUT: Prepare settings changes (PATCH) per person per minute and profile (an anti-flood route limit). */
export const SETTINGS_PATCHES_PER_MINUTE = 30;

/** Mounted at /api/prepare. */
export function createPrepareRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const startLimit = perAccountLimit('prepare-start', 10, MINUTE_MS);
  // v31 AUTO: Prepare All's confirm reads its plan each time it opens.
  const planLimit = perAccountLimit('prepare-all-plan', 30, MINUTE_MS);
  // v34 FANOUT: the settings PATCH's anti-flood limit, in its own words (the person on each profile: rateKeyOf).
  const settingsPatchLimit = keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: SETTINGS_PATCHES_PER_MINUTE,
    key: (req) => `prepare-settings-patch:${rateKeyOf(req, MINUTE_MS)}`,
    message: (seconds) => `There have been too many changes to the Prepare settings. ${waitSentence(seconds)}`,
  });

  router.post('/', startLimit, async (req, res) => {
    const body = parseInput(PrepareStartRequestSchema, req.body ?? {}, 'request');
    const answer: PrepareStartResponse = await prepareServiceOf(deps).startPrepare(userOf(req).id, body, 'server', {
      payer: payerOf(req), // v33 SHARE-5
      viewer: viewerOf(req),
    });
    res.status(202).json(answer);
  });

  // v31 AUTO (D10): Prepare All. The start counts toward Prepare & Queue's own per-minute limit.
  router.get('/all', planLimit, async (req, res) => {
    const user = userOf(req);
    // v32 ADMINAPP (E7); v33 SHARE-5: the amounts by the signed-in person's role, the budget the payer's.
    const answer: PrepareAllPlan = await prepareAllPlan(deps, user.id, { admin: actorOf(req).role === 'admin', payer: payerOf(req) });
    res.json(answer);
  });

  router.post('/all', startLimit, async (req, res) => {
    // v31 FIX-AUTH (BEH-8): the jobs the confirm named; no other starts.
    const body = parseInput(PrepareAllRequestSchema, req.body ?? {}, 'request');
    const answer: PrepareAllResponse = await prepareAll(deps, userOf(req).id, prepareServiceOf(deps), body.applicationIds, {
      payer: payerOf(req), // v33 SHARE-5
      viewer: viewerOf(req),
    });
    res.status(answer.results.length > 0 ? 202 : 200).json(answer);
  });

  router.get('/settings', async (req, res) => {
    res.json(await prepareSettingsOf(deps, userOf(req).id));
  });

  router.put('/settings', async (req, res) => {
    const body = parseInput(PrepareSettingsBodySchema, req.body ?? {}, 'settings');
    // v34 FIX-API (the final sharing review, M1): on someone else's profile "Ask before using AI" is kept (its owner's).
    res.json(await savePrepareSettings(deps, userOf(req).id, body, { actorId: actorOf(req).id }));
  });

  // v34 FANOUT (PLAN G3): the PATCH form (the web's form sends only what changed; the fan-out runs the same save on each
  // profile). savePrepareSettings already changes only the fields given.
  router.patch('/settings', settingsPatchLimit, async (req, res) => {
    const body = parseInput(PrepareSettingsBodySchema, req.body ?? {}, 'settings');
    res.json(await savePrepareSettings(deps, userOf(req).id, body, { actorId: actorOf(req).id })); // v34 FIX-API (M1)
  });

  router.post('/:id/cancel', async (req, res) => {
    const prepareId = parseInput(IdParam, req.params.id, 'prepare id');
    // v33 SHARE-5: on a profile shared with them, B cancels only the Prepares B started.
    res.json(await prepareServiceOf(deps).cancel(userOf(req).id, prepareId, { actorId: actorOf(req).id, viewer: viewerOf(req) }));
  });

  return router;
}

/** Mounted at /api/applications, after the tracker's own routes: the "Prepared" tab's read. */
export function createApplicationDraftRouter(deps: AppDeps): Router {
  const router = Router();
  router.use('/:id/draft', requireUser);
  router.get('/:id/draft', async (req, res) => {
    const id = parseInput(IdParam, req.params.id, 'application id');
    res.json(await applicationDraft(deps, userOf(req).id, id, viewerOf(req))); // v33 SHARE-5
  });
  return router;
}
