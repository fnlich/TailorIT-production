import { Router, type Request, type RequestHandler } from 'express';
import { MINUTE_MS } from '@tailorit/shared';
import {
  GrantCreateBodySchema,
  GrantPatchBodySchema,
  GrantStopBodySchema,
  SharingActivityQuerySchema,
  isProfileKey,
  type GrantCreated,
  type GrantView,
  type SharedProfiles,
  type SharingActivity,
  type SharingGrants,
  type SharingOverview,
} from '@tailorit/shared/sharing';
import { ownProfileOnly } from '../../core/auth/grants';
import { actorOf, requireUser } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { waitSentence } from '../autofill/auth';
import { activityOf } from './activity';
import { changeGrant, createGrant, grantGone, listGrants, stopGrant } from './grants';
import { acceptInvite, declineInvite, leaveProfile, sharedProfiles } from './invites';
import { overviewOf } from './overview';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §2, §8, §10): shared profiles, mounted at /api/sharing. Session only (an
// extension token never reaches /api/sharing: core/auth/extension-tokens.ts tokenScope). The policies on a shared
// profile are ./acting.ts's: reads `self` (the signed-in person's own sharing), writes `never`.
//   GET   /profiles                (self)  → SharedProfiles   the profiles shared with me, my invites (the switcher)
//   GET   /grants                  (self)  → SharingGrants    the people I share my profile with
//   GET   /activity?key&cursor&limit (self) → SharingActivity  hourly counts of both sides
//   GET   /overview                (self)  → SharingOverview  every profile at once (the Profiles page)
//   POST  /grants                  (never) GrantCreateBody → 202 GrantCreated (the same for every address)
//   PATCH /grants/:key             (never) GrantPatchBody → GrantView
//   POST  /grants/:key/stop        (never) GrantStopBody → 204 (stop sharing, or cancel an invite)
//   POST  /profiles/:key/accept    (never) → 204
//   POST  /profiles/:key/decline   (never) → 204
//   POST  /profiles/:key/leave     (never) → 204
// Every refusal is in the words of the SHARING_MESSAGES constants. Each person's reads and changes have an anti-flood
// limit per minute (the overview polls every 10 s while busy, the switcher reads the profiles on every page).

/** Reads per person per minute (an anti-flood route limit). */
export const SHARING_READS_PER_MINUTE = 120;
/** Changes per person per minute (an anti-flood route limit; the day's invites are SHARING_INVITES_PER_DAY). */
export const SHARING_CHANGES_PER_MINUTE = 30;

function perPerson(name: string, limit: number): RequestHandler {
  return keyedRateLimit({
    windowMs: MINUTE_MS,
    limit,
    key: (req) => `${name}:${actorOf(req).id}`,
    message: (seconds) => `There have been too many sharing requests. ${waitSentence(seconds)}`,
  });
}

/**
 * A change to sharing is never made while the request names a shared profile (its policy is `never`; this repeats the
 * route guard's refusal, so it holds even before the guard decides).
 */
const ownProfileOnlyHere: RequestHandler = (req, _res, next) => {
  if (req.acting || req.actingCandidate) return next(ownProfileOnly());
  next();
};

/** The `:key` of a share A owns (a key not in form: the same 404 as an unknown one). */
function grantKeyOf(deps: AppDeps, req: Request): string {
  const key = req.params.key;
  if (!isProfileKey(key)) throw grantGone(deps);
  return key;
}

/** Mounted at /api/sharing. */
export function createSharingRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const readLimit = perPerson('sharing-read', SHARING_READS_PER_MINUTE);
  const changeLimit = perPerson('sharing-change', SHARING_CHANGES_PER_MINUTE);

  router.get('/profiles', readLimit, async (req, res) => {
    const body: SharedProfiles = await sharedProfiles(deps, actorOf(req));
    res.json(body);
  });

  router.get('/grants', readLimit, async (req, res) => {
    const body: SharingGrants = await listGrants(deps, actorOf(req).id);
    res.json(body);
  });

  router.get('/activity', readLimit, async (req, res) => {
    const query = parseInput(SharingActivityQuerySchema, req.query ?? {}, 'query');
    const body: SharingActivity = await activityOf(deps, actorOf(req).id, query);
    res.json(body);
  });

  router.get('/overview', readLimit, async (req, res) => {
    const body: SharingOverview = await overviewOf(deps, actorOf(req));
    res.json(body);
  });

  router.post('/grants', ownProfileOnlyHere, changeLimit, async (req, res) => {
    const input = parseInput(GrantCreateBodySchema, req.body ?? {}, 'invite');
    const body: GrantCreated = await createGrant(deps, actorOf(req), input);
    res.status(202).json(body);
  });

  router.patch('/grants/:key', ownProfileOnlyHere, changeLimit, async (req, res) => {
    const key = grantKeyOf(deps, req);
    const input = parseInput(GrantPatchBodySchema, req.body ?? {}, 'change');
    const body: GrantView = await changeGrant(deps, actorOf(req), key, input);
    res.json(body);
  });

  router.post('/grants/:key/stop', ownProfileOnlyHere, changeLimit, async (req, res) => {
    const key = grantKeyOf(deps, req);
    const input = parseInput(GrantStopBodySchema, req.body ?? {}, 'stop');
    await stopGrant(deps, actorOf(req), key, input);
    res.status(204).end();
  });

  router.post('/profiles/:key/accept', ownProfileOnlyHere, changeLimit, async (req, res) => {
    await acceptInvite(deps, actorOf(req), req.params.key ?? '');
    res.status(204).end();
  });

  router.post('/profiles/:key/decline', ownProfileOnlyHere, changeLimit, async (req, res) => {
    await declineInvite(deps, actorOf(req), req.params.key ?? '');
    res.status(204).end();
  });

  router.post('/profiles/:key/leave', ownProfileOnlyHere, changeLimit, async (req, res) => {
    await leaveProfile(deps, actorOf(req), req.params.key ?? '');
    res.status(204).end();
  });

  return router;
}
