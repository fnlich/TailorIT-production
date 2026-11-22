import { Router, type Request, type RequestHandler } from 'express';
import { MINUTE_MS } from '@tailorit/shared';
import {
  FanoutAddJobBodySchema,
  FanoutAutoSaveRuleBodySchema,
  FanoutBulkBodySchema,
  FanoutCopySavedBodySchema,
  FanoutFiltersBodySchema,
  FanoutPrepareSettingsBodySchema,
  FanoutSaveAllBodySchema,
  FanoutSaveAllPreviewQuerySchema,
  FanoutSaveJobsBodySchema,
  FanoutSavedOnQuerySchema,
  FanoutSettingsQuerySchema,
  type FanoutAddJobAnswer,
  type FanoutAutoSaveRuleAnswer,
  type FanoutBulkAnswer,
  type FanoutCopySavedAnswer,
  type FanoutFiltersAnswer,
  type FanoutPrepareSettingsAnswer,
  type FanoutSaveAllAnswer,
  type FanoutSaveAllPreviewAnswer,
  type FanoutSaveJobsAnswer,
  type FanoutSavedOn,
  type FanoutSettingsSummary,
} from '@tailorit/shared/sharing';
import { actorOf, payerOf, requireUser } from '../../../core/auth/guards';
import type { AppDeps } from '../../../core/context';
import { parseInput } from '../../../core/http/validate';
import { keyedRateLimit } from '../../../core/rate-limit';
import { waitSentence } from '../../autofill/auth';
import { saveAllPartsOf } from '../../jobs/save-all-router';
import { bulkOnProfiles } from './bulk';
import { addByLinkOnProfiles, copySavedJobs, saveAllOnProfiles, saveAllPreviewOnProfiles, saveJobsOnProfiles, savedOnProfiles } from './jobs';
import { autoSaveRuleOnProfiles, filtersOnProfiles, prepareSettingsOnProfiles, settingsSummary } from './settings';
import type { FanoutActor } from './targets';

// v34 FANOUT (PLAN G1-G3), mounted at /api/profiles: one action on the signed-in person's own profile and the profiles
// shared with them, answered per profile (@tailorit/shared/sharing fanout.ts has every body and answer). Session only
// (an extension token never reaches it: core/auth/extension-tokens.ts tokenScope). Every route is `self` (./acting.ts).
//   POST  /jobs/save            FanoutSaveJobsBody → FanoutSaveJobsAnswer
//   GET   /jobs/save-all/preview ?targets=&search= → FanoutSaveAllPreviewAnswer
//   POST  /jobs/save-all        FanoutSaveAllBody → FanoutSaveAllAnswer (one of SAVE_ALL_RUNS_PER_HOUR when a profile
//                               ran, shared with POST /api/jobs/save-all: jobs/save-all-router.ts saveAllPartsOf)
//   POST  /jobs/add             FanoutAddJobBody → FanoutAddJobAnswer (one of JOB_ADDS_PER_HOUR for the link when a
//                               profile is usable)
//   GET   /jobs/saved-on        ?jobIds=1,2,3 → FanoutSavedOn
//   POST  /applications/copy    FanoutCopySavedBody → FanoutCopySavedAnswer
//   POST  /applications/bulk    FanoutBulkBody → FanoutBulkAnswer
//   PATCH /prepare/filters      FanoutFiltersBody → FanoutFiltersAnswer
//   PATCH /prepare/settings     FanoutPrepareSettingsBody → FanoutPrepareSettingsAnswer
//   PATCH /auto-apply/rule      FanoutAutoSaveRuleBody → FanoutAutoSaveRuleAnswer
//   GET   /settings             ?targets=&parts= → FanoutSettingsSummary
// Each route has its own anti-flood limit per person and minute (the person's: these routes act on no one profile);
// the hourly limits are the person's own, counted once whatever the targets.

/** Reads per person per minute, each read route (the Jobs list asks where its page's jobs are saved). */
export const FANOUT_READS_PER_MINUTE = 120;
/** Changes per person per minute, each change route. */
export const FANOUT_CHANGES_PER_MINUTE = 30;
/** Adds by link and bulk starts per person per minute (an add reads an outside page; Prepare & Queue starts AI work). */
export const FANOUT_STARTS_PER_MINUTE = 10;

