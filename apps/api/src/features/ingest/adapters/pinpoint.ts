import { COUNTRIES, escapeHtml } from '@tailorit/shared';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { PINPOINT_BOARD, pinpointCompany } from '@tailorit/shared/sourcing';
import { runFeedCache, type FeedCache } from '../boards/feed-cache';
import type { CompanyFacts } from '../boards/types';
import type { IngestHttp } from '../http';
import { parseXml, xmlChild, xmlChildren, xmlText } from '../sitemap';
import { IngestError, SourceNotFoundError, type FetchFailure, type RawPosting, type RawSalary } from '../types';
import { arrangementOf, isRecord, nameFromSlug, num, periodOf, records, str, type Json } from './common';
import { defineAdapter } from './define';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 5; REQUEST.md 5; EVIDENCE.md 5, read 2026-11-25): a company's Pinpoint
// careers site, <company>.pinpointhq.com, read from its two public feeds (no key; robots.txt allows both):
//   - GET /postings.json: { data: [{ id (numeric: NOT the posting's UUID), url (https://<host>/en/postings/<uuid>), path,
//     title, description, key_responsibilities, skills_knowledge_expertise, benefits (HTML, each with its _header; any
//     may be null), compensation_minimum / _maximum / _currency / _frequency / _visible, employment_type_text,
//     workplace_type, job { id, department { name } }, location { city, name, province }, reporting_to (a person's
//     name: never read or kept) }] }: every open posting, no paging (about 500 kB on a large board): read once a run.
//     A posting is matched by the UUID in its url/path; one missing from it is closed. No posted date, no company name.
//   - GET /jobs.rss (RSS 2.0): the channel's title "Careers at <Company>" names the company; each item's link is
//     /jobs/<job.id> and its pubDate is the only posted date (joined on postings.json's job.id). Best effort: a run (or a
//     link's read) whose feed of dates cannot be read keeps the postings without dates.
//
// A source: config `{ company, companyName? }`. A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';

/** The most of either feed read (postings.json ran to 516 kB, jobs.rss to 376 kB, on a board of some 60 postings). */
export const PINPOINT_FEED_MAX_BYTES = 16 * 1024 * 1024;
/** The RSS feed is asked for as XML. */
const RSS_ACCEPT = 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5';
/** A posting's UUID in its path. */
const POSTING_UUID = /\/postings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

/** A Pinpoint source's site: its company and host; throws IngestError for none. */
export function pinpointSiteOf(config: Record<string, unknown>): { company: string; host: string } {
  const company = pinpointCompany(str(config.company) ?? '');
  const host = company ? PINPOINT_BOARD.hostOf({ company }) : null;
  if (!host) throw new IngestError('This source has no Pinpoint company name ({company}.pinpointhq.com). Edit the source and add it.');
  return { company, host };
}

/** What a site's two feeds say: its postings (by UUID, in the feed's order), its company's name, each job's posted date. */
export interface PinpointFeed {
  postings: Map<string, Json>;
  companyName: string | null;
  /** RSS pubDate (ISO) by postings.json's job.id. */
  postedAt: Map<string, string>;
}

