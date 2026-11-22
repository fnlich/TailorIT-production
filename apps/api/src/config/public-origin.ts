import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { connectorsReachable } from '@tailorit/shared/oauth'; // v34 ORIGIN2
import { exactOriginFor, hostMatches, isLoopbackHost, parseForwardedHost, parseTrustedHost, type HostPattern } from './addresses';

// v34 ORIGIN (PLAN G7): the public address one request came through. TailorIT is opened at APP_ORIGIN; while testing it
// may also be opened through a tunnel whose address changes often (https://<random>.trycloudflare.com -> the web on
// WEB_PORT -> Next's rewrite -> the API, which sees Host 127.0.0.1:<API_PORT> and X-Forwarded-Host = the tunnel's host).
// The OAuth server's addresses, the MCP endpoint's resource and the Origin checks follow that address, so a new tunnel
// needs no .env edit and no restart. A request's headers are believed only:
// - from this machine: the socket's peer is a loopback address (Next's rewrite, Caddy), whatever `trust proxy`
//   (TRUST_PROXY) says and never from X-Forwarded-For. That means "from any client of the web server": Next's rewrite
//   sets X-Forwarded-Host to the Host its client sent (review, security 3), so with WEB_HOST on the network any computer
//   there can claim a trusted host (config/warnings.ts warns at start). A process on this computer that calls the API
//   directly is believed too;
// - for X-Forwarded-Host's FIRST value, lower case with its port, and only when it is APP_ORIGIN's host or a host one of
//   TRUSTED_PUBLIC_HOSTS's patterns names (config.trustedPublicHosts: `*.trycloudflare.com` by default outside
//   production, none in production). Anything else, or no header: APP_ORIGIN.
// The scheme: APP_ORIGIN's for its own host (APP_ORIGIN exactly); for a pattern's host, X-Forwarded-Proto's first value
// (http or https), https without one (a public tunnel is https).
// v34 ORIGIN2 (PLAN G7b): an exact address in TRUSTED_PUBLIC_HOSTS (written with its scheme, such as a LAN address
// http://192.168.1.20:3100 that another device opens directly: its browser sends no X-Forwarded-Proto) is that origin
// exactly when X-Forwarded-Host is its host and port, whatever X-Forwarded-Proto says; another port, the other scheme
// or another address is not it. Checked after APP_ORIGIN's host and before the patterns.

/** What publicOriginOf reads of a request (an Express Request has it). */
export interface ForwardedRequest {
  socket: { remoteAddress?: string | undefined };
  get(name: string): string | undefined;
}

/** The part of AppConfig these rules read. */
export interface OriginConfig {
  appOrigin: string;
  trustedPublicHosts: readonly HostPattern[];
}

interface ForwardedInput {
  peer: string | undefined;
  forwardedHost: string | undefined;
  forwardedProto: string | undefined;
}

/** Whether the socket's peer is this machine (127.x.x.x, ::1, or an IPv4-mapped 127.x.x.x). */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return bare !== 'localhost' && isLoopbackHost(bare);
}

/** The forwarded address a request may be believed about (its origin and host name), or null. */
function trustedForwarded(config: OriginConfig, input: ForwardedInput): { origin: string; hostname: string } | null {
  if (!isLoopbackPeer(input.peer)) return null;
  const forwarded = parseForwardedHost(input.forwardedHost);
  if (!forwarded) return null;
  const app = new URL(config.appOrigin);
  const hostText = `${forwarded.hostname}${forwarded.port === null ? '' : `:${forwarded.port}`}`;
  // APP_ORIGIN's own host (its default port written or not): APP_ORIGIN exactly, whatever X-Forwarded-Proto says.
  let sameHost = false;
  try {
    sameHost = new URL(`${app.protocol}//${hostText}`).host === app.host;
  } catch {
    sameHost = false;
  }
  if (sameHost) return { origin: config.appOrigin, hostname: forwarded.hostname };
  const exact = exactOriginFor(config.trustedPublicHosts, forwarded.hostname, forwarded.port); // v34 ORIGIN2
  if (exact !== null) return { origin: exact, hostname: forwarded.hostname };
  const proto = (input.forwardedProto ?? '').split(',')[0]!.trim().toLowerCase();
  const scheme = proto === 'http' || proto === 'https' ? proto : 'https';
  // The scheme's own port written out (some clients send Host: name:80 through a proxy) is no port.
  const port = forwarded.port === (scheme === 'https' ? 443 : 80) ? null : forwarded.port;
  if (!config.trustedPublicHosts.some((pattern) => hostMatches(pattern, forwarded.hostname, port))) return null;
  try {
    return { origin: new URL(`${scheme}://${hostText}`).origin, hostname: forwarded.hostname };
  } catch {
    return null;
  }
}

