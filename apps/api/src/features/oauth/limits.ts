import { createHash } from 'node:crypto';
import { BlockList } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitInfo } from 'express-rate-limit';
import { MINUTE_MS } from '@tailorit/shared';
import { parseIpRanges } from '../../config/addresses';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { OAuthError } from './errors';

// v3.1 OAUTH: the OAuth endpoints' rate limits, each read from its constant at every request (an admin's change applies
// at once). Counters live in memory, per process (core/rate-limit.ts's reasoning).
// - OAUTH_CALLS_PER_MINUTE per network address on every endpoint and metadata document. The address is req.ip: the
//   production reverse proxy routes these paths to the API itself and says who called (TRUST_PROXY, app.ts); through
//   Next's development rewrite every caller is this machine, so it acts as one limit for all.
// - OAUTH_REGISTRATIONS_PER_HOUR for registrations per network address, and OAUTH_REGISTRATIONS_PER_HOUR_ALL for all
//   callers together (v31 FIX-AUTH, SEC-6: it was all together alone, so strangers could spend Claude's turn).
// - OAUTH_TOKEN_CALLS_PER_MINUTE at the token endpoint per code or refresh token (v34 ORIGIN: it was per client id, but
//   every person who connects Claude sends the same one, https://claude.ai/oauth/mcp-oauth-client-metadata).
// - Client documents (cimd.ts): OAUTH_CIMD_FETCHES_PER_MINUTE per network address and OAUTH_CIMD_FETCHES_PER_MINUTE_ALL
//   for all callers together, the known apps' own documents outside the latter.
// v34 ORIGIN (PLAN G8): an address in OAUTH_SHARED_EGRESS_RANGES (Claude's servers, 160.79.104.0/21 by default) calls
// for many people at once: it gets OAUTH_SHARED_EGRESS_CALLS_PER_MINUTE instead of OAUTH_CALLS_PER_MINUTE, and the MCP
// endpoint's failed-token count MCP_FAILED_TOKENS_PER_MINUTE_SHARED (features/mcp/endpoint.ts). Registrations keep
// OAUTH_REGISTRATIONS_PER_HOUR per address there too (Claude's apps use their client document, never /oauth/register).
// The address is req.ip: through the web server, any of its clients can name one (X-Forwarded-For passes unchanged).

type LimitKey =
  | 'OAUTH_CALLS_PER_MINUTE'
  | 'OAUTH_REGISTRATIONS_PER_HOUR'
  | 'OAUTH_REGISTRATIONS_PER_HOUR_ALL'
  | 'OAUTH_TOKEN_CALLS_PER_MINUTE'
  | 'OAUTH_SHARED_EGRESS_CALLS_PER_MINUTE';

type LimitDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/**
 * One limiter: refuses with OAuth's temporarily_unavailable (429, Retry-After). v34 ORIGIN: `sharedKey`, when given, is
 * the limit of a caller whose address is in a shared egress range.
 */
export function oauthLimit(
  deps: LimitDeps,
  options: { name: string; windowMs: number; key: LimitKey; sharedKey?: LimitKey; by: (req: Request) => string },
): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: (req: Request) =>
      constantsOf(deps).get(options.sharedKey && isSharedEgress(deps, req.ip) ? options.sharedKey : options.key),
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
 * (TRUST_PROXY, app.ts; loopback by default) takes from X-Forwarded-For only when the request came through a trusted
 * proxy: the production reverse proxy (Caddy replaces any X-Forwarded-For a client sends with the caller's own address),
 * straight or through Next's rewrite, which passes the header on unchanged (it adds none). An IPv6 caller is keyed by
 * its /56 network (one household or server holds many addresses of it), an IPv4-mapped one by its IPv4 address. Without
 * a front proxy (development) every caller is this machine.
 */
export const addressOf = (req: Request): string => ipKeyGenerator(req.ip ?? 'unknown');

/** OAUTH_CALLS_PER_MINUTE per network address (OAUTH_SHARED_EGRESS_CALLS_PER_MINUTE in a shared egress range). */
export function perAddress(deps: LimitDeps, name: string): RequestHandler {
  return oauthLimit(deps, {
    name,
    windowMs: MINUTE_MS,
    key: 'OAUTH_CALLS_PER_MINUTE',
    sharedKey: 'OAUTH_SHARED_EGRESS_CALLS_PER_MINUTE',
    by: addressOf,
  });
}

// v34 ORIGIN
/** OAUTH_SHARED_EGRESS_RANGES as a BlockList, made again only when the constant's text changes. */
let egressCache: { text: string; list: BlockList } | null = null;

function egressList(text: string): BlockList {
  if (egressCache?.text === text) return egressCache.list;
  const list = new BlockList();
  const parsed = parseIpRanges(text);
  // config/env.ts refuses a bad .env value at start; the constant is .env only, so an error here is none in practice.
  for (const range of 'ranges' in parsed ? parsed.ranges : []) list.addSubnet(range.address, range.prefix, range.family);
  egressCache = { text, list };
  return list;
}

/** Whether `ip` (req.ip; an IPv4-mapped IPv6 address as its IPv4 one) is in OAUTH_SHARED_EGRESS_RANGES. */
export function isSharedEgress(deps: Pick<AppDeps, 'services' | 'config' | 'db' | 'log' | 'now'>, ip: string | undefined): boolean {
  if (!ip) return false;
  const address = ip.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  const family = /^\d+\.\d+\.\d+\.\d+$/.test(address) ? 'ipv4' : address.includes(':') ? 'ipv6' : null;
  if (family === null) return false;
  try {
    return egressList(constantsOf(deps).get('OAUTH_SHARED_EGRESS_RANGES')).check(address, family);
  } catch {
    return false;
  }
}

/**
 * The token endpoint's limit key (v34 ORIGIN): the code or refresh token the request presents (its SHA-256's first 32
 * hex characters, never the secret), so each connection has its own budget whatever client id it shares; a request
 * with neither is keyed by its caller's address.
 */
export function tokenRequestKey(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const secret = body.grant_type === 'refresh_token' ? body.refresh_token : body.code;
  if (typeof secret === 'string' && secret.length > 0 && secret.length <= 500) {
    return `secret:${createHash('sha256').update(secret).digest('hex').slice(0, 32)}`;
  }
  return `address:${addressOf(req)}`;
}
// end v34 ORIGIN
