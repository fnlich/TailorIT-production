import { randomBytes } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { AppError, sendError } from './errors';

/** Gives every request a short id, echoed in error bodies and the X-Request-Id header. */
export const requestId: RequestHandler = (req, res, next) => {
  req.requestId = `r_${randomBytes(6).toString('base64url')}`;
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** The Origin of a request from an extension's service worker (Chrome and Edge). */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/**
 * CSRF guard on top of the SameSite=Lax cookie: a browser sending a state-changing request must send the app's own
 * Origin. Requests without an Origin header (curl, server-to-server) carry no ambient browser cookies and pass.
 *
 * Two exceptions. A request with an extension token (core/auth/extension-tokens.ts) is not checked. A `cookieFree`
 * path (the extension's code exchange, which reads no cookie) accepts only an absent or chrome-extension:// Origin; its
 * route also carries extensionOriginOnly, because Express routes other spellings of the path there too.
 *
 * v34 ORIGIN (PLAN G7): `publicOrigin(req)`, when given, is the request's own public origin (config/public-origin.ts
 * publicOriginOf: APP_ORIGIN, or a trusted forwarded host such as a test tunnel's); an Origin equal to it is the app's
 * own page at that address and passes. Only that exact origin: a page at another host that a TRUSTED_PUBLIC_HOSTS
 * pattern also names (another tunnel) is refused, since the request's own forwarded host is not its host.
 *
 * v34 ORIGIN2 (PLAN G7b): `onRefused(req, origin)`, when given, hears each refusal of the ordinary check (the log's
 * note for a device opening TailorIT at an address no setting trusts: config/public-origin.ts refusedAddressNote).
 */
export function originCheck(
  appOrigin: string,
  options: {
    cookieFree?: readonly string[];
    publicOrigin?: (req: Request) => string;
    onRefused?: (req: Request, origin: string) => void; // v34 ORIGIN2
  } = {},
): RequestHandler {
  const allowed = new Set([appOrigin]);
  try {
    const url = new URL(appOrigin);
    // localhost and 127.0.0.1 are the same machine in development.
    if (url.hostname === 'localhost') allowed.add(`${url.protocol}//127.0.0.1${url.port ? `:${url.port}` : ''}`);
    if (url.hostname === '127.0.0.1') allowed.add(`${url.protocol}//localhost${url.port ? `:${url.port}` : ''}`);
  } catch {
    /* config validated elsewhere */
  }
  const cookieFree = new Set(options.cookieFree ?? []);
  return (req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    // A bearer token is not ambient: a page cannot make the browser attach it, so there is no forged request to stop.
    if (req.authVia === 'token') return next();
    const origin = req.get('origin');
    // A route that reads no cookie has nothing a forged request could borrow, and only the extension's worker calls
    // it: an absent or chrome-extension:// Origin passes, an http(s) or 'null' one is refused here, before the route's
    // rate limit counts it. The path is matched exactly and case-sensitively. Another spelling still routes there
    // (Express ignores case, a trailing slash and a doubled one) and gets the ordinary check below, which refuses a
    // foreign or an extension's Origin but passes the app's own: the route's extensionOriginOnly refuses that one.
    if (cookieFree.has(req.path)) {
      if (!origin || EXTENSION_ORIGIN.test(origin)) return next();
      return sendError(res, new AppError('bad_origin', 'Request not allowed.'), req.requestId);
    }
    if (!origin || allowed.has(origin)) return next();
    if (options.publicOrigin && origin === options.publicOrigin(req)) return next(); // v34 ORIGIN
    options.onRefused?.(req, origin); // v34 ORIGIN2
    sendError(res, new AppError('bad_origin', 'Request not allowed.'), req.requestId);
  };
}

/**
 * For a route only the extension's worker calls (its code exchange): an Origin, when one is sent, must be an
 * extension's, so no page can use the route, the app's own included, and a token does not change that. It sits on the
 * route, not in originCheck, so it holds on every spelling of the path Express routes there, and before the route's
 * rate limit, which never counts what it refuses.
 */
export const extensionOriginOnly: RequestHandler = (req, _res, next) => {
  const origin = req.get('origin');
  if (!origin || EXTENSION_ORIGIN.test(origin)) return next();
  next(new AppError('bad_origin', 'Request not allowed.'));
};

/** Never cache API answers in the browser or a proxy: they are per-account. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
