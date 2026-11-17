import { isLinkedInHost } from '@tailorit/shared/autofill';

// The hosts TailorIT's server never sends a request to, whatever asks: LinkedIn's (linkedin.com and every host under
// it, linkedin.cn, lnkd.in, licdn.com, with or without trailing dots), and (v30 S1-API) the refused job boards and
// services of REFUSED_SERVICES below. LinkedIn's robots.txt disallows automated
// access, so a LinkedIn job's address is only ever compared (autofill's lookup, job_link_aliases), never fetched. Every
// outbound client checks here before it sends anything: the job boards' client (ingest/http.ts) and the Google Sheets
// client (guardedFetch). Both follow redirects themselves, each hop checked before it is sent: a hop must be https, to
// a dotted name (never an IP address, a single-label name, localhost or a local network's name such as *.local,
// *.internal, *.corp, nor a public name made to point at the machine itself such as *.nip.io or localtest.me), never
// LinkedIn's, and on the hosts the caller allows (Workday's reads stay on Workday's hosts, Google Sheets' on
// *.googleapis.com). A hop to another origin carries no credential header (Authorization, Cookie,
// Proxy-Authorization, Authorization-Key, X-Api-Key) nor any header the caller added (crossOriginHeaders).
//
// The check is on names: the address a name resolves to is not checked when the connection is made. Node's built-in
// fetch keeps its undici dispatcher to itself, so a connect-time lookup hook would need the undici package as a new
// dependency (its Agent, given to every fetch as its dispatcher, matched to the undici Node bundles); TailorIT has none.
// Every first request goes to an address TailorIT builds for a board, Workday or Google, and a redirect is held to the
// rules above.

/** The most redirects one request follows. */
export const MAX_REDIRECTS = 5;

// v30 S1-API (12-job-sourcing.md §1 "Never", §3.10): the job boards and services whose terms or robots.txt forbid what
// TailorIT does join LinkedIn on the refused list, so no adapter, discovery step, re-check or redirect reaches them by
// accident. Each entry is matched as a registrable name and every host under it (`indeed.com` refuses
// `www.indeed.com`); `anyCountry` also refuses the name under any country's domain (`indeed.co.uk`, `ca.indeed.com`
// is under indeed.com already); `exact` refuses that host alone (Google's search pages, not Google's other services).

/** One refused service: its words in the refusal, and the hosts it names. */
export interface RefusedService {
  /** Named in the refusal: "TailorIT never sends a request to Indeed". */
  name: string;
  /** Registrable names: the name and every host under it. */
  domains?: readonly string[];
  /** Names refused under any country's domain as well (indeed -> indeed.de, indeed.co.uk, indeed.com.au). */
  anyCountry?: readonly string[];
  /** Hosts refused alone (their subdomains are not). */
  exact?: readonly string[];
  /** Why (12 §3.10, read 2026-11-14). */
  reason: string;
}