/** A posting's UUID (lower case) from its url or path; null for none. */
export function pinpointUuidOf(posting: Json): string | null {
  for (const value of [posting.url, posting.path]) {
    const match = POSTING_UUID.exec(str(value) ?? '');
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}

/**
 * The company's name and each job's posted date from jobs.rss: the channel's title without its "Careers at" (REQUEST.md
 * 5), and each item's pubDate by the job id its link names (/jobs/<id>).
 */
export function readPinpointRss(xml: string): { companyName: string | null; postedAt: Map<string, string> } {
  const channel = xmlChild(parseXml(xml), 'channel');
  const title = xmlText(channel, 'title');
  const companyName = title ? title.replace(/^careers\s+at\s+/i, '').trim() || null : null;
  const postedAt = new Map<string, string>();
  for (const item of xmlChildren(channel, 'item')) {
    const id = /\/jobs\/(\d{1,20})(?:[/?#]|$)/.exec(xmlText(item, 'link') ?? '')?.[1];
    const date = Date.parse(xmlText(item, 'pubDate') ?? '');
    if (id && Number.isFinite(date) && !postedAt.has(id)) postedAt.set(id, new Date(date).toISOString());
  }
  return { companyName: companyName && companyName.length <= 200 ? companyName : null, postedAt };
}

/**
 * The site's feeds read (postings.json, then jobs.rss best effort), each at most PINPOINT_FEED_MAX_BYTES, on the site's
 * host only. Throws SourceNotFoundError when postings.json answers 404, IngestHttpError when Pinpoint fails.
 */
export async function readPinpointFeed(http: IngestHttp, site: { company: string; host: string }, signal?: AbortSignal): Promise<PinpointFeed> {
  const answer = await http.getJson(`https://${site.host}/postings.json`, {
    signal,
    allow: [404],
    maxBytes: PINPOINT_FEED_MAX_BYTES,
    allowRedirectHost: (host) => host === site.host,
  });
  if (answer.status === 404) throw new SourceNotFoundError(`Pinpoint has no careers site "${site.company}" (${site.host}). Check the company name.`);
  if (!isRecord(answer.data) || !Array.isArray(answer.data.data)) throw new IngestError(`Pinpoint answered without the postings of "${site.company}".`);
  const postings = new Map<string, Json>();
  for (const posting of records(answer.data.data)) {
    const uuid = pinpointUuidOf(posting);
    if (uuid && !postings.has(uuid)) postings.set(uuid, posting);
  }
  let rss: ReturnType<typeof readPinpointRss> = { companyName: null, postedAt: new Map() };
  try {
    const feed = await http.getJson(`https://${site.host}/jobs.rss`, {
      signal,
      text: true,
      accept: RSS_ACCEPT,
      allow: [404],
      maxBytes: PINPOINT_FEED_MAX_BYTES,
      allowRedirectHost: (host) => host === site.host,
    });
    if (feed.status === 200 && typeof feed.data === 'string') rss = readPinpointRss(feed.data);
  } catch (error) {
    if (signal?.aborted) throw error;
    // Best effort: the postings stand without their dates and the company's own name.
  }
  return { postings, companyName: rss.companyName, postedAt: rss.postedAt };
}

/** A section of a posting (its header and its HTML), as HTML. */
function sectionHtml(posting: Json, field: string): string | null {
  const html = str(posting[field]);
  if (!html) return null;
  const header = str(posting[`${field}_header`]);
  return header ? `<h3>${escapeHtml(header)}</h3>\n${html}` : html;
}

/** Its pay, when the posting shows it. */
function salaryOf(posting: Json): RawSalary | null {
  if (posting.compensation_visible === false) return null;
  const min = num(posting.compensation_minimum);
  const max = num(posting.compensation_maximum);
  if ((min === null || min <= 0) && (max === null || max <= 0)) return null;
  return {
    min: min && min > 0 ? min : null,
    max: max && max > 0 ? max : null,
    currency: str(posting.compensation_currency),
    period: periodOf(posting.compensation_frequency),
    raw: str(posting.compensation),
  };
}

/** Whether a place's words name a country (its name or an alias, in any case). */
function isCountryName(text: string): boolean {
  const words = text.trim().toLowerCase();
  return Object.values(COUNTRIES).some((country) => country.name.toLowerCase() === words || country.aliases.includes(words));
}

/**
 * Its place as the places reader reads it: one place, "<city>, <province>, <country>" ("Austin, Texas"; "Texas, United
 * States"; the location's name when it names nothing else).
 * v38 FIX-A (SP v38 FIXES-38 item 10, REVIEW38-ux M2): Pinpoint's region-level locations write the country (or the
 * region itself) in `city` and `name` ({city "United States", name "United States", province "California"}; {city,
 * name, province all "Portugal"}): a city that repeats the province, or that is a country, is no city. The country goes
 * last (the city's when it is one, else the name's when that is one), so the place reads as one ("California, United
 * States", region CA), never two.
 */
function placeOf(posting: Json): string | null {
  const location = isRecord(posting.location) ? posting.location : null;
  if (!location) return null;
  const city = str(location.city);
  const province = str(location.province);
  const name = str(location.name);
  const same = (a: string | null, b: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
  const country = city && isCountryName(city) ? city : name && isCountryName(name) ? name : null;
  const parts = [city && !same(city, province) && !same(city, country) ? city : null, province, country].filter((part): part is string => Boolean(part));
  const unique = parts.filter((part, index) => parts.findIndex((other) => same(other, part)) === index);
  if (unique.length > 0) return unique.join(', ');
  return name;
}

/** One posting as a RawPosting (never its reporting_to); null without a UUID or a title. */
export function pinpointPosting(posting: Json, host: string, companyName: string, postedAt: ReadonlyMap<string, string>): RawPosting | null {
  const uuid = pinpointUuidOf(posting);
  const title = str(posting.title);
  if (!uuid || !title) return null;
  const path = POSTING_UUID.exec(str(posting.path) ?? '') ? str(posting.path)! : `/en/postings/${uuid}`;
  const html = [str(posting.description), sectionHtml(posting, 'key_responsibilities'), sectionHtml(posting, 'skills_knowledge_expertise'), sectionHtml(posting, 'benefits')]
    .filter(Boolean)
    .join('\n');
  const job = isRecord(posting.job) ? posting.job : {};
  const jobId = str(job.id);
  const place = placeOf(posting);
  const arrangement = arrangementOf(posting.workplace_type);
  return {
    sourceJobId: uuid,
    title,
    company: { name: companyName },
    descriptionHtml: html || null,
    url: `https://${host}${path.split(/[?#]/)[0]}`,
    locations: place ? [place] : arrangement === 'remote' ? ['Remote'] : [],
    workArrangement: arrangement,
    employmentText: str(posting.employment_type_text) ?? str(posting.employment_type)?.replace(/_/g, ' ') ?? null,
    department: isRecord(job.department) ? str(job.department.name) : null,
    salary: salaryOf(posting),
    postedAt: jobId ? (postedAt.get(jobId) ?? null) : null,
  };
}

/** The name the site's postings go by: the source's, else its feed's channel title's, else its address's made readable. */
export const pinpointCompanyNameOf = (feed: Pick<PinpointFeed, 'companyName'>, company: string, named: string | null) =>
  named ?? feed.companyName ?? nameFromSlug(company);

/** What the site's feed says about its company (A6). */
export const pinpointCompanyFacts = (feed: Pick<PinpointFeed, 'companyName'>): CompanyFacts => ({ name: feed.companyName });

/** A site's feed through a feed cache (a run's, or the server's for links' reads), keyed by kind and company. */
export function pinpointFeedThrough(cache: Pick<FeedCache<PinpointFeed>, 'read'> | null, http: IngestHttp, site: { company: string; host: string }, signal?: AbortSignal): Promise<PinpointFeed> {
  const load = () => readPinpointFeed(http, site, signal);
  return cache ? cache.read(`pinpoint:${site.company}`, load) : load();
}

export const pinpointAdapter = defineAdapter({
  kind: 'pinpoint',
  label: 'Pinpoint careers site',
  access: 'api',
  hosts: ['*.pinpointhq.com'],
  robotsPaths(source) {
    try {
      pinpointSiteOf(source.config);
      return ['/postings.json', '/jobs.rss'];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const site = pinpointSiteOf(source.config);
    // Each feed read once a run.
    const feed = await pinpointFeedThrough(runFeedCache<PinpointFeed>(), ctx.http, site, ctx.signal);
    const companyName = pinpointCompanyNameOf(feed, site.company, str(source.config.companyName));
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    for (const posting of feed.postings.values()) {
      const raw = pinpointPosting(posting, site.host, companyName, feed.postedAt);
      if (raw) postings.push(raw);
      else failures.push({ message: 'A posting has no address or title.' });
    }
    ctx.log(`Pinpoint ${site.company}: ${postings.length} postings${feed.postedAt.size === 0 ? ' (no posted dates: its RSS feed was not read)' : ''}.`);
    return { postings, complete: true, failures };
  },
});
