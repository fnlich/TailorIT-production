import { HOUR_MS, type WorkArrangement } from '@tailorit/shared';
import { TEAMTAILOR_BOARD, teamtailorCompany } from '@tailorit/shared/sourcing';
import { constantsOf } from '../../../core/constants/index';
import { nowIso } from '../../../core/context';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
// The one close function (core/seams re-exports it from here; a test's vi.mock of this path reaches this import too).
import { closeLink } from '../close';
import { expiredAt, jobPostingOf, pageJobPosting, type JobPostingData } from '../career/jsonld';
import type { CompanyFacts } from '../boards/types';
import { HostHeldError, IngestHttpError, type IngestHttp } from '../http';
import { holdOf } from '../hosts';
import { RobotsRefusal } from '../robots';
import { parseXml, xmlChild, xmlChildren, xmlText } from '../sitemap';
import { IngestError, SourceNotFoundError, type AdapterContext, type FetchFailure, type RawPosting, type SourceRecord } from '../types';
import { arrangementOf, isRecord, nameFromSlug, records, str, type Json } from './common';
import { defineAdapter } from './define';

// v38 ATS-A (SP v38 PLAN "Final coverage" row 24; REQUEST.md 24; EVIDENCE.md 24, read 2026-11-25): a company's Teamtailor
// careers site, <company>.teamtailor.com (no key; robots.txt allows /jobs.json, /jobs.rss and the job pages):
//   - GET /jobs.json, a JSON Feed 1.1: { title, items: [{ id (a UUID), title, url (https://<host>/jobs/<number>-<slug>),
//     date_published, content_html, _jobposting: one schema.org JobPosting (identifier.value = the job's number,
//     datePosted, employmentType, hiringOrganization { name, logo }, jobLocation [...]) }] }: the company's listed jobs,
//     its first 100 by default (a larger board is read page by page with ?offset=, at most TEAMTAILOR_MAX_PAGES; a page
//     that adds no job ends it);
//   - a job's own page, /jobs/<number>[-<slug>], carries the same JobPosting as JSON-LD; an unknown number answers 404.
// A job a company leaves out of its feed (an unlisted job) is still open (REQUEST.md 24): a job missing from the feed is
// never closed for it. A run reads the feed, then the pages of its live jobs the feed no longer lists (at most
// TEAMTAILOR_UNLISTED_READS_PER_RUN, each at most once in TEAMTAILOR_UNLISTED_RECHECK_HOURS): a page with its JobPosting
// keeps the job (read again), a 404 or a past validThrough closes it (closeLink, reason `gone`); every other one is seen.
// A link's read takes the job from the feed (read once and reused briefly), else from its page.
// v38 FIX-A (SP v38 FIXES-38 items 8 and 12; REVIEW38-beh M11, L8):
//   - remote or hybrid: neither jobs.json nor the job's page says (no jobLocationType); GET /jobs.rss does, each item's
//     `remoteStatus` ("none", "hybrid", "fully", "temporary") by the job number in its link. It is read with the feed,
//     once (a run's, and a link's read through the feed cache), best effort (a feed of dates that cannot be read leaves
//     the jobs as the JSON feed says);
//   - a job's page whose JobPosting names another job number (its identifier) is can't read, never that job's text;
//   - a feed page after the first that holds no items ends the reads, the feed not whole (nothing closes by absence).
//
// A source: config `{ company, companyName? }`. A new kind of read: the identity guard first ('feed_read').

const NEW_READ: NewReadKind = 'feed_read';
/** v38 FIX-A (M11): the RSS feed is asked for as XML. */
const RSS_ACCEPT = 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5';

