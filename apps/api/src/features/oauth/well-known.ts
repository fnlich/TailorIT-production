import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { OAUTH_PROTECTED_RESOURCE_PATH, OAUTH_SCOPE_MCP, OAUTH_SCOPES, OAUTH_SERVER_METADATA_PATH } from '@tailorit/shared/oauth';
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
// Both are built from the configuration only, never from the request's Host.

/** Discovery documents may be kept a few minutes (Claude keeps them about 5). */
const DISCOVERY_CACHE = 'public, max-age=300';

export function createWellKnownRouter(deps: AppDeps): Router {
  const router = Router();
  const addresses = () => oauthAddresses(deps.config);
  router.use(perAddress(deps, 'discovery'));

  const resourceMetadata: RequestHandler = (_req, res) => {
    const a = addresses();
    res.setHeader('Cache-Control', DISCOVERY_CACHE);
    res.json({
      resource: a.resource,
      authorization_servers: [a.issuer],
      scopes_supported: [OAUTH_SCOPE_MCP],
      bearer_methods_supported: ['header'],
      resource_name: 'TailorIT',
    });
  };
  // Express strips the mount (/.well-known): the paths here start after it.
  const prefix = OAUTH_PROTECTED_RESOURCE_PATH.replace('/.well-known', '');
  router.get(prefix, resourceMetadata);
  router.get(`${prefix}/*`, (req, res, next) => {
    if (!addresses().resourceMetadataPaths.includes(`/.well-known${req.path}`)) return next();
    resourceMetadata(req, res, next);
  });

  router.get(OAUTH_SERVER_METADATA_PATH.replace('/.well-known', ''), (_req, res) => {
    const a = addresses();
    res.setHeader('Cache-Control', DISCOVERY_CACHE);
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
