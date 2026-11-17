import type { IngestHttp } from './http';
import { IngestError } from './types';

// v30 S3: sitemaps (sitemaps.org 0.9) and the small XML reader the feed adapters share (12-job-sourcing.md §3.2-3.4).
//
// A Workday career site announces its sitemap in its tenant's robots.txt (`Sitemap: .../<site>/siteMap.xml`): a list of
// its postings' pages, no `lastmod`, read whole at each run (adapters/workdaySite.ts). Personio's job feed is XML too
// (adapters/personio.ts). Both are read through the ingest client (its pace per host, robots.txt before each read, the
// answer's size cap), as text, and parsed here: no XML dependency, no DTD, no entity beyond XML's own five and the
// numeric ones, nothing fetched from inside a document. A sitemap index is followed to its child sitemaps on the same
// host only, at most SITEMAP_MAX_FILES files and SITEMAP_MAX_URLS addresses a read (the protocol's own cap per file).
// A gzipped child sitemap (`.gz`) is not read: none of the sites read here uses one.

/** The protocol's cap: one sitemap file lists at most this many addresses; a read keeps no more in all. */
export const SITEMAP_MAX_URLS = 50_000;
/** Files one sitemap read fetches: the sitemap itself and the children of an index. */
export const SITEMAP_MAX_FILES = 25;
/** The longest address a sitemap entry may hold (the protocol's 2,048 characters). */
export const SITEMAP_MAX_LOC = 2048;

// ------------------------------------------------------------------------------------------------- XML

/** One element of a parsed document: its local name (no namespace prefix), its child elements and its own text. */
export interface XmlElement {
  name: string;
  children: XmlElement[];
  /** The element's direct text, entities decoded, CDATA as written. */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML's five entities and the numeric ones, decoded in one pass (never twice: "&amp;lt;" is "&lt;"). */
export function xmlDecode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

const CDATA_MARK = '\u0000';

/**
 * Parses an XML document into its root element, leniently (a feed's slip never throws): CDATA kept as written,
 * comments, processing instructions and a DOCTYPE dropped, a closing tag that matches no open one ignored, an element
 * left open closed at the end. Null when the text holds no element.
 */
export function parseXml(xml: string): XmlElement | null {
  const cdata: string[] = [];
  const body = xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_whole, inner: string) => `${CDATA_MARK}${cdata.push(inner) - 1}${CDATA_MARK}`)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const textOf = (segment: string) =>
    segment
      .split(new RegExp(`${CDATA_MARK}(\\d+)${CDATA_MARK}`))
      .map((part, index) => (index % 2 === 1 ? (cdata[Number(part)] ?? '') : xmlDecode(part)))
      .join('');
  const document: XmlElement = { name: '#document', children: [], text: '' };
  const stack: XmlElement[] = [document];
  let last = 0;
  for (const match of body.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)(?:\s[^>]*?)?(\/?)>/g)) {
    const top = stack[stack.length - 1]!;
    top.text += textOf(body.slice(last, match.index));
    last = match.index + match[0].length;
    const name = match[2]!.slice(match[2]!.lastIndexOf(':') + 1);
    if (match[1]) {
      let at = stack.length - 1;
      while (at > 0 && stack[at]!.name !== name) at -= 1;
      if (at > 0) stack.length = at;
      continue;
    }
    const element: XmlElement = { name, children: [], text: '' };
    top.children.push(element);
    if (!match[3]) stack.push(element);
  }
  // Text after the last tag belongs to the element still open (a document cut short).
  stack[stack.length - 1]!.text += textOf(body.slice(last));
  return document.children[0] ?? null;
}

/** The element's direct children named `name`. */
export function xmlChildren(element: XmlElement | null | undefined, name: string): XmlElement[] {
  return element ? element.children.filter((child) => child.name === name) : [];
}

/** The first direct child named `name`, or null. */
export function xmlChild(element: XmlElement | null | undefined, name: string): XmlElement | null {
  return element?.children.find((child) => child.name === name) ?? null;
}

/** The trimmed text of the first direct child named `name`; null when it is missing or empty. */
export function xmlText(element: XmlElement | null | undefined, name: string): string | null {
  const text = xmlChild(element, name)?.text.trim();
  return text ? text : null;
}

// ------------------------------------------------------------------------------------------------- feed hosts

/**
 * The company a feed's address or name gives ("acme", "acme.recruitee.com", "https://acme.jobs.personio.de/job/1"):
 * one DNS label in lower case, under one of `suffixes` when an address is given; '' when there is none.
 */
