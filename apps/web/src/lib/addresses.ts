// The web server's addresses from the root .env: where it reaches the API (proxy.ts and next.config.ts's /api rewrite)
// and the hosts `next dev` serves its own scripts and hot reload to (next.config.ts allowedDevOrigins). No imports:
// next.config.ts loads this file before Next compiles anything. apps/api/src/config/addresses.ts holds the API's side of
// the same rules (API_HOST's localhost and wildcard addresses dial 127.0.0.1); change the two together.

type Env = Readonly<Record<string, string | undefined>>;

/** Addresses that mean "every network interface": a server listens there, nobody opens one. */
const WILDCARD = new Set(['0.0.0.0', '::', '[::]']);

/** `host` (API_HOST, WEB_HOST) as a URL writes it, lower case: an IPv6 address in brackets; null when blank. */
function urlHost(host: string | undefined): string | null {
  const value = (host ?? '').trim().toLowerCase();
  if (!value) return null;
  const bare = value.replace(/^\[(.*)\]$/, '$1');
  return bare.includes(':') ? `[${bare}]` : bare;
}

/**
 * Where the web server reaches the API: API_INTERNAL_URL when set, else http://<API_HOST>:<API_PORT>, with API_HOST's
 * default (127.0.0.1), localhost and the wildcard addresses (0.0.0.0, ::) dialled as 127.0.0.1.
 */
export function apiOrigin(env: Env): string {
  const internal = env.API_INTERNAL_URL?.trim();
  if (internal) return internal.replace(/\/+$/, '');
  const host = urlHost(env.API_HOST);
  const dial = host === null || host === 'localhost' || WILDCARD.has(host) ? '127.0.0.1' : host;
  return `http://${dial}:${env.API_PORT?.trim() || '4100'}`;
}

/**
 * next.config.ts allowedDevOrigins: the hosts whose pages `next dev` serves its scripts and hot reload to. Next 16
 * compares a request's Origin (or Referer) host name with these, without the port. This computer's names, WEB_HOST
 * (unless it is a wildcard address), APP_ORIGIN's host, (v34 ORIGIN) DEV_ALLOWED_ORIGINS's exact host names and (v34
 * ORIGIN2) the hosts of TRUSTED_PUBLIC_HOSTS's exact addresses (exactAddressHosts), each once. Never a `*.` pattern (the ORIGIN security review, finding 2: `*.trycloudflare.com` here would let every
 * stranger's quick-tunnel page read the dev server's scripts and listen to its hot reload). A page opened through a test
 * tunnel needs nothing here (its scripts are same-origin loads); only hot reload over the tunnel needs its exact host.
 */
export function allowedDevOrigins(env: Env): string[] {
  const names = new Set(['localhost', '127.0.0.1']);
  const webHost = urlHost(env.WEB_HOST);
  if (webHost !== null && !WILDCARD.has(webHost)) names.add(webHost);
  try {
    names.add(new URL(env.APP_ORIGIN?.trim() || 'http://localhost:3100').hostname.toLowerCase());
  } catch {
    /* the API refuses a bad APP_ORIGIN at its start, with a sentence saying why */
  }
  for (const host of devAllowedHosts(env)) names.add(host);
  for (const host of exactAddressHosts(env)) names.add(host); // v34 ORIGIN2
  return [...names];
}

// v34 ORIGIN (PLAN G7; review, security 2)
/** A host name (no `*`, no scheme, no path), lower case. */
const EXACT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * DEV_ALLOWED_ORIGINS: more exact host names (comma or space separated, a port is dropped) whose pages `next dev` serves
 * hot reload to, development only. Patterns and anything that is no host name are left out. v34 INT-2: the dev guard
 * (scripts/dev-guard.mjs) refuses a tunnel's socket whatever is listed here; what is left is an exact TRUSTED_PUBLIC_HOSTS
 * address written as a name (`http://box.lan:3100`: list `box.lan`), which exactAddressHosts leaves out.
 */
