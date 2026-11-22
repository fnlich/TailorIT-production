import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { MCP_PATH } from '@tailorit/shared/mcp';

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

/**
 * The MCP endpoint's address when MCP_PUBLIC_URL is unset. v31 OAUTH: APP_ORIGIN/mcp, the address people open (it was
 * http://<API_HOST>:<API_PORT>/mcp): Claude and ChatGPT connect there, as the web's rewrite and the reverse proxy pass
 * /mcp on to the API, and it is the resource OAuth tokens are issued for (features/oauth).
 */
export function defaultMcpEndpoint(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, '')}${MCP_PATH}`;
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

// ── v34 ORIGIN (PLAN G7, G8): the public addresses a request may come through, the proxies trusted, shared ranges ──

/**
 * One TRUSTED_PUBLIC_HOSTS entry: a host name or an IPv4 address (`tailorit.example`), or `*.` and a name of two
 * labels or more (`*.trycloudflare.com`: any ONE label before it), each with an optional `:port`; or (v34 ORIGIN2,
 * PLAN G7b) one exact address written with its scheme (`http://192.168.1.20:3100`, `https://tailorit.example`).
 */
export interface HostPattern {
  /** As written, lower case (an exact address: its origin). */
  text: string;
  /** `*.` patterns: exactly one label before `host`. */
  wildcard: boolean;
  /** The host name (for a wildcard, the part after `*.`; for an exact address, its URL host name: IPv6 in brackets). */
  host: string;
  /** The port a host must name; null: none (the scheme's default port). */
  port: number | null;
  /**
   * v34 ORIGIN2: set for an entry written with its scheme: the one origin it is (scheme, host and port all fixed by
   * the entry; X-Forwarded-Proto never changes it). Absent for a host or a pattern (their scheme is forwarded).
   */
  origin?: string;
}

/** TRUSTED_PUBLIC_HOSTS when blank, outside production: Cloudflare's quick tunnels (cloudflared tunnel --url ...). */
export const DEFAULT_TRUSTED_PUBLIC_HOSTS = ['*.trycloudflare.com'] as const;
/** TRUSTED_PUBLIC_HOSTS's word for "trust no forwarded host", in every mode. */
export const NO_TRUSTED_PUBLIC_HOSTS = 'none';

const PORT_SUFFIX = /^(.*):(\d{1,5})$/;
const LABEL_ONLY = new RegExp(`^${LABEL}$`);

/** "host:port" as its parts; null when the port is no port (0, past 65535). An unbracketed IPv6 address has no port. */
function splitPort(text: string): { host: string; port: number | null } | null {
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    const rest = text.slice(end + 1);
    if (rest === '') return { host: text.slice(0, end + 1), port: null };
    const port = /^:(\d{1,5})$/.exec(rest);
    if (!port || Number(port[1]) < 1 || Number(port[1]) > 65_535) return null;
    return { host: text.slice(0, end + 1), port: Number(port[1]) };
  }
  if (isIPv6(text)) return { host: text, port: null };
  const match = PORT_SUFFIX.exec(text);
  if (!match) return { host: text, port: null };
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  return { host: match[1]!, port };
}

/**
 * The second-level labels many country domains sell names under (co.uk, com.au, ne.jp, gov.br ...): `*.` before one of
 * them with a two-letter country label would trust a whole public suffix (review, security 7). Not the Public Suffix
 * List: a cheap guard against the obvious ones; SETUP says a pattern is for names you own or a provider domain on it.
 */
