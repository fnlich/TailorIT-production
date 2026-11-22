import cookieParser from 'cookie-parser';
import express, { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { HOUR_MS, MINUTE_MS } from '@tailorit/shared';
import { OAUTH_PATHS } from '@tailorit/shared/oauth';
import { publicOriginOf } from '../../config/public-origin'; // v34 ORIGIN
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { oauthAddresses } from './addresses';
import { authorize, BROWSER_COOKIE, SECRET_PATTERN, withParams } from './authorize';
import { registerClient } from './clients';
import { OAuthError, sendOAuthError, single } from './errors';
import { exchangeCode, refreshTokens, revokeToken } from './exchange';
import { addressOf, oauthLimit, perAddress, tokenRequestKey } from './limits';
import { newOAuthSecret } from './tokens';

// v3.1 OAUTH: the authorization server's endpoints, mounted early at /oauth (before the app's cookie, bearer, JSON body
// and Origin middleware: none of them is a session route, and each reads its own body):
//   GET  /oauth/authorize   authorize.ts; sets the browser binding cookie, then a redirect (302)
//   POST /oauth/register    Dynamic Client Registration (JSON, at most REGISTRATION_BODY_LIMIT)
//   POST /oauth/token       authorization_code | refresh_token (form-urlencoded as RFC 6749 says; JSON tolerated)
//   POST /oauth/revoke      RFC 7009
// The SDK's own auth router is not used: it is built on Express 5 and the API runs Express 4 (map-mcp.md §6).
// Every answer is no-store. Nothing here logs a token, a code, a verifier or a cookie.

/** The largest body of a registration, a token or a revoke request. */
export const REGISTRATION_BODY_LIMIT = '16kb';

/** Strip the mount (/oauth) from a path of OAUTH_PATHS. */
const local = (path: string) => path.replace(/^\/oauth/, '');

export function createOAuthEndpointsRouter(deps: AppDeps): Router {
  const router = Router();
  /** v34 ORIGIN: the request's public origin (APP_ORIGIN, or a trusted forwarded host: config/public-origin.ts). */
  const originOf = (req: Request) => publicOriginOf(deps.config, req);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  router.use(perAddress(deps, 'endpoints'));
  const formOrJson = [
    express.urlencoded({ extended: false, limit: REGISTRATION_BODY_LIMIT, parameterLimit: 50 }),
    express.json({ limit: REGISTRATION_BODY_LIMIT }),
  ];

  // --------------------------------------------------------------------------------------------------- authorize
  router.get(local(OAUTH_PATHS.authorize), cookieParser(), async (req: Request, res: Response) => {
    const present = (req.cookies as Record<string, unknown> | undefined)?.[BROWSER_COOKIE];
    const browserSecret = typeof present === 'string' && SECRET_PATTERN.test(present) ? present : newOAuthSecret();
    // v31 FIX-AUTH: the caller's address; v34 ORIGIN: the request's public origin (the issuer and resource it binds).
    const outcome = await authorize(deps, req.query as Record<string, unknown>, browserSecret, addressOf(req), originOf(req));
    if (outcome.kind === 'consent') {
      res.cookie(BROWSER_COOKIE, browserSecret, {
        httpOnly: true,
        sameSite: 'lax',
        // v34 ORIGIN2 (the review's finding 5): Secure when the request's public origin is https (an exact address's
        // fixed scheme, never X-Forwarded-Proto), as the session cookie (core/auth/session.ts secureCookieAt).
        secure: originOf(req).startsWith('https:'),
        path: '/',
        maxAge: constantsOf(deps).get('OAUTH_REQUEST_MINUTES') * MINUTE_MS,
      });
    }
    res.redirect(302, outcome.location);
  });

  // ---------------------------------------------------------------------------------------------------- register
  // v31 FIX-AUTH (SEC-6): OAUTH_REGISTRATIONS_PER_HOUR per caller address, so strangers cannot spend Claude's and
  // ChatGPT's turn, under a much higher ceiling for all callers together (OAUTH_REGISTRATIONS_PER_HOUR_ALL).
  // v34 ORIGIN (review, security 4): the same per address in a shared egress range too: Claude's apps read their client
  // document and never register, and one address there must not spend the whole ceiling.
  router.post(
    local(OAUTH_PATHS.register),
    oauthLimit(deps, { name: 'register', windowMs: HOUR_MS, key: 'OAUTH_REGISTRATIONS_PER_HOUR', by: addressOf }),
    oauthLimit(deps, { name: 'register-all', windowMs: HOUR_MS, key: 'OAUTH_REGISTRATIONS_PER_HOUR_ALL', by: () => 'all' }),
    express.json({ limit: REGISTRATION_BODY_LIMIT }),
    async (req, res) => {
      const answer = await registerClient(deps, req.body);
      deps.log.debug('[oauth] a client registered');
      res.status(201).json(answer);
    },
  );

  // ------------------------------------------------------------------------------------------------------- token
  // v34 ORIGIN (PLAN G8): per code or refresh token, not per client id (every person's Claude sends the same one).
  const perGrant = oauthLimit(deps, { name: 'token', windowMs: MINUTE_MS, key: 'OAUTH_TOKEN_CALLS_PER_MINUTE', by: tokenRequestKey });
  router.post(local(OAUTH_PATHS.token), ...formOrJson, perGrant, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = single(body.grant_type, 'grant_type');
    if (grantType === 'authorization_code') return res.json(await exchangeCode(deps, body, originOf(req)));
    if (grantType === 'refresh_token') return res.json(await refreshTokens(deps, body, originOf(req)));
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });

  // ------------------------------------------------------------------------------------------------------ revoke
  router.post(local(OAUTH_PATHS.revoke), ...formOrJson, async (req, res) => {
    await revokeToken(deps, (req.body ?? {}) as Record<string, unknown>);
    res.status(200).end();
  });

  router.use((_req, _res, next) => next(new OAuthError('invalid_request', 'not an OAuth endpoint', { status: 404 })));

  const errors: ErrorRequestHandler = (err, req, res, _next) => {
    const isAuthorize = req.method === 'GET' && req.path === local(OAUTH_PATHS.authorize);
    let error: OAuthError;
    if (err instanceof OAuthError) error = err;
    else if (err?.type === 'entity.too.large') error = new OAuthError('invalid_request', 'the request is too large', { status: 413 });
    else if (err?.type === 'entity.parse.failed' || err?.status === 400) error = new OAuthError('invalid_request', 'the body could not be read');
    else {
      deps.log.error('[oauth] a request failed', err instanceof Error ? err.name : 'unknown');
      error = new OAuthError('server_error', 'something went wrong', { status: 500 });
    }
    // A browser at /oauth/authorize gets TailorIT's page, never a JSON body.
    if (isAuthorize) {
      const page = error.error === 'temporarily_unavailable' ? 'temporarily_unavailable' : 'invalid_request';
      return res.redirect(302, withParams(oauthAddresses(deps.config, originOf(req)).consentPage, { error: page }));
    }
    sendOAuthError(res, error);
  };
  router.use(errors);
  return router;
}