export function devAllowedHosts(env: Env): string[] {
  return [
    ...new Set(
      (env.DEV_ALLOWED_ORIGINS ?? '')
        .toLowerCase()
        .split(/[\s,]+/)
        .map((item) => item.replace(/:\d{1,5}$/, ''))
        .filter((item) => EXACT_HOST.test(item)),
    ),
  ];
}
// end v34 ORIGIN

// v34 ORIGIN2 (PLAN G7b)
/** A dotted IPv4 address (the URL parser has already written it canonically). */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** A host name of one label or more, or a dotted IPv4 address (no `*`, no scheme, no path), lower case. */
const ADDRESS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** An entry written with its scheme: http(s)://, a host (an IPv6 address in brackets), an optional port, a lone `/`. */
const EXACT_ADDRESS = /^https?:\/\/(\[[0-9a-f:.]+\]|[^/:[\]@?#*\\]+)(?::\d{1,5})?\/?$/;

/**
 * The hosts of TRUSTED_PUBLIC_HOSTS's exact addresses (the entries written with their scheme, such as
 * http://192.168.1.20:3100, a LAN address another device opens directly) that are IP addresses or localhost, as Next
 * compares them: lower case, an IPv6 address in brackets, without the port. Such a page's scripts are same-origin loads,
 * but its hot reload socket needs its host here, or next dev reloads the page after about 40 seconds of refused
 * reconnects. The ORIGIN2 review, finding 7: Next compares host names only, so a name here (a one-word, .local or .lan
 * name, which any device on the network can answer for by LLMNR or mDNS) would give that device's pages next dev's
 * scripts and hot reload: an exact name works without hot reload. Patterns, entries without a scheme and anything that
 * is no address are left out: the API's config/addresses.ts parseTrustedHost is the full rule (it refuses a wrong entry
 * at its start); this reads only what that rule accepts. The dev guard (scripts/dev-guard.mjs) keeps next dev's tools
 * to this computer whatever is listed here.
 */
export function exactAddressHosts(env: Env): string[] {
  const hosts = new Set<string>();
  for (const item of (env.TRUSTED_PUBLIC_HOSTS ?? '').toLowerCase().split(/[\s,]+/)) {
    const match = EXACT_ADDRESS.exec(item);
    if (!match) continue;
    let hostname: string;
    try {
      hostname = new URL(item).hostname;
    } catch {
      continue;
    }
    // The URL parser writes IPv6 short; a name it would rewrite (10.1 is 10.0.0.1) is no address people type.
    const ipv6 = hostname.startsWith('[');
    if (ipv6 ? hostname === '[::]' : !ADDRESS_HOST.test(hostname) || hostname !== match[1] || hostname === '0.0.0.0') continue;
    if (!ipv6 && !IPV4.test(hostname) && hostname !== 'localhost') continue; // v34 ORIGIN2 review 7: IP addresses only
    hosts.add(hostname);
  }
  return [...hosts];
}

/**
 * The forwarded-address headers the web server's /api rewrite sends the API for a request with these `headers`:
 * X-Forwarded-Host = the Host the browser sent, X-Forwarded-Proto passed on as it came (a tunnel's). The sign-in gate
 * (proxy.ts) asks the API about a session with them: a session works only at the address it was signed in at (the
 * ORIGIN2 review, finding 2; migration 0056), so without them a session made at a LAN address or through a tunnel would
 * look dead to the gate, and /login would clear its cookie.
 */
export function forwardedAddress(headers: { get(name: string): string | null }): Record<string, string> {
  const forwarded: Record<string, string> = {};
  const host = headers.get('host');
  const proto = headers.get('x-forwarded-proto');
  if (host) forwarded['x-forwarded-host'] = host;
  if (proto) forwarded['x-forwarded-proto'] = proto;
  return forwarded;
}
// end v34 ORIGIN2
