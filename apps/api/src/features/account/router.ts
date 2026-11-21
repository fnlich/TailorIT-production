import { Router } from 'express';
import type { PublicConstantsResponse } from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
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

/**
 * Mounted at /api/constants (session): GET /public, the constants the web shows before any request (limits, the reset
 * time, the contact email, every message). Never a budget, a price or a server-capacity value: the spec's `public`
 * flag decides, and the constants' own test keeps those out.
 */
export function createPublicConstantsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/public', (_req, res) => {
    const constants = constantsOf(deps);
    const body: PublicConstantsResponse = { version: constants.version(), values: constants.publicValues() };
    res.json(body);
  });
  return router;
}
