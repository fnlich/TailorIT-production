import { gunzipSync } from 'node:zlib';
import { decodeHtmlEntities } from '@tailorit/shared';
import { SITEMAP_MAX_URLS } from '../sitemap';

// v30 S5: a career site's sitemaps (docs/design/part2/12-job-sourcing.md §3.4 step 3; the sitemaps.org protocol): the
// ones its robots.txt announces (site_robots.sitemaps), else /sitemap.xml. A sitemap index names more sitemaps; a
// urlset names pages with an optional lastmod. Only addresses that look like one posting's page are kept (the
// platform's posting pattern: /job/, /jobs/<id>, ...), and lastmod, when present, says which changed since the last
// read. A plain-text sitemap (one address a line) is read too, and a gzip one is unpacked first.
//
// S3 builds ingest/sitemap.ts for Workday's sitemaps in the same wave: the two readers can become one later (INT-4's
// note); this one is the career pages' own, with their posting patterns.

// v30 FIX-A (REQ-14): the protocol's cap of addresses per file is ingest/sitemap.ts's SITEMAP_MAX_URLS, one value for
// both readers.
export { SITEMAP_MAX_URLS };
/** The largest sitemap unpacked from gzip (bytes). */
export const SITEMAP_MAX_UNPACKED_BYTES = 52_428_800;

export interface SitemapEntry {
  loc: string;
  /** ISO time, or null when the sitemap gives none (or an unreadable one). */
  lastmod: string | null;
}

export interface ParsedSitemap {
  /** `index`: its entries are sitemaps; `urlset` (or a text list): pages; `none`: not a sitemap. */
  kind: 'index' | 'urlset' | 'none';
  entries: SitemapEntry[];
  /** More entries than SITEMAP_MAX_URLS: the rest were left out. */
  truncated: boolean;
}

/** A sitemap's bytes as text: unpacked when gzip (null when it cannot be), else read as UTF-8. */
export function sitemapText(body: Buffer): string | null {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return gunzipSync(body, { maxOutputLength: SITEMAP_MAX_UNPACKED_BYTES }).toString('utf8');
    } catch {
      return null;
    }
  }
  return body.toString('utf8');
}

/** An XML text node's value: CDATA unwrapped, entities decoded, trimmed. */
function xmlText(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  return decodeHtmlEntities(cdata ? cdata[1]! : value).trim();
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(xmlText(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** One element's text by local name inside `xml` (any namespace prefix), or undefined. */
function child(xml: string, name: string): string | undefined {
  return new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, 'i').exec(xml)?.[1];
}

/** Reads a sitemap (an index, a urlset, or a text list of addresses). */
export function parseSitemap(text: string, max = SITEMAP_MAX_URLS): ParsedSitemap {
  const isIndex = /<(?:[\w.-]+:)?sitemapindex\b/i.test(text);
  const isUrlset = /<(?:[\w.-]+:)?urlset\b/i.test(text);
  const entries: SitemapEntry[] = [];
  let truncated = false;
  if (isIndex || isUrlset) {
    const element = isIndex ? 'sitemap' : 'url';
    const pattern = new RegExp(`<(?:[\\w.-]+:)?${element}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${element}\\s*>`, 'gi');
    for (const match of text.matchAll(pattern)) {
      const loc = child(match[1] ?? '', 'loc');
      if (!loc) continue;
      if (entries.length >= max) {
        truncated = true;
        break;
      }
      entries.push({ loc: xmlText(loc), lastmod: isoOrNull(child(match[1] ?? '', 'lastmod')) });
    }
    return { kind: isIndex ? 'index' : 'urlset', entries, truncated };
  }
  // A text sitemap: one absolute address a line, nothing else.
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || !lines.every((line) => /^https?:\/\/\S+$/i.test(line))) return { kind: 'none', entries: [], truncated: false };
  for (const line of lines) {
    if (entries.length >= max) {
      truncated = true;
      break;
    }
    entries.push({ loc: line, lastmod: null });
  }
  return { kind: 'urlset', entries, truncated };
}

/**
 * The paths (and queries) that name one posting on the career-site platforms (12 §3.4 step 3): /job/<x>, /jobs/<x>,
 * /positions/<x>, /openings/<x>, /vacancies/<x>, /careers/<x>/<y>, /requisitions/<x>, /opportunities/<x>, and the query
 * forms (?gh_jid=, ?jobId=, ?job_id=, ?opportunityId=, ?reqId=, ?jobid=). Teamtailor, SuccessFactors, iCIMS, Oracle,
 * Taleo, ADP, UKG and Paycom pages fit one of them.
 */
const POSTING_PATHS: readonly RegExp[] = [
  /\/(?:job|jobs|position|positions|opening|openings|vacancy|vacancies|opportunity|opportunities|requisition|requisitions|posting|postings|stellenangebote|stellen|offres?|empleos?|vagas?)\/[^/?#]+/i,
  /\/careers?\/[^/?#]+\/[^/?#]+/i,
  /[?&](?:gh_jid|jobid|job_id|jobreq|reqid|req_id|opportunityid|requisitionid|postingid)=[^&#]+/i,
  /\/jobdetail\.ftl\b/i,
];
/** Listing and filter pages under the same prefixes: never one posting. */
const NOT_POSTING_PATHS: readonly RegExp[] = [
  /\/(?:jobs?|positions|openings|vacancies|careers?)\/(?:search|category|categories|location|locations|department|departments|team|teams|page|tag|tags|filter|feed|rss|alerts?|apply|login|signin|sign-in)(?:[/?#]|$)/i,
];

/** Whether `address` is a posting's page on `host`: the same host, and one of the posting patterns (or `prefixes`). */
export function isPostingAddress(address: string, host: string, prefixes: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.hostname.toLowerCase().replace(/\.+$/, '') !== host) return false;
  const path = `${url.pathname}${url.search}`;
  if (prefixes.length > 0) return prefixes.some((prefix) => url.pathname.startsWith(prefix) && url.pathname.length > prefix.length);
  if (NOT_POSTING_PATHS.some((pattern) => pattern.test(path))) return false;
  return POSTING_PATHS.some((pattern) => pattern.test(path));
}

/** Of a sitemap index's sitemaps, those most likely to list postings first (their path names jobs or careers). */
export function sitemapsByPromise(entries: readonly SitemapEntry[]): SitemapEntry[] {
  const pathOf = (loc: string) => {
    try {
      const url = new URL(loc);
      return `${url.pathname}${url.search}`;
    } catch {
      return loc;
    }
  };
  const promising = (entry: SitemapEntry) => (/job|career|position|vacanc|opening|posting|requisition|stellen/i.test(pathOf(entry.loc)) ? 0 : 1);
  return [...entries].sort((a, b) => promising(a) - promising(b));
}
