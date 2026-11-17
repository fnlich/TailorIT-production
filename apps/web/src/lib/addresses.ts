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
 * (unless it is a wildcard address) and APP_ORIGIN's host, each once.
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
  return [...names];
}
