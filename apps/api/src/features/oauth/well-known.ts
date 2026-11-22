import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import {
  OAUTH_DOCUMENT_PATHS,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_SCOPE_MCP,
  OAUTH_SCOPES,
  OAUTH_SERVER_METADATA_PATH,
} from '@tailorit/shared/oauth';
import { publicOriginOf } from '../../config/public-origin'; // v34 ORIGIN
import type { AppDeps } from '../../core/context';
import { oauthAddresses } from './addresses';
import { OAuthError, sendOAuthError } from './errors';
import { perAddress } from './limits';

// v3.1 OAUTH: the discovery documents, mounted early at /.well-known (no cookie, no session).
// - The MCP endpoint's metadata (RFC 9728) at /.well-known/oauth-protected-resource and at the path form
//   /.well-known/oauth-protected-resource/mcp (the MCP spec's first try): `resource` is the MCP endpoint exactly as a
//   person gives it to Claude, `authorization_servers` TailorIT itself (Claude uses the first only), the scope `mcp`.
// - The authorization server's metadata (RFC 8414) at /.well-known/oauth-authorization-server: PKCE S256 only, public
//   clients (`none`) only, Client ID Metadata Documents and registration both (Claude uses a document only when both
//   `client_id_metadata_document_supported` and `none` are listed), `iss` on every authorization response (RFC 9207:
//   ChatGPT then uses its stable callback), and `offline_access` among the scopes (Claude asks for it to get a refresh
//   token; TailorIT gives one either way).
// v34 ORIGIN (PLAN G7, G8):
// - Both are built for the request's public origin (config/public-origin.ts: APP_ORIGIN, or a trusted test tunnel's
//   forwarded host), never from the Host header. So the answer depends on X-Forwarded-Host: it is kept privately only
//   (`private`), and Vary names the forwarded headers.
// - They link the public guide, privacy policy and terms (OAUTH_DOCUMENT_PATHS, on the same origin).
// - Read-only CORS: any page may read them (GET, HEAD and their preflight; no credentials), so browser-based inspectors
//   work. The MCP endpoint itself stays server to server (no CORS there). Only at an https public origin (production,
//   a tunnel): a plain-http TailorIT on this computer or a LAN stays unreadable to other sites (review, security 6).

/** Whether a request came through an https public origin (the read-only CORS headers apply). */
type HttpsOf = (req: Request) => boolean;

/** Discovery documents may be kept a few minutes (Claude keeps them about 5), by the asker only (v34 ORIGIN). */
const DISCOVERY_CACHE = 'private, max-age=300';
/** v34 ORIGIN: what the documents depend on besides their path. */
const DISCOVERY_VARY = 'X-Forwarded-Host, X-Forwarded-Proto';
/** A preflight's requested headers, as a header name list (anything else is not echoed). */
const HEADER_LIST = /^[A-Za-z0-9-]+(?:\s*,\s*[A-Za-z0-9-]+)*$/;

/**
 * v34 ORIGIN: read-only CORS on every /.well-known answer at an https public origin; a preflight is answered here (204).
 */
const readOnlyCors = (isHttps: HttpsOf): RequestHandler => (req, res, next) => {
  if (!isHttps(req)) return next();
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Helmet's same-origin resource policy is for the app's own answers; these are public documents.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method !== 'OPTIONS') return next();
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  const asked = req.get('access-control-request-headers')?.trim();
  if (asked && asked.length <= 500 && HEADER_LIST.test(asked)) res.setHeader('Access-Control-Allow-Headers', asked);
  res.setHeader('Access-Control-Max-Age', '600');
  res.status(204).end();
};

export function createWellKnownRouter(deps: AppDeps): Router {
  const router = Router();
  const addresses = (req: Request) => oauthAddresses(deps.config, publicOriginOf(deps.config, req)); // v34 ORIGIN
  // v34 ORIGIN: before the limit, so a 429 is readable too; a preflight is answered there and then.
  router.use(readOnlyCors((req) => publicOriginOf(deps.config, req).startsWith('https://')));
  router.use(perAddress(deps, 'discovery'));

  const cacheHeaders = (res: Response) => {
    res.setHeader('Cache-Control', DISCOVERY_CACHE);
    res.setHeader('Vary', DISCOVERY_VARY);
  };

  const resourceMetadata: RequestHandler = (req, res) => {
    const a = addresses(req);
    cacheHeaders(res);
    res.json({
      resource: a.resource,
      authorization_servers: [a.issuer],
      scopes_supported: [OAUTH_SCOPE_MCP],
      bearer_methods_supported: ['header'],
      resource_name: 'TailorIT',
      // v34 ORIGIN (PLAN G8): the public pages, on the issuer's origin.
      resource_documentation: `${a.issuer}${OAUTH_DOCUMENT_PATHS.guide}`,
      resource_policy_uri: `${a.issuer}${OAUTH_DOCUMENT_PATHS.privacy}`,
      resource_tos_uri: `${a.issuer}${OAUTH_DOCUMENT_PATHS.terms}`,
    });
  };
  // Express strips the mount (/.well-known): the paths here start after it.
  const prefix = OAUTH_PROTECTED_RESOURCE_PATH.replace('/.well-known', '');
  router.get(prefix, resourceMetadata);
  router.get(`${prefix}/*`, (req, res, next) => {
    if (!addresses(req).resourceMetadataPaths.includes(`/.well-known${req.path}`)) return next();
    resourceMetadata(req, res, next);
  });

  router.get(OAUTH_SERVER_METADATA_PATH.replace('/.well-known', ''), (req, res) => {
    const a = addresses(req);
    cacheHeaders(res);
    res.json({
      issuer: a.issuer,
      authorization_endpoint: a.authorizationEndpoint,
      token_endpoint: a.tokenEndpoint,
      registration_endpoint: a.registrationEndpoint,
      revocation_endpoint: a.revocationEndpoint,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...OAUTH_SCOPES],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      // v34 ORIGIN (PLAN G8): the public pages (RFC 8414 §2).
      service_documentation: `${a.issuer}${OAUTH_DOCUMENT_PATHS.guide}`,
      op_policy_uri: `${a.issuer}${OAUTH_DOCUMENT_PATHS.privacy}`,
      op_tos_uri: `${a.issuer}${OAUTH_DOCUMENT_PATHS.terms}`,
    });
  });

  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof OAuthError) return sendOAuthError(res, err);
    deps.log.error('[oauth] a discovery request failed', err instanceof Error ? err.name : 'unknown');
    sendOAuthError(res, new OAuthError('server_error', 'something went wrong', { status: 500 }));
  };
  router.use(errors);
  return router;
}