const SECOND_LEVEL_SUFFIXES = new Set(['ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'ltd', 'mil', 'ne', 'net', 'nic', 'or', 'org', 'plc', 'sch']);

/**
 * One TRUSTED_PUBLIC_HOSTS entry, parsed (HostPattern); null for anything else (a path, `*`, `*.com`, `*.co.uk`, a
 * pattern with a scheme, a name on the internet over http). parseTrustedHost says why.
 */
export function parseHostPattern(value: string): HostPattern | null {
  const parsed = parseTrustedHost(value);
  return 'entry' in parsed ? parsed.entry : null;
}

/** What TRUSTED_PUBLIC_HOSTS's error says an entry may be. */
const ENTRY_FORMS =
  'write a host or a pattern such as tailorit.example or *.trycloudflare.com, or an address with its scheme such as http://192.168.1.20:3100';

/** One TRUSTED_PUBLIC_HOSTS entry, parsed, or a sentence (after the entry's text) saying what is wrong with it. */
export function parseTrustedHost(value: string): { entry: HostPattern } | { error: string } {
  const text = value.trim().toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (scheme) return parseExactOrigin(scheme[1]!, scheme[2]!);
  const pattern = parsePattern(text);
  return pattern ? { entry: pattern } : { error: `is not a host or a pattern: ${ENTRY_FORMS}, with no path` };
}

// v34 ORIGIN2 (PLAN G7b; the coordinator's decision): plain http in an exact address only where it cannot be a name
// anyone on the internet answers for. An IP address, written as itself, is the network's own (the owner's address is
// in no private range, so a private-range rule would refuse the very case G7b is for; the start warning says to check
// that it cannot be reached from the internet); localhost and one-word names resolve on this computer or the local
// network only; .local (mDNS), .lan, .home.arpa (RFC 8375) and .internal are local networks' own suffixes. Any other
// name is a DNS name: over http, every network between the browser and TailorIT could read the sign-in code and the
// session cookie, or answer for the name itself, so it needs https.
const LOCAL_NETWORK_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal'];

/** Whether an exact address at `host` (a URL host name, IPv6 in brackets) may be plain http. */
export function plainHttpAllowed(host: string): boolean {
  if (host.startsWith('[') || isIPv4(host)) return true;
  if (!host.includes('.')) return true; // localhost, or one word: a name of this computer or the local network
  return LOCAL_NETWORK_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** An exact address (`http://host:port`): its scheme, host and port, nothing else (a lone trailing slash goes). */
function parseExactOrigin(scheme: string, rest: string): { entry: HostPattern } | { error: string } {
  if (scheme !== 'http' && scheme !== 'https') return { error: `must start with http:// or https://, or ${ENTRY_FORMS}` };
  const address = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  if (address.startsWith('*')) {
    return { error: 'is a pattern with a scheme: write a pattern without http:// or https:// (*.trycloudflare.com), or one exact address' };
  }
  if (address === '' || /[/?#@\\\s]/.test(address)) {
    return { error: 'must be the address people open, scheme, host and port only (such as http://192.168.1.20:3100): no path, user, ? or #' };
  }
  const parts = splitPort(address);
  if (!parts) return { error: 'names a port that is no port: write one from 1 to 65535' };
  const bracketed = parts.host.startsWith('[');
  const known = bracketed
    ? isIPv6(parts.host.slice(1, -1))
    : isIPv4(parts.host) || (HOST_NAME.test(parts.host) && !/(?:^|\.)\d+$/.test(parts.host));
  if (!known) return { error: `is not an address: ${ENTRY_FORMS} (an IPv6 address in brackets)` };
  let url: URL;
  try {
    url = new URL(`${scheme}://${address}`);
  } catch {
    return { error: `is not an address: ${ENTRY_FORMS}` };
  }
  // The URL parser writes IPv6 in its short form; anything else it would rewrite is no address people type.
  if (!bracketed && url.hostname !== parts.host) return { error: `is not an address: ${ENTRY_FORMS}` };
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') {
    return {
      error:
        "is where a server listens, not an address people open: write this computer's address on your network (such as http://192.168.1.20:3100)",
    };
  }
  if (scheme === 'http' && !plainHttpAllowed(url.hostname)) {
    return {
      error:
        'is a name on the internet over plain http: write https:// (http:// is for an IP address, localhost, a one-word name or a ' +
        "local network's name ending .local, .lan, .home.arpa or .internal)",
    };
  }
  return { entry: { text: url.origin, wildcard: false, host: url.hostname, port: url.port ? Number(url.port) : null, origin: url.origin } };
}

/**
 * v34 ORIGIN2: the exact address among `entries` that a forwarded `hostname` with `port` (null: none written) is: the
 * same host and the same port, the entry's scheme's own port written out counting as none. Null when none is. Each
 * entry is one address: another port, the other scheme or another host never matches.
 */
export function exactOriginFor(entries: readonly HostPattern[], hostname: string, port: number | null): string | null {
  for (const entry of entries) {
    if (entry.origin === undefined || entry.host !== hostname) continue;
    const own = entry.origin.startsWith('https:') ? 443 : 80;
    if ((port === own ? null : port) === entry.port) return entry.origin;
  }
  return null;
}

/**
 * v34 ORIGIN2: whether two exact addresses share a Host header (the same host, and a port both answer to: http://x and
 * https://x are both `Host: x`). The forwarded scheme is never believed for them, so the two could never be told
 * apart: TRUSTED_PUBLIC_HOSTS refuses the pair at start.
 */
export function sameHostHeader(a: HostPattern, b: HostPattern): boolean {
  if (a.origin === undefined || b.origin === undefined || a.host !== b.host) return false;
  const ports = (entry: HostPattern) => (entry.port === null ? [null, entry.origin!.startsWith('https:') ? 443 : 80] : [entry.port]);
  const theirs = ports(b);
  return ports(a).some((port) => theirs.includes(port));
}

/**
 * v34 ORIGIN2 (the ORIGIN2 review, finding 9): APP_ORIGIN (as parseAppOrigin returns it) in an exact entry's form, so
 * sameHostHeader can compare TRUSTED_PUBLIC_HOSTS's exact addresses with it.
 */
export function appOriginEntry(appOrigin: string): HostPattern {
  const url = new URL(appOrigin);
  return { text: url.origin, wildcard: false, host: url.hostname, port: url.port ? Number(url.port) : null, origin: url.origin };
}

// v34 ORIGIN2 (the ORIGIN2 review, finding 3): which plain-http exact addresses could be on the internet. A private
// network's addresses: RFC 1918, carrier-grade NAT (RFC 6598), link-local and loopback; IPv6 unique local (fc00::/7),
// link-local (fe80::/10) and loopback. Anything else written as an IP address may be reachable from the internet.
const PRIVATE_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['127.0.0.0', 8],
] as const) {
  PRIVATE_NETWORKS.addSubnet(network, prefix, 'ipv4');
}
PRIVATE_NETWORKS.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_NETWORKS.addSubnet('fe80::', 10, 'ipv6');
PRIVATE_NETWORKS.addAddress('::1', 'ipv6');

/**
 * Whether `host` (a URL host name: IPv6 in brackets) is an IP address outside a private network's ranges (it may be
 * reachable from the internet). A name is not one: TRUSTED_PUBLIC_HOSTS allows plain http only for local names
 * (plainHttpAllowed). An IPv4 address mapped into IPv6 (::ffff:c0a8:114) is judged as IPv4: Node's BlockList checks it
 * against the IPv4 ranges.
 */
export function isPublicIpHost(host: string): boolean {
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIPv4(bare)) return !PRIVATE_NETWORKS.check(bare, 'ipv4');
  return isIPv6(bare) && !PRIVATE_NETWORKS.check(bare, 'ipv6');
}