/** The refused job boards and services (12 §3.10), LinkedIn's hosts aside (isLinkedInHost). */
export const REFUSED_SERVICES: readonly RefusedService[] = [
  { name: 'Indeed', anyCountry: ['indeed'], reason: 'its terms forbid scraping and building databases' },
  { name: 'Glassdoor', anyCountry: ['glassdoor'], reason: "its API is closed and robots.txt disallows /api/" },
  { name: 'ZipRecruiter', anyCountry: ['ziprecruiter'], reason: 'robots.txt disallows every reader' },
  {
    name: 'Google for Jobs',
    exact: ['google.com', 'www.google.com', 'jsearch.p.rapidapi.com'],
    domains: ['serpapi.com'],
    reason: "Google's terms forbid automated search; the postings belong to the boards it shows",
  },
  { name: 'the SmartRecruiters Posting API', exact: ['api.smartrecruiters.com'], reason: 'robots.txt allows LinkedInBot alone' },
  { name: 'the Bundesagentur für Arbeit', domains: ['arbeitsagentur.de'], reason: 'its terms forbid robots and data collection' },
  {
    name: 'a public employment service that allows no reuse',
    domains: ['findajob.dwp.gov.uk', 'workforceaustralia.gov.au', 'jobnet.dk', 'eures.europa.eu', 'jobbank.gc.ca'],
    reason: 'no public route for private reuse',
  },
  { name: 'Remotive', domains: ['remotive.com', 'remotive.io'], reason: 'its terms forbid showing its jobs to collect sign-ups' },
  { name: 'We Work Remotely', domains: ['weworkremotely.com'], reason: 'its terms forbid scraping and storing its data' },
  { name: 'Jooble', anyCountry: ['jooble'], reason: 'its content may not be copied for republication' },
  { name: 'Careerjet', anyCountry: ['careerjet'], reason: "its API serves live display to the end user's own browser only" },
  {
    name: 'Y Combinator',
    domains: ['ycombinator.com', 'workatastartup.com', 'hacker-news.firebaseio.com'],
    reason: 'its terms forbid copying, data mining, robots and scraping',
  },
  {
    name: "a job site that copies employers' postings",
    domains: ['simplify.jobs', 'jobright.ai', 'wellfound.com', 'angel.co', 'builtin.com', 'dice.com'],
    reason: "the original posting is on the employer's own board, which TailorIT reads",
  },
  {
    name: 'a data vendor without a contract',
    domains: [
      'theirstack.com',
      'coresignal.com',
      'lightcast.io',
      'reveliolabs.com',
      'textkernel.com',
      'brightdata.com',
      'apify.com',
      'mantiks.io',
      'webdatacommons.org',
    ],
    reason: 'no licence for display (12 §3.8)',
  },
  {
    name: 'a web search API',
    exact: ['api.bing.microsoft.com', 'customsearch.googleapis.com'],
    reason: "Bing's is retired and Google's is closed to new customers",
  },
];

/** A country's domain after a refused name: .de, .co.uk, .com.au, .com. */
const COUNTRY_TAIL = /^(?:[a-z]{2,3}|(?:co|com|org|net|ac|gov)\.[a-z]{2})$/;

/** The refused service a host belongs to (lower case, no trailing dot), or null. */
export function refusedServiceOf(host: string): RefusedService | null {
  const name = host.toLowerCase().replace(/\.+$/, '');
  const under = (domain: string) => name === domain || name.endsWith(`.${domain}`);
  for (const service of REFUSED_SERVICES) {
    if (service.exact?.includes(name)) return service;
    if (service.domains?.some(under)) return service;
    for (const label of service.anyCountry ?? []) {
      const labels = name.split('.');
      const at = labels.lastIndexOf(label);
      if (at >= 0 && at < labels.length - 1 && COUNTRY_TAIL.test(labels.slice(at + 1).join('.'))) return service;
    }
  }
  return null;
}

/** A request refused before it was sent. */
export class OutboundRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundRefusedError';
  }
}

/** A URL read, or OutboundRefusedError. */
function urlOf(address: string | URL): URL {
  try {
    return typeof address === 'string' ? new URL(address) : address;
  } catch {
    throw new OutboundRefusedError('TailorIT sends no request to an address it cannot read.');
  }
}

/** Throws OutboundRefusedError for an address on a host TailorIT never requests (or no address at all). */
export function assertOutboundAllowed(address: string | URL): void {
  const host = urlOf(address).hostname;
  // An empty label (a.b..c, a leading dot) is no host name TailorIT reads.
  if (!host || host.startsWith('.') || host.includes('..')) {
    throw new OutboundRefusedError('TailorIT sends no request to a host name with an empty label.');
  }
  if (isLinkedInHost(host)) throw new OutboundRefusedError('TailorIT never sends a request to LinkedIn.');
  // v30 S1-API: the refused job boards and services (12 §3.10).
  const refused = refusedServiceOf(host);
  if (refused) throw new OutboundRefusedError(`TailorIT never sends a request to ${refused.name}: ${refused.reason}.`);
}

/**
 * Names that never leave the machine or its network: loopback, link-local (mDNS) and private names, and the public
 * names made to resolve to the machine itself or to the address they spell (nip.io, sslip.io, localtest.me, lvh.me).
 */
