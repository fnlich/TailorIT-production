import { OAUTH_PATHS, OAUTH_PROTECTED_RESOURCE_PATH, OAUTH_SERVER_METADATA_PATH } from '@tailorit/shared/oauth';
import type { AppConfig } from '../../config/env';

// v3.1 OAUTH: the authorization server's and the protected resource's addresses, from the configuration alone (never
// from a request's Host header, which a client chooses). The issuer is APP_ORIGIN, the address people open: Next's
// dev rewrites and the production reverse proxy pass /oauth/... and /.well-known/oauth-... on to the API. The protected
// resource is the MCP endpoint, config.mcp.endpoint (MCP_PUBLIC_URL, else APP_ORIGIN/mcp): the exact address a person
// gives Claude or ChatGPT, and the audience every access token is bound to (RFC 8707).

export interface OAuthAddresses {
  /** APP_ORIGIN, no trailing slash: the `iss` of every authorization response (RFC 9207). */
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

export function oauthAddresses(config: Pick<AppConfig, 'appOrigin' | 'mcp'>): OAuthAddresses {
  const issuer = config.appOrigin.replace(/\/+$/, '');
  const resource = canonicalOf(config.mcp.endpoint) ?? config.mcp.endpoint;
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
 * names none gets the MCP endpoint, the one resource TailorIT protects.
 */
export function resourceOf(addresses: OAuthAddresses, named: string | undefined): string | null {
  if (named === undefined) return addresses.resource;
  const canonical = canonicalOf(named);
  if (canonical === null) return null;
  if (canonical === addresses.resource) return addresses.resource;
  if (canonical === new URL(addresses.resource).origin) return addresses.resource;
  return null;
}
