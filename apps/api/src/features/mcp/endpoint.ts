import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { rateLimit, type RateLimitInfo } from 'express-rate-limit';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { assertFeature } from '../../core/accounts/entitlements';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { keyedRateLimit } from '../../core/rate-limit';
import { waitSentence } from '../autofill/auth';
import type { PrepareAdapter } from './prepare';
import { createMcpServer } from './server';
import { presentedMcpToken, resolveMcpToken, type McpCaller } from './tokens';
import { MINUTE_MS } from '@tailorit/shared';

// TailorIT's MCP endpoint (v1.5 M): Streamable HTTP at /mcp on the API (by default http://127.0.0.1:4100/mcp), in the
// SDK's stateless mode with JSON answers: each POST gets its own server and transport, built for the account its token
// names (server.ts), and GET and DELETE (a standalone stream, ending a session) answer 405, as the SDK's stateless
// example does. It is mounted before the app's cookie, bearer, body and Origin middleware (app.ts's early routes): it
// reads no cookie, and a session or an extension token (tia_) is no credential here. In order, for every request:
// 1. Host: a name the API answers to (config.mcp.allowedHosts: localhost, 127.0.0.1 and [::1], and from .env API_HOST,
//    MCP_PUBLIC_URL's host and MCP_ALLOWED_HOSTS; config/addresses.ts), any port. Any other name is a DNS rebinding (a
//    page of another site resolved to this machine): 403.
// 2. Origin: none (an MCP client is no browser), or a page at one of those names; any other is a page elsewhere: 403.
//    A refused Host or Origin never reaches the token check.
// 3. The token: `Authorization: Bearer tim_...`, live and its account enabled; otherwise 401 with WWW-Authenticate.
//    Refusals of every caller together are limited (REFUSALS_PER_MINUTE), so nothing can hash guesses fast. v2.0 P5:
//    the scope `prepare` (a stored v1.5 `prebuild` reads as it, tokens.ts), then the account's plan must include MCP
//    (assertFeature 'mcp', FREE_MCP / PAID_MCP): 403 with the plan's message otherwise.
// 4. Per token: the constants MCP_CALLS_PER_MINUTE (120) a minute and MCP_CALLS_PER_HOUR (2,000) an hour, read per
//    request so an admin's change applies at once (429 with Retry-After).
// 5. The body: JSON of at most MCP_BODY_LIMIT (413 past it), and a tool call's arguments at most MAX_TOOL_INPUT_ELEMENTS
//    elements (server.ts).
// Nothing logs a tool's input or answer: the endpoint logs refusals by kind, server.ts the tool and the account.

// v2.0 FIX-C (REQ-11): a token's requests a minute and an hour are the constants MCP_CALLS_PER_MINUTE and
// MCP_CALLS_PER_HOUR alone (02-constants.md: they replaced v1.5's MCP_PER_MINUTE and MCP_PER_HOUR, no longer here).
/** Refused credentials a minute, every caller together. */
export const REFUSALS_PER_MINUTE = 60;
/** The largest request body. */
export const MCP_BODY_LIMIT = '1mb';
const MCP_BODY_BYTES = 1024 * 1024;

/** A JSON-RPC error answer (what MCP clients read), with its HTTP status. */
function refuse(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** The hostname of a Host header ("localhost:4100", "[::1]:4100"), lower case. */
function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0] ?? '';
}

/** The refusal of a Host the API does not answer to. */
export const UNKNOWN_HOST_MESSAGE =
  'TailorIT\'s MCP server does not answer at this address. It answers at localhost and 127.0.0.1, and at the ' +
  'addresses TailorIT\'s .env names: API_HOST, MCP_PUBLIC_URL and MCP_ALLOWED_HOSTS.';

/**
 * Steps 1 and 2: the request is addressed to one of `allowedHosts` (config.mcp.allowedHosts: lower case, an IPv6
 * address in brackets), from no page or a page at one of them.
 */
export function knownAddressOnly(allowedHosts: readonly string[]): RequestHandler {
  const names = new Set(allowedHosts);
  return (req, res, next) => {
    if (!names.has(hostnameOf(req.get('host') ?? ''))) return refuse(res, 403, -32000, UNKNOWN_HOST_MESSAGE);
    const origin = req.get('origin');
    if (origin !== undefined) {
      let known = false;
      try {
        const url = new URL(origin);
        known = (url.protocol === 'http:' || url.protocol === 'https:') && names.has(url.hostname.toLowerCase());
      } catch {
        known = false;
      }
      if (!known) return refuse(res, 403, -32000, 'Requests from web pages are not allowed.');
    }
    next();
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    /** The MCP token behind a request to /mcp (features/mcp). */
    mcpCaller?: McpCaller;
  }
}

const callerOf = (req: Request): McpCaller => req.mcpCaller!;