const LOCAL_NAME =
  /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|private|home\.arpa|localdomain|nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me)\.?$/i;
/** An IP address as WHATWG URL writes a host: IPv4 dotted (every other spelling is read as one) or [IPv6]. */
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/**
 * Throws OutboundRefusedError for a redirect hop TailorIT does not follow: not https, an IP address, a single-label
 * name (a local network's, as LLMNR or NetBIOS would answer it), a loopback, link-local or private name, a host
 * assertOutboundAllowed refuses, or (with `allowHost`) a host the caller does not allow.
 */
export function assertRedirectAllowed(address: string | URL, allowHost?: (host: string) => boolean): void {
  const url = urlOf(address);
  if (url.protocol !== 'https:') throw new OutboundRefusedError('TailorIT follows a redirect to an https address only.');
  const host = url.hostname.replace(/\.+$/, '');
  if (IP_LITERAL.test(url.hostname) || LOCAL_NAME.test(url.hostname) || !host.includes('.')) {
    throw new OutboundRefusedError('TailorIT follows no redirect to an IP address or a local name.');
  }
  assertOutboundAllowed(url);
  if (allowHost && !allowHost(host.toLowerCase())) {
    throw new OutboundRefusedError('TailorIT follows no redirect away from the service it asked.');
  }
}

/**
 * The headers a request never carries to another origin than the first request's (as the Fetch standard drops the
 * first three), and (v30 FIX-A, REV-SEC SEC-1) the keyed APIs' own key headers: USAJOBS' Authorization-Key, an
 * X-Api-Key.
 */
export const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'authorization-key', 'x-api-key'] as const;

/**
 * v30 FIX-A (REV-SEC SEC-1): a redirect hop's headers once the request has left its first origin: no credential header
 * (CREDENTIAL_HEADERS) and none of `added`, the headers the caller added to the request itself (a keyed API's key under
 * any name), whatever their case. Every client that follows redirects itself uses it: guardedFetch below and the job
 * boards' client (features/ingest/http.ts).
 */
export function crossOriginHeaders(headers: ConstructorParameters<typeof Headers>[0], added: readonly string[] = []): Headers {
  const out = new Headers(headers);
  for (const name of [...CREDENTIAL_HEADERS, ...added]) out.delete(name);
  return out;
}

/** Options of guardedFetch. */
export interface GuardedFetchOptions {
  /** The hosts a redirect may lead to (in lower case, no trailing dot); any host assertRedirectAllowed allows when absent. */
  allowRedirectHost?: (host: string) => boolean;
}

/**
 * A fetch that refuses those hosts before sending anything (its promise rejects with OutboundRefusedError) and follows
 * a GET's or a HEAD's redirects itself, at most MAX_REDIRECTS, each hop checked (assertRedirectAllowed, with the
 * hosts `options` allow). A hop to another origin than the first request's carries no Authorization, Cookie or
 * Proxy-Authorization header. Another method follows none. A caller asking for `redirect: 'manual'` or `'error'` gets
 * that.
 */
export function guardedFetch(doFetch: typeof globalThis.fetch, options: GuardedFetchOptions = {}): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const first = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    assertOutboundAllowed(first);
    if (init.redirect === 'manual' || init.redirect === 'error') return doFetch(input, init);
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return doFetch(input, { ...init, redirect: 'error' });
    const origin = urlOf(first).origin;
    let current = first;
    let hopInit: RequestInit = { ...init, redirect: 'manual' };
    for (let hop = 0; ; hop += 1) {
      const response = await doFetch(hop === 0 ? input : current, hopInit);
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('Location') : null;
      if (location === null) return response;
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new OutboundRefusedError(`More than ${MAX_REDIRECTS} redirects.`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new OutboundRefusedError('A redirect to an address that is not one.');
      }
      assertRedirectAllowed(next, options.allowRedirectHost);
      if (next.origin !== origin) {
        // Once the request has left its origin, it carries no credential again (even back on the first origin).
        hopInit = { ...hopInit, headers: crossOriginHeaders(hopInit.headers) };
      }
      current = next.href;
    }
  };
}