/** A host or a `*.` pattern with an optional port (no scheme), parsed; null for anything else. */
function parsePattern(text: string): HostPattern | null {
  const parts = splitPort(text);
  if (!parts) return null;
  const wildcard = parts.host.startsWith('*.');
  const host = wildcard ? parts.host.slice(2) : parts.host;
  if (wildcard) {
    // A name of two labels at least after `*.`: never `*.com`, which would trust a whole top-level domain, nor a
    // country's second level (`*.co.uk`).
    if (isIPv4(host) || !HOST_NAME.test(host) || !host.includes('.')) return null;
    const labels = host.split('.');
    if (labels.length === 2 && labels[1]!.length === 2 && SECOND_LEVEL_SUFFIXES.has(labels[0]!)) return null;
  } else if (!(isIPv4(host) || HOST_NAME.test(host))) {
    return null;
  }
  return { text, wildcard, host, port: parts.port };
}

/**
 * Whether `hostname` (lower case) with `port` (null: none) is one `pattern` names. Never an exact address (v34
 * ORIGIN2: exactOriginFor matches those, with their own scheme).
 */
export function hostMatches(pattern: HostPattern, hostname: string, port: number | null): boolean {
  if (pattern.origin !== undefined) return false;
  if (pattern.port !== port) return false;
  if (!pattern.wildcard) return hostname === pattern.host;
  if (!hostname.endsWith(`.${pattern.host}`)) return false;
  return LABEL_ONLY.test(hostname.slice(0, -pattern.host.length - 1));
}

