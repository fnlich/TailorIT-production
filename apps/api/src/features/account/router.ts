import { Router } from 'express';
import type { PublicConstantsResponse } from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { accountSummary } from './summary';

/** Mounted at /api/account (session): the account summary. */
export function createAccountRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/', async (req, res) => {
    res.json(await accountSummary(deps, userOf(req).id));
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