function perPerson(name: string, limit: number): RequestHandler {
  return keyedRateLimit({
    windowMs: MINUTE_MS,
    limit,
    key: (req) => `${name}:${actorOf(req).id}`,
    message: (seconds) => `There have been too many actions on several profiles at once. ${waitSentence(seconds)}`,
  });
}

/** The person who acts (A), as the fan-out names them. */
function actorFor(req: Request): FanoutActor {
  const actor = actorOf(req);
  return { id: actor.id, name: actor.name };
}

/** Mounted at /api/profiles. */
export function createProfilesRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const { saveAll, runLimit, notCounted } = saveAllPartsOf(deps);

  router.post('/jobs/save', perPerson('profiles-save', FANOUT_CHANGES_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutSaveJobsBodySchema, req.body ?? {}, 'request');
    const answer: FanoutSaveJobsAnswer = await saveJobsOnProfiles(deps, actorFor(req), body);
    res.json(answer);
  });

  router.get('/jobs/save-all/preview', perPerson('profiles-save-all-preview', FANOUT_READS_PER_MINUTE), async (req, res) => {
    const query = parseInput(FanoutSaveAllPreviewQuerySchema, req.query ?? {}, 'query');
    const answer: FanoutSaveAllPreviewAnswer = await saveAllPreviewOnProfiles(deps, saveAll, actorFor(req), query);
    res.json(answer);
  });

  router.post('/jobs/save-all', perPerson('profiles-save-all', FANOUT_CHANGES_PER_MINUTE), runLimit, async (req, res) => {
    const body = parseInput(FanoutSaveAllBodySchema, req.body ?? {}, 'request');
    const answer: FanoutSaveAllAnswer = await saveAllOnProfiles(deps, saveAll, actorFor(req), body);
    // One of the person's runs an hour only when a profile ran (the FANOUT review's sharing 7).
    if (!answer.results.some((result) => result.ok)) notCounted(req);
    res.json(answer);
  });

  router.post('/jobs/add', perPerson('profiles-add', FANOUT_STARTS_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutAddJobBodySchema, req.body ?? {}, 'job');
    const answer: FanoutAddJobAnswer = await addByLinkOnProfiles(deps, actorFor(req), body);
    res.json(answer);
  });

  router.get('/jobs/saved-on', perPerson('profiles-saved-on', FANOUT_READS_PER_MINUTE), async (req, res) => {
    const query = parseInput(FanoutSavedOnQuerySchema, req.query ?? {}, 'query');
    const answer: FanoutSavedOn = await savedOnProfiles(deps, actorFor(req), query.jobIds);
    res.json(answer);
  });

  router.post('/applications/copy', perPerson('profiles-copy', FANOUT_CHANGES_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutCopySavedBodySchema, req.body ?? {}, 'request');
    const answer: FanoutCopySavedAnswer = await copySavedJobs(deps, actorFor(req), body);
    res.json(answer);
  });

  router.post('/applications/bulk', perPerson('profiles-bulk', FANOUT_STARTS_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutBulkBodySchema, req.body ?? {}, 'request');
    const answer: FanoutBulkAnswer = await bulkOnProfiles(deps, actorFor(req), body, { own: payerOf(req) });
    res.json(answer);
  });

  router.patch('/prepare/filters', perPerson('profiles-filters', FANOUT_CHANGES_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutFiltersBodySchema, req.body ?? {}, 'filters');
    const answer: FanoutFiltersAnswer = await filtersOnProfiles(deps, actorFor(req), body);
    res.json(answer);
  });

  router.patch('/prepare/settings', perPerson('profiles-prepare-settings', FANOUT_CHANGES_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutPrepareSettingsBodySchema, req.body ?? {}, 'settings');
    const answer: FanoutPrepareSettingsAnswer = await prepareSettingsOnProfiles(deps, actorFor(req), body);
    res.json(answer);
  });

  router.patch('/auto-apply/rule', perPerson('profiles-rule', FANOUT_CHANGES_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutAutoSaveRuleBodySchema, req.body ?? {}, 'settings');
    const answer: FanoutAutoSaveRuleAnswer = await autoSaveRuleOnProfiles(deps, actorFor(req), body);
    res.json(answer);
  });

  router.get('/settings', perPerson('profiles-settings', FANOUT_READS_PER_MINUTE), async (req, res) => {
    const query = parseInput(FanoutSettingsQuerySchema, req.query ?? {}, 'query');
    const answer: FanoutSettingsSummary = await settingsSummary(deps, actorFor(req), query);
    res.json(answer);
  });

  return router;
}