/**
 * A forwarded host (X-Forwarded-Host): its first value, lower case, as its host name and port; null when it is no host
 * (a path, a user, a space, a bad port). An IPv6 address keeps its brackets.
 */
export function parseForwardedHost(value: string | undefined): { hostname: string; port: number | null } | null {
  const first = (value ?? '').split(',')[0]!.trim().toLowerCase();
  if (first === '' || first.length > 260 || !/^[a-z0-9.:[\]-]+$/.test(first)) return null;
  const parts = splitPort(first);
  if (!parts) return null;
  const host = parts.host;
  if (host.startsWith('[')) return isIPv6(host.slice(1, -1)) ? { hostname: host, port: parts.port } : null;
  if (!(isIPv4(host) || HOST_NAME.test(host))) return null;
  return { hostname: host, port: parts.port };
}

/** Express's `trust proxy` setting, as TRUST_PROXY gives it. */
export type TrustProxySetting = string | number | false;
export const DEFAULT_TRUST_PROXY = 'loopback';
const TRUST_PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * TRUST_PROXY: which front proxies Express believes about the caller's address and scheme (X-Forwarded-For,
 * X-Forwarded-Proto), as Express's `trust proxy` setting takes it. Blank: `loopback` (Next's rewrite, Caddy on this
 * machine). `none` or `false`: no proxy. A whole number: that many proxies in front (a cloud load balancer: 1). Else a
 * comma separated list of `loopback`, `linklocal`, `uniquelocal`, IP addresses and ranges (10.0.0.0/8). `true` (every
 * proxy, so any caller could name any address) is refused. Returns the setting, or a sentence saying what is wrong.
 * (The public origin's X-Forwarded-Host is believed from a loopback peer only, whatever this says: public-origin.ts.)
 */
export function parseTrustProxy(value: string | undefined): { value: TrustProxySetting } | { error: string } {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '') return { value: DEFAULT_TRUST_PROXY };
  if (text === 'none' || text === 'false' || text === '0') return { value: false };
  if (text === 'true' || text === 'all' || text === '*') {
    return { error: 'would trust every proxy, so any caller could name any address: write loopback, a number of proxies or their addresses' };
  }
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops > 10) return { error: 'is more proxies than any setup has: write a number from 1 to 10' };
    return { value: hops };
  }
  const items = text.split(/[\s,]+/).filter(Boolean);
  for (const item of items) {
    if (TRUST_PROXY_NAMES.has(item)) continue;
    if (parseIpRange(item) === null) {
      return { error: `"${item}" is not loopback, linklocal, uniquelocal, an IP address or a range such as 10.0.0.0/8` };
    }
  }
  return { value: items.join(',') };
}

/** An IP range: its address, prefix length and family (a single address has the full prefix). */
export interface IpRange {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** An IP address or range (`160.79.104.0/21`, `2001:db8::/32`, `10.0.0.5`), parsed; null for anything else. */
export function parseIpRange(value: string): IpRange | null {
  const [address = '', bits, extra] = value.trim().toLowerCase().split('/');
  if (extra !== undefined) return null;
  const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
  if (family === null) return null;
  const max = family === 'ipv4' ? 32 : 128;
  if (bits === undefined) return { address, prefix: max, family };
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return null;
  return { address, prefix: Number(bits), family };
}

/**
 * OAUTH_SHARED_EGRESS_RANGES: comma or space separated IP ranges. Returns them, or a sentence naming the first entry
 * that is no range.
 */
export function parseIpRanges(text: string): { ranges: IpRange[] } | { error: string } {
  const ranges: IpRange[] = [];
  for (const item of text.split(/[\s,]+/).filter(Boolean)) {
    const range = parseIpRange(item);
    if (range === null) return { error: `"${item}" is not an IP range such as 160.79.104.0/21` };
    ranges.push(range);
  }
  return { ranges };
}
// ── end v34 ORIGIN ──