export function createMcpEndpoint(deps: AppDeps, prepare: PrepareAdapter, version: string): Router {
  const router = Router();
  const refusals = keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: REFUSALS_PER_MINUTE,
    key: () => 'mcp-refused',
    message: (seconds) => `There have been too many requests with a wrong MCP token. ${waitSentence(seconds)}`,
    counts: (_req, status) => status === 401,
  });
  /** keyedRateLimit's limiter, with the limit read from the constants at each request. */
  const perToken = (windowMs: number, key: 'MCP_CALLS_PER_MINUTE' | 'MCP_CALLS_PER_HOUR') =>
    rateLimit({
      windowMs,
      limit: () => constantsOf(deps).get(key),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      validate: false,
      keyGenerator: (req) => `mcp:${key}:${callerOf(req).tokenId}`,
      handler: (req, _res, next) => {
        const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
        const untilReset = info?.resetTime ? info.resetTime.getTime() - Date.now() : windowMs;
        const retryAfterSeconds = Math.max(1, Math.ceil(untilReset / 1000));
        next(
          // v2.0 FIX-C (REQ-3): the words are MSG_MCP_RATE_LIMIT; the wait after them, as before.
          new AppError('rate_limited', `${constantsOf(deps).message('MSG_MCP_RATE_LIMIT')} ${waitSentence(retryAfterSeconds)}`, {
            retryAfterSeconds,
          }),
        );
      },
    });

  /** Step 3. */
  const authenticate: RequestHandler = async (req, res, next) => {
    const token = presentedMcpToken(req.get('authorization'));
    let caller: McpCaller | null = null;
    try {
      caller = token ? await resolveMcpToken(deps, token) : null;
    } catch (error) {
      deps.log.error('[mcp] could not read an MCP token', error instanceof Error ? error.name : 'unknown');
      return refuse(res, 500, -32603, 'Something went wrong on TailorIT\'s side. Try again.');
    }
    if (!caller || !caller.scopes.includes('prepare')) {
      deps.log.debug(`[mcp] refused a request: ${token ? 'a token that does not work' : 'no token'}`);
      res.setHeader('WWW-Authenticate', 'Bearer realm="tailorit", error="invalid_token"');
      return refuse(
        res,
        401,
        -32001,
        'This needs a TailorIT MCP token that works: make one in TailorIT\'s Settings › Integrations › Your own AI (MCP).',
      );
    }
    // v2.0 P5: the plan's MCP access, read per request (an admin's change applies to the next one).
    try {
      await assertFeature(deps, caller.user.id, 'mcp');
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) {
        deps.log.error("[mcp] could not read an account's plan", error instanceof Error ? error.name : 'unknown');
        return refuse(res, 500, -32603, "Something went wrong on TailorIT's side. Try again.");
      }
      deps.log.debug(`[mcp] account ${caller.user.id}: refused (${error.code})`);
      return refuse(res, 403, -32001, error.message);
    }
    req.mcpCaller = caller;
    next();
  };

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(
    knownAddressOnly(deps.config.mcp.allowedHosts),
    refusals,
    authenticate,
    perToken(MINUTE_MS, 'MCP_CALLS_PER_MINUTE'),
    perToken(60 * MINUTE_MS, 'MCP_CALLS_PER_HOUR'),
  );

  router.post('/', express.json({ limit: MCP_BODY_LIMIT, strict: false }), async (req, res) => {
    const caller = callerOf(req);
    let server: McpServer | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MCP_BODY_BYTES,
    });
    res.on('close', () => {
      void transport.close();
      void server?.close();
    });
    try {
      // v3.0 D2: the server's instructions read the person's settings, so it is built by an async call.
      server = await createMcpServer(deps, caller.user.id, prepare, version, caller.tokenId); // v1.5 Q2: tokenId
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      deps.log.error('[mcp] a request failed', error instanceof Error ? error.name : 'unknown');
      refuse(res, 500, -32603, 'Something went wrong on TailorIT\'s side. Try again.');
    }
  });

  const notAllowed: RequestHandler = (_req, res) => {
    res.setHeader('Allow', 'POST');
    refuse(res, 405, -32000, 'Method not allowed: TailorIT\'s MCP server is stateless; send POST.');
  };
  router.get('/', notAllowed);
  router.delete('/', notAllowed);
  router.all('/', notAllowed);

  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (err?.type === 'entity.too.large' || status === 413) return refuse(res, 413, -32600, 'That request is too large.');
    if (err?.type === 'entity.parse.failed') return refuse(res, 400, -32700, 'Parse error: the body is not JSON.');
    if (err?.code === 'rate_limited') {
      if (err.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return refuse(res, 429, -32000, err.message);
    }
    if (status >= 400 && status < 500) return refuse(res, status, -32600, 'The request is not valid.');
    deps.log.error('[mcp] a request failed', err instanceof Error ? err.name : 'unknown');
    refuse(res, 500, -32603, 'Something went wrong on TailorIT\'s side. Try again.');
  };
  router.use(errors);
  return router;
}
