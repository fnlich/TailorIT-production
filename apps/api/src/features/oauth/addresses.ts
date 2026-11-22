import { MCP_PATH } from '@tailorit/shared/mcp';
import { OAUTH_PATHS, OAUTH_PROTECTED_RESOURCE_PATH, OAUTH_SERVER_METADATA_PATH } from '@tailorit/shared/oauth';
import type { AppConfig } from '../../config/env';

// v3.1 OAUTH: the authorization server's and the protected resource's addresses. The issuer is the address people
// open: Next's dev rewrites and the production reverse proxy pass /oauth/... and /.well-known/oauth-... on to the API.
// The protected resource is the MCP endpoint: the exact address a person gives Claude or ChatGPT, and the audience every
// access token is bound to (RFC 8707).
// v34 ORIGIN (PLAN G7): both follow the request's public origin (config/public-origin.ts publicOriginOf): APP_ORIGIN,
// or a trusted forwarded host (a test tunnel's), never the Host header a client chooses. The resource is
// <origin>/mcp unless MCP_PUBLIC_URL is set (then it alone, from any origin). One request's addresses all come from the
// same origin; authorize.ts keeps the issuer and the resource on the request it stores, and a token for one address
// never works at another (strict audience equality).

export interface OAuthAddresses {
  /** The request's public origin, no trailing slash: the `iss` of every authorization response (RFC 9207). */
  issuer: string;
  /** The MCP endpoint, canonical: what tokens are issued for. */
  resource: string;
  /** Where the MCP endpoint's metadata is (its origin, the well-known path, then the endpoint's own path). */
  resourceMetadataUrl: string;
  /** The well-known paths that answer the protected resource's metadata on the API (the root one and the path one). */
  resourceMetadataPaths: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
  /** The web's consent page. */
  consentPage: string;
  serverMetadataUrl: string;
}

/** A resource address in RFC 8707's canonical form (lower-case scheme and host, no fragment, no trailing slash). */
function canonicalOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hash || url.username || url.password || url.search) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * The addresses for a request whose public origin is `origin` (publicOriginOf; APP_ORIGIN when left out, for code
 * that answers no request).
 */
export function oauthAddresses(config: Pick<AppConfig, 'appOrigin' | 'mcp'>, origin: string = config.appOrigin): OAuthAddresses {
  const issuer = origin.replace(/\/+$/, '');
  const endpoint = config.mcp.publicUrl ?? `${issuer}${MCP_PATH}`; // v34 ORIGIN
  const resource = canonicalOf(endpoint) ?? endpoint;
  const resourceUrl = new URL(resource);
  const path = resourceUrl.pathname === '/' ? '' : resourceUrl.pathname;
  return {
    issuer,
    resource,
    resourceMetadataUrl: `${resourceUrl.origin}${OAUTH_PROTECTED_RESOURCE_PATH}${path}`,
    resourceMetadataPaths: [...new Set([OAUTH_PROTECTED_RESOURCE_PATH, `${OAUTH_PROTECTED_RESOURCE_PATH}${path}`])],
    authorizationEndpoint: `${issuer}${OAUTH_PATHS.authorize}`,
    tokenEndpoint: `${issuer}${OAUTH_PATHS.token}`,
    registrationEndpoint: `${issuer}${OAUTH_PATHS.register}`,
    revocationEndpoint: `${issuer}${OAUTH_PATHS.revoke}`,
    consentPage: `${issuer}${OAUTH_PATHS.consent}`,
    serverMetadataUrl: `${issuer}${OAUTH_SERVER_METADATA_PATH}`,
  };
}

/**
 * The resource a client names (RFC 8707 `resource`), as TailorIT issues tokens for it: the MCP endpoint, given as it
 * is, or as its bare origin (a client that names the server, not its path); null for any other address. A client that
 * names none gets the MCP endpoint, the one resource TailorIT protects. v34 ORIGIN: `addresses` may be a stored
 * request's or grant's resource alone ({resource}).
 */
export function resourceOf(addresses: Pick<OAuthAddresses, 'resource'>, named: string | undefined): string | null {
  if (named === undefined) return addresses.resource;
  const canonical = canonicalOf(named);
  if (canonical === null) return null;
  if (canonical === addresses.resource) return addresses.resource;
  if (canonical === new URL(addresses.resource).origin) return addresses.resource;
  return null;
}
