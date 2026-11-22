import { Router, type Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit'; // v34 PUBLIC
import { MINUTE_MS, type PublicConstantsResponse } from '@tailorit/shared'; // v34 PUBLIC: MINUTE_MS
import { actorOf, requireUser, userOf } from '../../core/auth/guards'; // v34 PUBLIC: actorOf
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { keyedRateLimit } from '../../core/rate-limit'; // v34 PUBLIC
import { waitSentence } from '../autofill/auth'; // v34 PUBLIC
import { accountSummary } from './summary';

/**
 * Mounted at /api/account (session): the account summary. v33 SHARE-3 (PLAN-sharing §4 "Mixed routes"): a `self` route
 * (acting.ts), so it always answers for the signed-in person (B): B's plan, credit and features; while the request
 * names a profile shared with B that is live, the counts are that profile's (A's) and `profile` says whose. An ended,
 * unknown or foreign key reads as B's own (the guard adds the ended state header).
 */
export function createAccountRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/', async (req, res) => {
    const grant = req.acting === null ? (req.actingCandidate?.grant ?? null) : null; // v33 SHARE-3
    res.json(await accountSummary(deps, userOf(req).id, grant));
  });
  return router;
}

/** v34 PUBLIC: a signed-out answer of the public constants may be kept a minute by a browser or a shared cache. */
export const SIGNED_OUT_CACHE = 'public, max-age=60';

/** v34 PUBLIC: whether the request has a signed-in person (actorOf answers; it throws not_signed_in otherwise). */
function signedIn(req: Request): boolean {
  try {
    actorOf(req);
    return true;
  } catch {
    return false;
  }
}

/**
 * v34 PUBLIC (PLAN G8): a signed-out read of the public constants, PUBLIC_PAGE_READS_PER_MINUTE per network address
 * (req.ip, which `trust proxy` takes from the front proxy's X-Forwarded-For; through Next's development rewrite every
 * caller is this machine, so it acts as one limit for all). A signed-in read is not counted, as before.
 */
function signedOutReads(deps: AppDeps) {
  return keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: () => constantsOf(deps).get('PUBLIC_PAGE_READS_PER_MINUTE'),
    key: (req) => `public-constants:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    skip: signedIn,
    message: (seconds) => `There have been too many page reads from your network. ${waitSentence(seconds)}`,
  });
}

/**
 * Mounted at /api/constants: GET /public, the constants the web shows before any request (limits, the reset time, the
 * contact email, every message). Never a budget, a price or a server-capacity value: the spec's `public` flag decides,
 * and the constants' own test keeps those out. v34 PUBLIC (PLAN G8): signed out too, for the pages anyone may read
 * (/guide, /privacy, /terms, /support: the operator's name, the retention days, the plans' limits), limited per network
 * address while signed out (signedOutReads). Before v3.4 it needed a session, so a public page's read sent the browser
 * to sign in.
 */
export function createPublicConstantsRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/public', signedOutReads(deps), (req, res) => {
    const constants = constantsOf(deps);
    const body: PublicConstantsResponse = { version: constants.version(), values: constants.publicValues() };
    // v34 PUBLIC (the review's finding 8): a signed-out answer is the same for everyone, so a browser or a CDN may keep it
    // a minute (fewer reads count toward the per-address limit); a signed-in one stays no-store, as every API answer.
    if (!signedIn(req)) res.setHeader('Cache-Control', SIGNED_OUT_CACHE);
    res.json(body);
  });
  return router;
}