/** The most of a feed page read (257 kB for 17 jobs; its 100 jobs a page run to some 2 MB). */
export const TEAMTAILOR_FEED_MAX_BYTES = 16 * 1024 * 1024;
/** The most of a job's page read (some 130 kB). */
export const TEAMTAILOR_PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** The jobs a feed page holds by default (REQUEST.md 24): a page of fewer is the last. */
export const TEAMTAILOR_FEED_PAGE = 100;
/** The most feed pages a run reads (2,000 jobs). */
export const TEAMTAILOR_MAX_PAGES = 20;
/** The feed and the pages are asked for as what they are. */
const FEED_ACCEPT = 'application/feed+json,application/json;q=0.9,*/*;q=0.5';
const PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
/** A job's number in its address. */
const JOB_NUMBER = /\/jobs\/(\d{1,12})(?:-[^/?#]*)?\/?(?:[?#]|$)/;

/** A Teamtailor source's site: its company and host; throws IngestError for none. */
export function teamtailorSiteOf(config: Record<string, unknown>): { company: string; host: string } {
  const company = teamtailorCompany(str(config.company) ?? '');
  const host = company ? TEAMTAILOR_BOARD.hostOf({ company }) : null;
  if (!host) throw new IngestError('This source has no Teamtailor company name ({company}.teamtailor.com). Edit the source and add it.');
  return { company, host };
}

/** A job's number from its address; null for none. */
export const teamtailorNumberOf = (address: string | null | undefined) => JOB_NUMBER.exec(address ?? '')?.[1] ?? null;

/** A feed page's address (the first, then ?offset=). */
export const teamtailorFeedUrl = (host: string, offset = 0) => `https://${host}/jobs.json${offset > 0 ? `?offset=${offset}` : ''}`;

/** One listed job: its number, its feed item and its JobPosting. */
export interface TeamtailorItem {
  id: string;
  item: Json;
  posting: JobPostingData | null;
}

/** The company's feed: its jobs by number (in the feed's order), whether it was read whole, and its company's facts. */
export interface TeamtailorFeed {
  jobs: Map<string, TeamtailorItem>;
  whole: boolean;
  company: CompanyFacts;
  /** v38 FIX-A (M11): each job's work arrangement by its number, from jobs.rss (empty when it was not read). */
  arrangements: Map<string, WorkArrangement>;
}

/** v38 FIX-A (M11): an RSS item's remoteStatus as a work arrangement ("none" is on site); null for none. */
export function teamtailorArrangementOf(status: string | null): WorkArrangement | null {
  const value = status?.trim().toLowerCase() ?? '';
  if (!value) return null;
  if (value === 'none') return 'onsite';
  if (value === 'hybrid') return 'hybrid';
  if (value === 'fully' || value === 'temporary' || value === 'remote') return 'remote';
  return arrangementOf(value);
}

/** v38 FIX-A (M11): each job's work arrangement in jobs.rss, by the job number its link names. */
export function readTeamtailorRss(xml: string): Map<string, WorkArrangement> {
  const arrangements = new Map<string, WorkArrangement>();
  for (const item of xmlChildren(xmlChild(parseXml(xml), 'channel'), 'item')) {
    const id = teamtailorNumberOf(xmlText(item, 'link'));
    const arrangement = teamtailorArrangementOf(xmlText(item, 'remoteStatus'));
    if (id && arrangement && !arrangements.has(id)) arrangements.set(id, arrangement);
  }
  return arrangements;
}

/** v38 FIX-A (M11): jobs.rss read best effort (on the company's host only); empty when it cannot be read. */
async function readArrangements(http: IngestHttp, site: { host: string }, signal?: AbortSignal): Promise<Map<string, WorkArrangement>> {
  try {
    const feed = await http.getJson(`https://${site.host}/jobs.rss`, {
      signal,
      text: true,
      accept: RSS_ACCEPT,
      allow: [404, 410],
      maxBytes: TEAMTAILOR_FEED_MAX_BYTES,
      allowRedirectHost: (host) => host === site.host,
    });
    return feed.status === 200 && typeof feed.data === 'string' ? readTeamtailorRss(feed.data) : new Map();
  } catch (error) {
    // A held lane or a 429 stops every read of the platform: it is the read's answer (nothing more is sent).
    if (signal?.aborted || error instanceof HostHeldError || (error instanceof IngestHttpError && error.status === 429)) throw error;
    return new Map(); // best effort: the jobs stand as the JSON feed says
  }
}

/** A feed item's number: its JobPosting's identifier, else its url's. */
function numberOfItem(item: Json, posting: JobPostingData | null): string | null {
  const identifier = posting?.identifier ?? null;
  if (identifier && /^\d{1,12}$/.test(identifier)) return identifier;
  return teamtailorNumberOf(str(item.url));
}

/** What a JobPosting says about the company (A6): its name and logo. */
function companyFactsOf(posting: JobPostingData | null): CompanyFacts {
  return { name: posting?.hiringOrganization?.name ?? null, logoUrl: posting?.hiringOrganization?.logo ?? null };
}

/**
 * The company's feed, page by page (`pages` at most; a link's read takes its first page alone), each at most
 * TEAMTAILOR_FEED_MAX_BYTES, on the company's host only, then (v38 FIX-A, M11) its jobs' work arrangements from
 * jobs.rss. Throws SourceNotFoundError when it answers 404.
 */
export async function readTeamtailorFeed(
  http: IngestHttp,
  site: { company: string; host: string },
  options: { signal?: AbortSignal; pages?: number; failures?: FetchFailure[] } = {},
): Promise<TeamtailorFeed> {
  const read = await readTeamtailorJobs(http, site, options);
  return { ...read, arrangements: await readArrangements(http, site, options.signal) };
}

/** The JSON feed's pages (readTeamtailorFeed's first part). */
async function readTeamtailorJobs(
  http: IngestHttp,
  site: { company: string; host: string },
  options: { signal?: AbortSignal; pages?: number; failures?: FetchFailure[] },
): Promise<Omit<TeamtailorFeed, 'arrangements'>> {
  const jobs = new Map<string, TeamtailorItem>();
  let company: CompanyFacts = { name: null };
  const pages = Math.max(1, options.pages ?? TEAMTAILOR_MAX_PAGES);
  for (let page = 0; page < pages; page += 1) {
    let answer;
    try {
      answer = await http.getJson(teamtailorFeedUrl(site.host, page * TEAMTAILOR_FEED_PAGE), {
        signal: options.signal,
        accept: FEED_ACCEPT,
        allow: [404],
        maxBytes: TEAMTAILOR_FEED_MAX_BYTES,
        allowRedirectHost: (host) => host === site.host,
      });
    } catch (error) {
      if (page === 0 || options.signal?.aborted) throw error;
      options.failures?.push({ message: `Page ${page + 1} of the job feed could not be read.` });
      return { jobs, whole: false, company };
    }
    if (answer.status === 404) {
      if (page === 0) throw new SourceNotFoundError(`Teamtailor has no careers site "${site.company}" (${site.host}). Check the company name.`);
      return { jobs, whole: false, company };
    }
    if (!isRecord(answer.data) || !Array.isArray(answer.data.items)) {
      if (page === 0) throw new IngestError(`Teamtailor answered without the jobs of "${site.company}".`);
      // v38 FIX-A (L8): a later page that holds no feed ends the reads, the feed not whole (nothing closes by absence).
      options.failures?.push({ message: `Page ${page + 1} of the job feed held no jobs.` });
      return { jobs, whole: false, company };
    }
    const items = records(answer.data.items);
    let added = 0;
    for (const item of items) {
      const posting = isRecord(item._jobposting) ? jobPostingOf(item._jobposting) : null;
      const id = numberOfItem(item, posting);
      if (!id || jobs.has(id)) continue;
      jobs.set(id, { id, item, posting });
      added += 1;
      if (!company.name && posting?.hiringOrganization?.name) company = companyFactsOf(posting);
    }
    // A short page is the last; a page that adds no job (an ignored ?offset=) ends the reads, not whole.
    if (items.length < TEAMTAILOR_FEED_PAGE) return { jobs, whole: true, company };
    if (added === 0) return { jobs, whole: false, company };
  }
  // Every page read was full: the feed may go on past them (nothing closes by its absence).
  return { jobs, whole: false, company };
}

/** A JobPosting's places, remote ones too ("Remote, Sweden"). */
function placesOf(posting: JobPostingData | null): string[] {
  if (!posting) return [];
  const remote = posting.remote ? (posting.applicantLocations.length > 0 ? posting.applicantLocations.map((name) => `Remote, ${name}`) : ['Remote']) : [];
  return [...posting.locations, ...remote];
}

/** The job's own address on the company's host (its feed's url, its page's), else /jobs/<number>. */
function jobUrlOf(given: string | null, host: string, id: string): string {
  try {
    const url = given ? new URL(given) : null;
    if (url && url.protocol === 'https:' && url.hostname === host && teamtailorNumberOf(url.pathname) === id) return `https://${host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    /* the built address */
  }
  return `https://${host}/jobs/${id}`;
}

/**
 * A listed job as a RawPosting; null without a title. v38 FIX-A (M11): its work arrangement is its JobPosting's remote
 * (TELECOMMUTE), else jobs.rss's remoteStatus (`arrangement`).
 */
export function teamtailorPosting(job: TeamtailorItem, host: string, companyName: string, arrangement: WorkArrangement | null = null): RawPosting | null {
  const title = str(job.item.title) ?? job.posting?.title ?? null;
  if (!title) return null;
  return {
    sourceJobId: job.id,
    title,
    company: { name: companyName },
    descriptionHtml: str(job.item.content_html) ?? job.posting?.descriptionHtml ?? null,
    url: jobUrlOf(str(job.item.url), host, job.id),
    locations: placesOf(job.posting),
    workArrangement: job.posting?.remote ? 'remote' : arrangement,
    employmentText: job.posting?.employmentText ?? null,
    salary: job.posting?.salary ?? null,
    postedAt: job.posting?.datePosted ?? str(job.item.date_published),
  };
}

/** A job read from its own page (its JSON-LD) as a RawPosting. */
function pagePosting(posting: JobPostingData, host: string, id: string, page: string, companyName: string): RawPosting {
  return {
    sourceJobId: id,
    title: posting.title,
    company: { name: companyName },
    descriptionHtml: posting.descriptionHtml,
    url: jobUrlOf(posting.url ?? page, host, id),
    locations: placesOf(posting),
    workArrangement: posting.remote ? 'remote' : null,
    employmentText: posting.employmentText,
    salary: posting.salary,
    industry: posting.industry,
    postedAt: posting.datePosted,
  };
}

/** A job's page read: its posting (and its company's facts), gone (404, 410, a past validThrough), or no JobPosting. */
export type TeamtailorPageRead = { found: true; raw: RawPosting; company: CompanyFacts } | { found: false } | { found: false; noPosting: true };

/**
 * One job read from its own page (at most TEAMTAILOR_PAGE_MAX_BYTES, on the company's host only): its JSON-LD JobPosting
 * as a RawPosting, gone (404, 410, a past validThrough at `now`), or a page with no JobPosting (`noPosting`). Throws
 * IngestHttpError when Teamtailor fails, RobotsRefusal when robots.txt refuses the read, and (v38 FIX-A, L8) IngestError
 * when the page's JobPosting names another job number (its identifier): never another job's text under this one.
 */
export async function readTeamtailorPage(
  http: IngestHttp,
  site: { company: string; host: string },
  id: string,
  options: { page?: string | null; named?: string | null; signal?: AbortSignal; now: Date },
): Promise<TeamtailorPageRead> {
  const page = jobUrlOf(options.page ?? null, site.host, id);
  const answer = await http.getJson(page, {
    signal: options.signal,
    text: true,
    accept: PAGE_ACCEPT,
    allow: [404, 410],
    maxBytes: TEAMTAILOR_PAGE_MAX_BYTES,
    allowRedirectHost: (host) => host === site.host,
  });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  const posting = pageJobPosting(typeof answer.data === 'string' ? answer.data : '', page);
  if (!posting) return { found: false, noPosting: true };
  // v38 FIX-A (L8): its JobPosting is this job's (its identifier is the job's number when it gives one).
  if (posting.identifier && /^\d{1,12}$/.test(posting.identifier) && posting.identifier !== id) throw new IngestError("Teamtailor's page holds another job.");
  if (expiredAt(posting, options.now)) return { found: false };
  const company = companyFactsOf(posting);
  return { found: true, raw: pagePosting(posting, site.host, id, page, options.named ?? company.name ?? nameFromSlug(site.company)), company };
}

/** A live link of the source the feed does not list, with its job's own address. */
interface UnlistedLink {
  source_job_id: string;
  job_id: number;
  apply_url: string | null;
}

/**
 * The run's reads of its live jobs the feed no longer lists (see the top): the ones due a read (none in
 * TEAMTAILOR_UNLISTED_RECHECK_HOURS), at most TEAMTAILOR_UNLISTED_READS_PER_RUN, the longest unread first. Answers the
 * postings read (still open), the ids seen (every unlisted live link not read gone) and the jobs it closed.
 */
async function readUnlisted(
  source: SourceRecord,
  ctx: AdapterContext,
  site: { company: string; host: string },
  listed: ReadonlySet<string>,
  named: string | null,
  failures: FetchFailure[],
): Promise<{ postings: RawPosting[]; seen: string[]; closed: number; stopped: boolean; heldUntil: string | null }> {
  const deps = ctx.deps;
  const constants = constantsOf(deps);
  const budget = constants.get('TEAMTAILOR_UNLISTED_READS_PER_RUN');
  const before = new Date(deps.now().getTime() - constants.get('TEAMTAILOR_UNLISTED_RECHECK_HOURS') * HOUR_MS).toISOString();
  const rows = await deps.db.all<UnlistedLink & { due: boolean }>(
    `SELECT l.source_job_id, l.job_id, j.apply_url,
       GREATEST(l.last_seen_at, l.liveness_checked_at) <= CAST(? AS timestamptz) AS due
     FROM job_source_links l JOIN jobs j ON j.id = l.job_id
     WHERE l.source_id = ? AND l.missing_since IS NULL
       AND NOT (l.source_job_id IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')}))
     ORDER BY GREATEST(l.last_seen_at, l.liveness_checked_at), l.source_job_id`,
    [before, source.id, JSON.stringify([...listed])],
  );
  const seen = rows.map((row) => row.source_job_id);
  const due = rows.filter((row) => row.due === true).slice(0, budget);
  const postings: RawPosting[] = [];
  const checked: string[] = [];
  const gone: UnlistedLink[] = [];
  let stopped = false;
  let heldUntil: string | null = null;
  for (const link of due) {
    if (ctx.signal.aborted) throw new IngestError('The run was stopped before it finished.');
    try {
      const read = await readTeamtailorPage(ctx.http, site, link.source_job_id, {
        page: link.apply_url,
        named,
        signal: ctx.signal,
        now: deps.now(),
      });
      checked.push(link.source_job_id);
      if (read.found) postings.push(read.raw);
      else if (!('noPosting' in read)) gone.push(link);
      else failures.push({ sourceJobId: link.source_job_id, message: `Job ${link.source_job_id}'s page holds no JobPosting.` });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const rateLimited = error instanceof IngestHttpError && !(error instanceof HostHeldError) && error.status === 429;
      if (error instanceof HostHeldError || rateLimited || (error instanceof RobotsRefusal && error.reason === 'unreadable')) {
        stopped = true;
        if (error instanceof HostHeldError) heldUntil = error.until;
        else if (rateLimited) heldUntil = (await holdOf(deps.db, site.host, nowIso(deps)))?.until ?? null;
        break;
      }
      const status = error instanceof IngestHttpError ? ` (HTTP ${error.status})` : '';
      failures.push({ sourceJobId: link.source_job_id, message: `Job ${link.source_job_id}'s page could not be read${status}.` });
    }
  }
  const at = nowIso(deps);
  if (checked.length > 0) {
    await deps.db.run(
      `UPDATE job_source_links SET liveness_checked_at = CAST(? AS timestamptz)
       WHERE source_id = ? AND source_job_id IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})`,
      [at, source.id, JSON.stringify(checked)],
    );
  }
  let closed = 0;
  if (gone.length > 0) {
    await deps.db.tx(
      async (t) => {
        for (const link of gone) {
          const result = await closeLink(deps, t, { jobId: link.job_id, link: { sourceId: source.id, sourceJobId: link.source_job_id }, reason: 'gone', at });
          if (result.jobClosed) closed += 1;
        }
      },
      { label: 'teamtailor: unlisted jobs gone' },
    );
  }
  const goneIds = new Set(gone.map((link) => link.source_job_id));
  const readIds = new Set(postings.map((posting) => posting.sourceJobId));
  ctx.log(
    `Teamtailor ${site.company}: ${rows.length} live jobs its feed does not list; read ${checked.length} of ${due.length} due ` +
      `(${postings.length} still open, ${gone.length} gone, ${closed} jobs closed).`,
  );
  return { postings, seen: seen.filter((id) => !goneIds.has(id) && !readIds.has(id)), closed, stopped, heldUntil };
}

export const teamtailorAdapter = defineAdapter({
  kind: 'teamtailor',
  label: 'Teamtailor careers site',
  access: 'api',
  hosts: ['*.teamtailor.com'],
  robotsPaths(source) {
    try {
      teamtailorSiteOf(source.config);
      return ['/jobs.json', '/jobs.rss', '/jobs/']; // v38 FIX-A (M11): jobs.rss too
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const site = teamtailorSiteOf(source.config);
    const failures: FetchFailure[] = [];
    const feed = await readTeamtailorFeed(ctx.http, site, { signal: ctx.signal, failures });
    const named = str(source.config.companyName);
    const companyName = named ?? feed.company.name ?? nameFromSlug(site.company);
    const postings: RawPosting[] = [];
    for (const job of feed.jobs.values()) {
      const raw = teamtailorPosting(job, site.host, companyName, feed.arrangements.get(job.id) ?? null); // v38 FIX-A (M11)
      if (raw) postings.push({ ...raw, company: { ...raw.company, ...(feed.company.logoUrl ? { logoSourceUrl: feed.company.logoUrl } : {}) } });
      else failures.push({ sourceJobId: job.id, message: 'A listed job has no title.' });
    }
    ctx.log(`Teamtailor ${site.company}: ${postings.length} listed jobs${feed.whole ? '' : ' (the feed was not read whole)'}.`);
    if (ctx.listingOnly || source.id <= 0) return { postings, complete: feed.whole, failures };
    // The live jobs the feed no longer lists: never closed for it (an unlisted job is open); their own pages decide.
    const unlisted = await readUnlisted(source, ctx, site, new Set(feed.jobs.keys()), named ?? feed.company.name, failures);
    return {
      postings: [...postings, ...unlisted.postings],
      complete: feed.whole && !unlisted.stopped,
      failures,
      skippedIds: unlisted.seen,
      closedByRead: unlisted.closed,
      ...(unlisted.heldUntil ? { heldUntil: unlisted.heldUntil } : {}),
    };
  },
});