/**
 * The public origin of a request (scheme, host and port) from its peer and forwarded headers: APP_ORIGIN unless the
 * peer is loopback and X-Forwarded-Host names APP_ORIGIN's host, a trusted exact address's (v34 ORIGIN2) or a trusted
 * pattern's host. Pure (tests pass values).
 */
export function publicOriginFrom(config: OriginConfig, input: ForwardedInput): string {
  return trustedForwarded(config, input)?.origin ?? config.appOrigin;
}

const inputOf = (req: ForwardedRequest): ForwardedInput => ({
  peer: req.socket.remoteAddress,
  forwardedHost: req.get('x-forwarded-host'),
  forwardedProto: req.get('x-forwarded-proto'),
});

/** publicOriginFrom for an Express request. */
export function publicOriginOf(config: OriginConfig, req: ForwardedRequest): string {
  return publicOriginFrom(config, inputOf(req));
}

// v34 FIX-API (the final security review, F1) ---------------------------------------------------------------------------
/** The names a page on this computer opens TailorIT at (a URL's hostname: IPv6 in brackets). */
const THIS_COMPUTERS_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Headers a tunnel, a CDN or a proxy adds whose presence alone says the request did not come straight from this
 * computer (besides every `cf-*` header, Cloudflare's). X-Forwarded-For and X-Real-IP are judged by what they list.
 */
export const PROXY_MARK_HEADERS: readonly string[] = Object.freeze([
  'forwarded',
  'via',
  'x-forwarded-server',
  'x-original-forwarded-for',
  'cdn-loop',
  'true-client-ip',
  'fastly-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
]);

/** The headers that name the clients a request came from: each address listed must be this computer. */
const CLIENT_CHAIN_HEADERS = ['x-forwarded-for', 'x-real-ip'] as const;

/** One X-Forwarded-For entry ("127.0.0.1", "::1", "127.0.0.1:5000", "[::1]:5000") is this computer. */
function isLoopbackClient(entry: string): boolean {
  let value = entry.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  return isLoopbackPeer(value);
}

/** What plainlyFromThisComputer reads of a request (an Express Request has it). */
export interface ThisComputerRequest extends ForwardedRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Whether a request is plainly from this computer (AUTH_DEV_FIXED_CODE signs in only then): the socket's peer is
 * loopback; no tunnel or proxy mark (PROXY_MARK_HEADERS, any `cf-*` header) and every client X-Forwarded-For or
 * X-Real-IP names is loopback (the dev guard adds a network client's address there: scripts/dev-guard.mjs); a forwarded
 * host, the request's public origin (publicOriginOf, as ORIGIN/ORIGIN2 compute it) and its page's Origin, when sent,
 * name this computer (localhost, 127.0.0.1, [::1]). A TCP-level forward (ssh -R) cannot be told apart from this
 * computer (nothing in the request differs).
 */
export function plainlyFromThisComputer(config: OriginConfig, req: ThisComputerRequest): boolean {
  if (!isLoopbackPeer(req.socket.remoteAddress)) return false;
  for (const name of Object.keys(req.headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('cf-') || PROXY_MARK_HEADERS.includes(lower)) return false;
  }
  for (const name of CLIENT_CHAIN_HEADERS) {
    const value = req.get(name);
    if (value !== undefined && !value.split(',').every(isLoopbackClient)) return false;
  }
  const forwardedHost = req.get('x-forwarded-host');
  if (forwardedHost !== undefined) {
    const forwarded = parseForwardedHost(forwardedHost);
    if (!forwarded || !THIS_COMPUTERS_NAMES.has(forwarded.hostname)) return false;
  }
  const nameOf = (address: string): string | null => {
    try {
      return new URL(address).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  if (!THIS_COMPUTERS_NAMES.has(nameOf(publicOriginOf(config, req)) ?? '')) return false;
  const origin = req.get('origin');
  return origin === undefined || THIS_COMPUTERS_NAMES.has(nameOf(origin) ?? '');
}
// end v34 FIX-API

/**
 * The host name (lower case; an IPv6 address in brackets) of a request's forwarded address when publicOriginOf believed
 * X-Forwarded-Host; null otherwise. The MCP endpoint's Host and Origin checks accept it beside their own names.
 */
export function trustedForwardedHostname(config: OriginConfig, req: ForwardedRequest): string | null {
  return trustedForwarded(config, inputOf(req))?.hostname ?? null;
}

// v34 ORIGIN2 (PLAN G7b)
/**
 * Where else than `origin` (a request's public origin) Claude and ChatGPT could connect to this server, for
 * Integrations on an address their servers cannot reach (this computer, a LAN address): `origins`, its fixed addresses
 * they can reach (APP_ORIGIN, TRUSTED_PUBLIC_HOSTS's exact addresses and plain host names, as https: a tunnel or a proxy
 * in front is https), and `tunnels`, the domains of its `*.` patterns (with a port when the pattern names one). Only
 * public https addresses (connectorsReachable): never a LAN or private one. The ORIGIN2 review, finding 8: a host
 * entry written without a scheme gives an https address only for a name (a proxy's or a tunnel's); an IPv4 address with
 * a port there is most likely a LAN address meant as http://, which serves no https (a host entry is never IPv6).
 */
/**
 * The https address a TRUSTED_PUBLIC_HOSTS host entry written without a scheme stands for (a proxy's or a tunnel's
 * name, https in front), or null: a pattern, or an IPv4 address (the ORIGIN2 review, finding 8: most likely a LAN
 * address meant as http://, which serves no https).
 */
export function hostEntryHttpsOrigin(entry: HostPattern): string | null {
  if (entry.origin !== undefined || entry.wildcard || isIPv4(entry.host)) return null;
  return `https://${entry.host}${entry.port === null ? '' : `:${entry.port}`}`;
}

export function connectorAddresses(config: OriginConfig, origin: string): { origins: string[]; tunnels: string[] } {
  const origins = new Set<string>();
  const add = (address: string) => {
    if (address !== origin && connectorsReachable(address)) origins.add(address);
  };
  add(config.appOrigin);
  const tunnels = new Set<string>();
  for (const entry of config.trustedPublicHosts) {
    const port = entry.port === null ? '' : `:${entry.port}`;
    const named = hostEntryHttpsOrigin(entry);
    if (entry.origin !== undefined) add(entry.origin);
    else if (named !== null) add(named);
    else if (entry.wildcard && connectorsReachable(`https://name.${entry.host}${port}`)) tunnels.add(`${entry.host}${port}`);
  }
  return { origins: [...origins], tunnels: [...tunnels] };
}

/**
 * The address of a page the /api Origin check refused at its own address (its Origin is the scheme and the host the
 * browser opened, which the web server forwarded from this machine as X-Forwarded-Host) when no setting trusts it: a
 * device opening TailorIT at an address missing from TRUSTED_PUBLIC_HOSTS (a typo, an address that changed). Null for
 * anything else (a page at another site, another peer, a trusted address). The page itself only says "Request not
 * allowed.", so the API's log names what to add (refusedAddressNote).
 */
export function untrustedOwnAddress(config: OriginConfig, req: ForwardedRequest, origin: string | undefined): string | null {
  if (!origin || !isLoopbackPeer(req.socket.remoteAddress)) return null;
  const forwarded = parseForwardedHost(req.get('x-forwarded-host'));
  if (!forwarded) return null;
  let page: URL;
  try {
    page = new URL(origin);
  } catch {
    return null;
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return null;
  let own = false;
  try {
    own = new URL(`${page.protocol}//${forwarded.hostname}${forwarded.port === null ? '' : `:${forwarded.port}`}`).host === page.host;
  } catch {
    own = false;
  }
  // A host TailorIT already answers at (APP_ORIGIN's, an exact address's or a pattern's) with the other scheme is not a
  // missing address: adding it would be refused (one Host, two schemes).
  if (!own || trustedForwarded(config, inputOf(req)) !== null) return null;
  return page.origin;
}

/** How many refused addresses the log names (once each) before it stops. */
const REFUSED_ADDRESSES_NOTED = 20;

/**
 * This computer's own IP addresses, from its network interfaces (IPv6 in brackets, short; link-local ones left out), at
 * the moment of asking: a LAN address that changed (a new DHCP lease) is among them.
 */
export function thisComputersAddresses(): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      const address = item.address.split('%')[0]!.toLowerCase();
      if (isIPv4(address)) addresses.push(address);
      else if (!address.startsWith('fe80')) {
        try {
          addresses.push(new URL(`http://[${address}]`).hostname);
        } catch {
          /* not an address a Host header could name */
        }
      }
    }
  }
  return addresses;
}

/**
 * originCheck's onRefused (v34 ORIGIN2): logs the sentence saying what to add for a page at an address no setting trusts
 * (untrustedOwnAddress). The ORIGIN2 review, finding 4: any client of the web server can send any Host, so the log names
 * an address only when it is one of this computer's own (`ownAddresses`, its network interfaces) at the web server's
 * port (WEB_PORT), and one start would accept, each once (at most REFUSED_ADDRESSES_NOTED): nobody can make it suggest a
 * name of their choosing, nor use the notes up with invented ones. Any other refused address gets one line, once,
 * naming none.
 */
export function refusedAddressNote(
  config: OriginConfig & { webPort: number },
  log: { warn(message: string): void },
  ownAddresses: () => readonly string[] = thisComputersAddresses,
): (req: ForwardedRequest, origin: string | undefined) => void {
  const noted = new Set<string>();
  let unnamed = false;
  return (req, origin) => {
    const address = untrustedOwnAddress(config, req, origin);
    if (address === null) return;
    const page = new URL(address);
    const port = page.port ? Number(page.port) : page.protocol === 'https:' ? 443 : 80;
    // The web server serves plain http at WEB_PORT: a page there is http.
    const ours = page.protocol === 'http:' && port === config.webPort && ownAddresses().includes(page.hostname) && 'entry' in parseTrustedHost(address);
    if (!ours) {
      if (unnamed) return;
      unnamed = true;
      log.warn(
        `[api] A page at an address TailorIT does not answer at was refused (not APP_ORIGIN, ${config.appOrigin}, nor in ` +
          'TRUSTED_PUBLIC_HOSTS). If you opened TailorIT from another device, add the address you opened, with its scheme, to ' +
          'TRUSTED_PUBLIC_HOSTS and restart.',
      );
      return;
    }
    if (noted.has(address) || noted.size >= REFUSED_ADDRESSES_NOTED) return;
    noted.add(address);
    log.warn(
      `[api] A page at ${address}, an address of this computer, was refused: it is not APP_ORIGIN (${config.appOrigin}) and not ` +
        `in TRUSTED_PUBLIC_HOSTS. If that was your own device opening TailorIT, add ${address} to TRUSTED_PUBLIC_HOSTS and restart.`,
    );
  };
}
// end v34 ORIGIN2
