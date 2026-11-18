import { Router, type Request, type RequestHandler } from 'express';
import { IdParam, MINUTE_MS } from '@tailorit/shared';
import { OAuthConsentBodySchema } from '@tailorit/shared/oauth';
import { requireUser, userOf } from '../../core/auth/guards';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { forbidden, notFound } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { waitSentence } from '../autofill/auth';
import { BROWSER_COOKIE, SECRET_PATTERN } from './authorize';
import { decide, requestView } from './consent';
import { listGrants, revokeGrantOf } from './grants';

// v3.1 OAUTH: the web's routes, mounted at /api/oauth, the session only (an extension token never reaches them:
// tokenScope answers 403 first, and so does sessionOnly). The app's Origin check (originCheck) guards the writes
// against other sites, and the consent's request must be the browser's own (its `ti_oauth` cookie).
//   GET    /requests/:id   → OAuthRequestView (the consent page)
//   POST   /consent        {request, decision} → OAuthConsentAnswer {redirectTo}
//   GET    /grants         → OAuthGrantList (Integrations: the connected AI apps)
//   DELETE /grants/:id     → 204; 404 for another account's grant or one revoked already
// Each is limited per account (OAUTH_CALLS_PER_MINUTE).

const sessionOnly: RequestHandler = (req, _res, next) => {
  if (req.authVia === 'token') return next(forbidden('Connect AI apps on the Integrations page.'));
  next();
};

/** The browser binding cookie's value, when it is one of ours. */
function browserSecretOf(req: Request): string | null {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[BROWSER_COOKIE];
  return typeof value === 'string' && SECRET_PATTERN.test(value) ? value : null;
}

const RequestIdParam = OAuthConsentBodySchema.shape.request;

export function createOAuthRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser, sessionOnly);
  router.use(
    keyedRateLimit({
      windowMs: MINUTE_MS,
      limit: () => constantsOf(deps).get('OAUTH_CALLS_PER_MINUTE'),
      key: (req) => `oauth-web:${userOf(req).id}`,
      message: (seconds) => `${constantsOf(deps).message('MSG_OAUTH_RATE_LIMIT')} ${waitSentence(seconds)}`,
    }),
  );

  router.get('/requests/:id', async (req, res) => {
    const id = RequestIdParam.safeParse(req.params.id);
    if (!id.success) throw notFound('That connection request');
    res.json(await requestView(deps, id.data, browserSecretOf(req)));
  });

  router.post('/consent', async (req, res) => {
    const body = parseInput(OAuthConsentBodySchema, req.body ?? {}, 'answer');
    res.json(await decide(deps, userOf(req).id, body, browserSecretOf(req)));
  });

  router.get('/grants', async (req, res) => {
    res.json(await listGrants(deps, userOf(req).id));
  });

  router.delete('/grants/:id', async (req, res) => {
    const grantId = parseInput(IdParam, req.params.id, 'connection');
    if (!(await revokeGrantOf(deps, userOf(req).id, grantId))) throw notFound('That connection');
    deps.log.info(`[oauth] account ${userOf(req).id} disconnected grant ${grantId}`);
    res.status(204).end();
  });

  return router;
}