export function tenantOf(input: string, suffixes: readonly string[]): string {
  let text = input.trim().toLowerCase();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text) || text.includes('.') || text.includes('/')) {
    let host: string;
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
    } catch {
      return '';
    }
    const suffix = suffixes.find((candidate) => host.endsWith(`.${candidate}`));
    if (!suffix) return '';
    text = host.slice(0, -(suffix.length + 1));
  }
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(text) ? text : '';
}

// ------------------------------------------------------------------------------------------------- sitemaps

/** One address a sitemap lists, with its last change when it says one. */
export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

/** A sitemap file read: a list of pages (`urlset`) or of further sitemaps (`sitemapindex`). */
export interface ParsedSitemap {
  kind: 'urlset' | 'sitemapindex';
  entries: SitemapEntry[];
}

/** An http(s) address a sitemap may list (no other scheme, no longer than SITEMAP_MAX_LOC), or null. */
function webAddress(value: string | null): string | null {
  if (!value || value.length > SITEMAP_MAX_LOC) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A sitemap file's entries (its `<url>` or `<sitemap>` elements' `<loc>` and `<lastmod>`), or null for any other XML. */
export function parseSitemap(xml: string): ParsedSitemap | null {
  const root = parseXml(xml);
  if (!root || (root.name !== 'urlset' && root.name !== 'sitemapindex')) return null;
  const kind = root.name;
  const entries: SitemapEntry[] = [];
  for (const element of xmlChildren(root, kind === 'urlset' ? 'url' : 'sitemap')) {
    const loc = webAddress(xmlText(element, 'loc'));
    if (loc) entries.push({ loc, lastmod: xmlText(element, 'lastmod') });
  }
  return { kind, entries };
}

/** What one sitemap read found. */
export interface SitemapRead {
  /** The pages listed, in the order read (no address twice), at most SITEMAP_MAX_URLS. */
  entries: SitemapEntry[];
  /** The sitemap itself answered 404 or 410. */
  notFound: boolean;
  /** Files fetched. */
  files: number;
  /** Child sitemaps not read: on another host, gzipped, past SITEMAP_MAX_FILES, missing or not a sitemap. */
  skipped: string[];
  /** Addresses past SITEMAP_MAX_URLS were left out. */
  truncated: boolean;
}

export interface SitemapReadOptions {
  signal?: AbortSignal;
  /** The hosts a redirect may lead to (the client's own rule otherwise). */
  allowRedirectHost?: (host: string) => boolean;
  /** Files fetched at most (SITEMAP_MAX_FILES). */
  maxFiles?: number;
}

/**
 * Reads the sitemap at `url` through the ingest client (its pace, robots.txt, size cap) and, for an index, its child
 * sitemaps on the same host. Throws IngestError when the sitemap itself is not one; a child that is not is skipped.
 */
export async function readSitemap(http: IngestHttp, url: string, options: SitemapReadOptions = {}): Promise<SitemapRead> {
  const host = new URL(url).hostname;
  const maxFiles = options.maxFiles ?? SITEMAP_MAX_FILES;
  const read: SitemapRead = { entries: [], notFound: false, files: 0, skipped: [], truncated: false };
  const seen = new Set<string>();
  const listed = new Set<string>();
  const queue = [url];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (read.files >= maxFiles) {
      read.skipped.push(next);
      continue;
    }
    read.files += 1;
    const answer = await http.getJson(next, {
      signal: options.signal,
      text: true,
      allow: [404, 410],
      ...(options.allowRedirectHost ? { allowRedirectHost: options.allowRedirectHost } : {}),
    });
    const first = next === url;
    if (answer.status === 404 || answer.status === 410) {
      if (first) read.notFound = true;
      else read.skipped.push(next);
      continue;
    }
    const parsed = typeof answer.data === 'string' ? parseSitemap(answer.data) : null;
    if (!parsed) {
      if (first) throw new IngestError(`${url} is not a sitemap.`);
      read.skipped.push(next);
      continue;
    }
    if (parsed.kind === 'sitemapindex') {
      for (const entry of parsed.entries) {
        if (seen.has(entry.loc)) continue;
        seen.add(entry.loc);
        const child = new URL(entry.loc);
        if (child.hostname !== host || /\.gz$/i.test(child.pathname)) read.skipped.push(entry.loc);
        else queue.push(entry.loc);
      }
      continue;
    }
    for (const entry of parsed.entries) {
      if (listed.has(entry.loc)) continue;
      if (read.entries.length >= SITEMAP_MAX_URLS) {
        read.truncated = true;
        break;
      }
      listed.add(entry.loc);
      read.entries.push(entry);
    }
  }
  return read;
}
