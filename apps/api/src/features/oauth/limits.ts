import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitInfo } from 'express-rate-limit';
import { MINUTE_MS } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { OAuthError } from './errors';

// v3.1 OAUTH: the OAuth endpoints' rate limits, each read from its constant at every request (an admin's change applies
// at once). Counters live in memory, per process (core/rate-limit.ts's reasoning).
// - OAUTH_CALLS_PER_MINUTE per network address on every endpoint and metadata document. The address is req.ip: the
//   production reverse proxy routes these paths to the API itself and says who called (trust proxy: loopback); through
//   Next's development rewrite every caller is this machine, so it acts as one limit for all.
// - OAUTH_REGISTRATIONS_PER_HOUR for registrations per network address, and OAUTH_REGISTRATIONS_PER_HOUR_ALL for all
//   callers together (v31 FIX-AUTH, SEC-6: it was all together alone, so strangers could spend Claude's turn).
// - OAUTH_TOKEN_CALLS_PER_MINUTE per client id at the token endpoint.
// - Client documents (cimd.ts): OAUTH_CIMD_FETCHES_PER_MINUTE per network address and OAUTH_CIMD_FETCHES_PER_MINUTE_ALL
//   for all callers together, the known apps' own documents outside the latter.

type LimitKey = 'OAUTH_CALLS_PER_MINUTE' | 'OAUTH_REGISTRATIONS_PER_HOUR' | 'OAUTH_REGISTRATIONS_PER_HOUR_ALL' | 'OAUTH_TOKEN_CALLS_PER_MINUTE';

/** One limiter: refuses with OAuth's temporarily_unavailable (429, Retry-After). */
export function oauthLimit(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  options: { name: string; windowMs: number; key: LimitKey; by: (req: Request) => string },
): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: () => constantsOf(deps).get(options.key),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => `oauth:${options.name}:${options.by(req)}`,
    handler: (req, _res, next) => {
      const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
      const untilReset = info?.resetTime ? info.resetTime.getTime() - Date.now() : options.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil(untilReset / 1000));
      next(new OAuthError('temporarily_unavailable', 'rate limited: retry after Retry-After seconds', { status: 429, retryAfterSeconds }));
    },
  });
}

/**
 * The caller's network address, as the limits key it (v31 FIX-AUTH, SEC-4/SEC-6): req.ip, which `trust proxy`
 * (loopback, app.ts) takes from X-Forwarded-For only when the request came through this machine: the production reverse
 * proxy (Caddy replaces any X-Forwarded-For a client sends with the caller's own address), straight or through Next's
 * rewrite, which passes the header on unchanged (it adds none). An IPv6 caller is keyed by its /56 network (one
 * household or server holds many addresses of it), an IPv4-mapped one by its IPv4 address. Without a front proxy
 * (development) every caller is this machine.
 */
export const addressOf = (req: Request): string => ipKeyGenerator(req.ip ?? 'unknown');

/** OAUTH_CALLS_PER_MINUTE per network address. */
export function perAddress(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, name: string): RequestHandler {
  return oauthLimit(deps, { name, windowMs: MINUTE_MS, key: 'OAUTH_CALLS_PER_MINUTE', by: addressOf });
}
