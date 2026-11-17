import { isIPv4, isIPv6 } from 'node:net';
import { MCP_PATH, mcpEndpointUrl } from '@tailorit/shared/mcp';

// The API's addresses, from .env (config/env.ts reads them): where it listens (API_HOST, API_PORT), the MCP endpoint's
// address that Settings shows (MCP_PUBLIC_URL), and the names /mcp answers to (features/mcp/endpoint.ts). Pure, so each
// rule has a test (test/addresses.test.ts). apps/web/src/lib/addresses.ts reads API_HOST the same way for the web's
// way to the API, and scripts/next-launch.mjs maps WEB_HOST's localhost the same way: change them together.

/** The names of this machine, as a Host header or a URL's hostname writes them. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;
/** Addresses that mean "every network interface": a server listens there, nobody opens one. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/**
 * API_HOST, MCP_ALLOWED_HOSTS: an IPv4 address, an IPv6 address (with or without brackets) or a host name, in lower
 * case with an IPv6 address unbracketed ("::1"); null for anything else (a URL, a port, a path, a space).
 */
export function parseHost(value: string): string | null {
  const text = value.trim().toLowerCase();
  const bare = /^\[.*\]$/.test(text) ? text.slice(1, -1) : text;
  if (isIPv6(bare)) return bare;
  if (bare !== text) return null;
  if (isIPv4(text) || HOST_NAME.test(text)) return text;
  return null;
}

/** Whether `host` (as parseHost returns it) means every network interface: 0.0.0.0 or ::. */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

/** Whether `host` (as parseHost returns it) is this machine only: localhost, 127.x.x.x or ::1. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || (isIPv4(host) && host.startsWith('127.'));
}

/** `host` as a URL or a Host header writes it: an IPv6 address in brackets. */
export function urlHost(host: string): string {
  return isIPv6(host) ? `[${host}]` : host;
}

/**
 * The address the API listens on, from API_HOST. localhost is 127.0.0.1: Node listens on a name's first address only,
 * ::1 on Windows, which would leave http://127.0.0.1:<port> (the web's way to the API) refused.
 */
export function apiBindHost(apiHost: string): string {
  return apiHost === 'localhost' ? '127.0.0.1' : apiHost;
}

/**
 * The address a client on this machine dials for a server bound to `host`: the wildcard addresses (0.0.0.0, ::) and
 * localhost as 127.0.0.1, anything else as it is, in URL form.
 */
export function dialHost(host: string): string {
  if (isWildcardHost(host) || host === 'localhost') return '127.0.0.1';
  return urlHost(host);
}

/** The MCP endpoint's address when MCP_PUBLIC_URL is unset: http://<API_HOST>:<API_PORT>/mcp, dialable. */
export function defaultMcpEndpoint(apiHost: string, apiPort: number): string {
  return mcpEndpointUrl(apiPort, dialHost(apiHost));
}

/**
 * MCP_PUBLIC_URL: an http(s) address with no user, query or fragment. A bare origin gets /mcp; a trailing slash goes.
 * Returns the address, or a sentence saying what is wrong.
 */
export function parseMcpPublicUrl(value: string): { url: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: 'is not an address: write it as http://host:port/mcp' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'must start with http:// or https://' };
  if (url.username || url.password || url.search || url.hash) {
    return { error: 'must be a plain address, with no user, password, ? or #' };
  }
  const path = url.pathname === '/' ? MCP_PATH : url.pathname.replace(/\/+$/, '');
  return { url: `${url.origin}${path}` };
}

/**
 * APP_ORIGIN: an http(s) origin (scheme, host and port: no user, path, query or fragment), as browsers send it in
 * their Origin header (lower case, no default port). Returns it, or a sentence saying what is wrong.
 */
export function parseAppOrigin(value: string): { origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: 'is not an address: write it as http://host:port, such as http://localhost:3100' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'must start with http:// or https://' };
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return { error: 'must be the address people open, scheme, host and port only (such as http://192.168.1.20:3100)' };
  }
  return { origin: url.origin };
}

/**
 * The names /mcp answers to, in its Host and Origin checks (a DNS rebinding defence, features/mcp/endpoint.ts): this
 * machine's (LOOPBACK_HOSTS), API_HOST, MCP_PUBLIC_URL's host and MCP_ALLOWED_HOSTS, never a wildcard address. In
 * URL form (an IPv6 address in brackets), lower case, each once.
 */
export function mcpAllowedHosts(apiHost: string, endpoint: string, extra: readonly string[]): string[] {
  const names = new Set<string>(LOOPBACK_HOSTS);
  for (const host of [apiHost, ...extra]) if (!isWildcardHost(host)) names.add(urlHost(host));
  const endpointHost = new URL(endpoint).hostname.toLowerCase();
  if (!isWildcardHost(endpointHost.replace(/^\[(.*)\]$/, '$1'))) names.add(endpointHost);
  return [...names];
}
