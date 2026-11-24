import { Router, type Request, type RequestHandler } from 'express';
import { MINUTE_MS } from '@tailorit/shared';
import {
  FanoutAddJobBodySchema,
  FanoutAutoSaveRuleBodySchema,
  FanoutBulkBodySchema,
  FanoutCopySavedBodySchema,
  FanoutFiltersBodySchema,
  FanoutPrepareSettingsBodySchema,
  FanoutSaveJobsBodySchema,
  FanoutSavedOnQuerySchema,
  FanoutSettingsQuerySchema,
  FanoutUnsaveJobsBodySchema, // v36 JOBS
  type FanoutAddJobAnswer,
  type FanoutAutoSaveRuleAnswer,
  type FanoutBulkAnswer,
  type FanoutCopySavedAnswer,
  type FanoutFiltersAnswer,
  type FanoutPrepareSettingsAnswer,
  type FanoutSaveJobsAnswer,
  type FanoutSavedOn,
  type FanoutSettingsSummary,
  type FanoutUnsaveJobsAnswer, // v36 JOBS
} from '@tailorit/shared/sharing';
import { actorOf, payerOf, requireUser } from '../../../core/auth/guards';
import type { AppDeps } from '../../../core/context';
import { parseInput } from '../../../core/http/validate';
import { keyedRateLimit } from '../../../core/rate-limit';
import { waitSentence } from '../../autofill/auth';
import { bulkOnProfiles } from './bulk';
import { addByLinkOnProfiles, copySavedJobs, saveJobsOnProfiles, savedOnProfiles } from './jobs'; // v36 JOBS: Save all to is gone
import { autoSaveRuleOnProfiles, filtersOnProfiles, prepareSettingsOnProfiles, settingsSummary } from './settings';
// v36 APPLYAPI (PLAN A3): Share All, a preview and a start (share-all.ts; the shapes: @tailorit/shared/sharing share-all.ts).
import { FanoutShareAllBodySchema, FanoutShareAllPreviewQuerySchema, type FanoutShareAllAnswer, type FanoutShareAllPreviewAnswer } from '@tailorit/shared/sharing';
import { shareAllOnProfiles, shareAllPreviewOnProfiles } from './share-all';
// end v36 APPLYAPI
import type { FanoutActor } from './targets';
import { unsaveJobsOnProfiles } from './unsave'; // v36 JOBS

// v34 FANOUT (PLAN G1-G3), mounted at /api/profiles: one action on the signed-in person's own profile and the profiles
// shared with them, answered per profile (@tailorit/shared/sharing fanout.ts has every body and answer). Session only
// (an extension token never reaches it: core/auth/extension-tokens.ts tokenScope). Every route is `self` (./acting.ts).
//   POST  /jobs/save            FanoutSaveJobsBody → FanoutSaveJobsAnswer
//   POST  /jobs/unsave          FanoutUnsaveJobsBody → FanoutUnsaveJobsAnswer (v36 JOBS: unsave.ts)
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
/** Adds by link and bulk starts per person per minute (an add reads an outside page; Prepare starts AI work). */
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

  router.post('/jobs/save', perPerson('profiles-save', FANOUT_CHANGES_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutSaveJobsBodySchema, req.body ?? {}, 'request');
    const answer: FanoutSaveJobsAnswer = await saveJobsOnProfiles(deps, actorFor(req), body);
    res.json(answer);
  });

  // v36 JOBS (PLAN J5): the Select bar's Unsave, on the tab's profile or the profiles chosen (Job Tracker › Change each).
  router.post('/jobs/unsave', perPerson('profiles-unsave', FANOUT_CHANGES_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutUnsaveJobsBodySchema, req.body ?? {}, 'request');
    const answer: FanoutUnsaveJobsAnswer = await unsaveJobsOnProfiles(deps, actorFor(req), body);
    res.json(answer);
  });
  // end v36 JOBS

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

  // v36 APPLYAPI (PLAN A3): Share All, every job in Saved on one profile shared to others.
  //   GET  /saved/share-all/preview ?source=&targets= → FanoutShareAllPreviewAnswer (a read of up to SHARE_ALL_MAX entries
  //                                 and of each target's tracker: the change routes' limit, as Prepare All's plan)
  //   POST /saved/share-all         FanoutShareAllBody → FanoutShareAllAnswer (up to SHARE_ALL_MAX jobs on each target:
  //                                 the bulk starts' limit)
  router.get('/saved/share-all/preview', perPerson('profiles-share-all-preview', FANOUT_CHANGES_PER_MINUTE), async (req, res) => {
    const query = parseInput(FanoutShareAllPreviewQuerySchema, req.query ?? {}, 'query');
    const answer: FanoutShareAllPreviewAnswer = await shareAllPreviewOnProfiles(deps, actorFor(req), query);
    res.json(answer);
  });

  router.post('/saved/share-all', perPerson('profiles-share-all', FANOUT_STARTS_PER_MINUTE), async (req, res) => {
    const body = parseInput(FanoutShareAllBodySchema, req.body ?? {}, 'request');
    const answer: FanoutShareAllAnswer = await shareAllOnProfiles(deps, actorFor(req), body);
    res.json(answer);
  });
  // end v36 APPLYAPI

  return router;
}
