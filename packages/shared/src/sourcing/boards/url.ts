import type { BoardUrl } from './types';

// v38 FRAME: the board descriptors' address helpers. URL exists in every browser and in Node; this package's lib types
// (ES only) do not declare it, so it is read off globalThis (as jobs/canonical.ts reads it).

const runtime = globalThis as unknown as { URL?: new (input: string) => BoardUrl };

/** An http(s) address with a host, parsed; null for anything else. */
export function boardUrlOf(address: string): BoardUrl | null {
  const text = address.trim();
  if (!text || !runtime.URL) return null;
  try {
    const url = new runtime.URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** An address's host as the boards read it: lower case, no trailing dot. */
export const boardHostOf = (url: Pick<BoardUrl, 'hostname'>): string => url.hostname.toLowerCase().replace(/\.+$/, '');

/** An address's path segments, each decoded (as written when it is no valid encoding). */
export function boardSegmentsOf(url: Pick<BoardUrl, 'pathname'>): string[] {
  return url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** A string config value, trimmed; null for none. */
export function configText(config: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A config value as written when it is a string, else '' (Admin › Sources' few words read it so). */
export function configWords(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

/** One DNS label ("acme-robotics"). */
export const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The company a feed's address or name gives ("acme", "acme.recruitee.com", "https://acme.jobs.personio.de/job/1"):
 * one DNS label in lower case, under one of `suffixes` when an address is given; '' when there is none (the API's
 * ingest/sitemap.ts tenantOf, which reads through this one).
 */
export function tenantLabelOf(input: string, suffixes: readonly string[]): string {
  let text = input.trim().toLowerCase();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text) || text.includes('.') || text.includes('/')) {
    let host: string;
    try {
      if (!runtime.URL) return '';
      host = new runtime.URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
    } catch {
      return '';
    }
    const suffix = suffixes.find((candidate) => host.endsWith(`.${candidate}`));
    if (!suffix) return '';
    text = host.slice(0, -(suffix.length + 1));
  }
  return DNS_LABEL.test(text) ? text : '';
}

/**
 * A board host's tenant label under `suffix` (acme.recruitee.com under ".recruitee.com": acme), unless it is the
 * platform's own (www, its app, its API...: SERVICE_LABELS); null for none.
 */
export function tenantLabelOfHost(host: string, suffix: string): string | null {
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return label && !label.includes('.') && !SERVICE_LABELS.has(label) ? label : null;
}

/** A tenant host's first labels that are the platform's own (www, its app, its API...), never a customer's. */
export const SERVICE_LABELS: ReadonlySet<string> = new Set([
  'www', 'app', 'api', 'apply', 'help', 'support', 'docs', 'blog', 'status', 'login', 'jobs', 'careers', 'marketplace', 'partners',
  'developers', 'static', 'cdn', 'mail', 'go', 'info',
]);

/** First path segments of a board host that are no board (Greenhouse's, Lever's, Ashby's, Workable's). */
export const NOT_A_BOARD: ReadonlySet<string> = new Set([
  'embed', 'v1', 'static', 'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'api', 'j', 'jobs', 'login', 'search',
]);

/**
 * What an admin typed, as a host: an address's or a bare host's (lower case, no trailing dot), or the text itself when it
 * names none (a bare name, "acme"); '' for an address that is not one (the web's Add source check).
 */
export function hostOfTyped(input: string): string {
  const text = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text) && !text.includes('/') && !text.includes('.')) return text;
  try {
    if (!runtime.URL) return '';
    return new runtime.URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname.replace(/\.$/, '');
  } catch {
    return '';
  }
}
