import { Router, type Request } from 'express';
import type { AppDeps } from '../../core/context';
import { fixedCodeUsable } from '../../core/auth/fixed-code'; // v34 FIX-API
import { clearSessionCookie, destroySession, hashSessionToken, readSessionToken } from '../../core/auth/session';
import { getAccount } from '../../core/auth/users';
import { asyncHandler } from '../../core/http/errors';
import { signInRateLimit } from '../../core/rate-limit';
import { completeSignIn, requestEmailCode, signInOptions, verifyEmailCode, verifyGoogleCredential } from './service';

// Passwordless sign-in (Google + email code) and sessions. Owned by work package F3 (see docs/ARCHITECTURE.md).

/** A string field of the JSON body, or '' (a missing or odd value gets the same sentence as an empty one). */
function bodyText(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

/** Mounted at /api/auth. */
export function createAuthRouter(deps: AppDeps): Router {
  const router = Router();
  // Per-address limits plus a global backstop (an array of middleware; Express flattens it).
  const limited = signInRateLimit(deps);

  router.get('/options', (_req, res) => {
    res.json(signInOptions(deps));
  });

  router.post(
    '/email/request',
    ...limited,
    asyncHandler(async (req, res) => {
      res.json(await requestEmailCode(deps, bodyText(req, 'email')));
    }),
  );

  router.post('/email/verify', ...limited, async (req, res) => {
    // v34 FIX-API (the final security review, F1): the fixed code only from this computer (or the test servers' opt-in).
    const identity = await verifyEmailCode(deps, bodyText(req, 'email'), bodyText(req, 'code'), fixedCodeUsable(deps, req));
    res.json(await completeSignIn(deps, req, res, identity));
  });

  router.post(
    '/google',
    ...limited,
    asyncHandler(async (req, res) => {
      const identity = await verifyGoogleCredential(deps, bodyText(req, 'credential'));
      res.json(await completeSignIn(deps, req, res, identity));
    }),
  );

  // Always 200: every page asks this on load, and being signed out is an answer, not an error.
  router.get('/me', async (req, res) => {
    res.json({ account: req.user ? await getAccount(deps, req.user.id) : null });
  });

  // Not behind requireUser: logging out with a token the server already forgot must still clear the cookie.
  router.post('/logout', async (req, res) => {
    const token = readSessionToken(req);
    const tokenHash = req.sessionTokenHash ?? (token ? hashSessionToken(token) : null);
    if (tokenHash) await destroySession(deps, tokenHash);
    clearSessionCookie(req, res, deps);
    res.json({ ok: true });
  });

  return router;
}
