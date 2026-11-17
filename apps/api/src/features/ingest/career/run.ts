import { linkKey, type JobSourceKind } from '@tailorit/shared';
import { parseAtsUrl } from '@tailorit/shared/autofill';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { closeLink, offerToDiscovery } from '../../../core/seams';
import { companyDomainsOf, registrableDomain } from '../../companies/domain';
import { storedSourceJobId } from '../normalize';
import { RobotsRefusal } from '../robots';
import {
  IngestError,
  SourceNotFoundError,
  type AdapterContext,
  type FetchFailure,
  type FetchResult,
  type RawPosting,
  type SourceRecord,
} from '../types';
import { careerSiteConfigOf, type CareerSiteConfig } from './config';
import { createRobotsCheck, hostOptedOut, type RobotsCheck } from './guards';
import { expiredAt, pageJobPosting, type JobPostingData } from './jsonld';
import { careerKeysOf } from './keys';
import { readPage } from './read';
import { isPostingAddress, parseSitemap, sitemapsByPromise, sitemapText } from './sitemap';
import { assertCareerPagesAllowed, CareerSiteOptedOutError } from './switch';

// v30 S5: one run of a career site (docs/design/part2/12-job-sourcing.md §3.4, §8.1, §8.6, §11 phase 5), behind
// SITE_READER_CAREER_PAGES (off) and the identity guard (switch.ts), every read through the shared reader (read.ts).
//
//   1. The sitemaps: the source's own, else the ones its robots.txt announces, else /sitemap.xml; an index's sitemaps
//      (the promising ones first), at most CAREER_SITEMAPS_PER_RUN files. Only posting addresses on the site's host are
//      kept (sitemap.ts isPostingAddress), each with its lastmod.
//   2. Which pages to read, at most CAREER_PAGE_READS_PER_RUN (12 §8.6: per-posting reads inside the source's run,
//      capped): first the live postings the sitemaps no longer list (absence only triggers a read), then new addresses
//      (newest first), then listed postings whose lastmod is newer than their last read, then live postings not read
//      for CAREER_RECHECK_AFTER_DAYS (oldest first), so each live posting is read again well within the 30 days of
//      JOB_UNVERIFIED_HIDE_DAYS. A closed posting the sitemap still lists is read again only when its lastmod moved.
//   3. Each page: its own JobPosting (jsonld.ts). Live: a posting (its keys: keys.ts; its hiringOrganization for the
//      hand-off: handoff.ts, from the store). Gone (12 §8.1): 404 or 410, the markup removed, or a past validThrough:
//      the link closes through the one close function (closeLink, reason `gone`). A page robots.txt disallows is not
//      read and its link is left as it is. When every live page read in a run lost its markup (at least
//      CAREER_SUSPECT_MIN of them), the site changed, not its postings: nothing closes (12 §8.2's rule, for pages).
//   4. The answer: the postings read; every live posting not read this run in `skippedIds` (seen: a sitemap's silence
//      never closes a career posting); `complete` when the sitemaps were read whole and no read was cut short. The run
//      writes each live link's liveness_checked_at (the unverified sweep reads it) and offers the ATS boards the
//      postings point at to discovery (12 §4.1 signal 5, `cross_link`).
// A Test or a discovery validation (ctx.listingOnly) reads the sitemaps and CAREER_VALIDATION_PAGES pages, and writes
// nothing.

/** Pages a Test or a validation reads. */
export const CAREER_VALIDATION_PAGES = 3;
/** Posting addresses one run keeps from its sitemaps. */
export const CAREER_LISTED_MAX = 50_000;
// v30 INT-4: a run's pages (CAREER_PAGE_READS_PER_RUN), sitemap files (CAREER_SITEMAPS_PER_RUN) and a live page's
// re-read (CAREER_RECHECK_AFTER_DAYS) are central constants (constants.ts), read at each run.
/** Live pages that must all have lost their markup before the run calls it a site change (nothing closes). */
export const CAREER_SUSPECT_MIN = 5;
/** Link ids one statement looks up. */
const LOOKUP_CHUNK = 1000;
/** The ATS kinds whose boards a career page's links offer to discovery (the four public APIs). */
const CROSS_LINK_KINDS: ReadonlySet<string> = new Set(['greenhouse', 'lever', 'ashby', 'workable']);

/** A listed posting address. */
interface Listed {
  address: string;
  /** Epoch ms, or null. */
  lastmod: number | null;
}

/** A live link of the source. */
interface LiveLink {
  sourceJobId: string;
  jobId: number;
  /** When its page was last read live (its first sighting when never): epoch ms. */
  checkedAt: number;
}

/** A posting's id on a career site: its address's link key (https, tracking parameters dropped), as stored. */
export function careerPostingIdOf(address: string): string | null {
  const key = linkKey(address);
  return key ? storedSourceJobId(key) : null;
}

/** An https address on the host's registrable domain (an index's sitemap, robots.txt's Sitemap: line), or null. */
function siteAddress(value: string, host: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    const own = url.hostname.toLowerCase();
    return own === host || (registrableDomain(own) !== null && registrableDomain(own) === registrableDomain(host)) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The sitemaps the host's robots.txt announces (as kept in site_robots), on its own domain. */
async function announcedSitemaps(robots: RobotsCheck, host: string): Promise<string[]> {
  const stored = await robots.stored(host);
  return (stored?.sitemaps ?? []).map((address) => siteAddress(address, host)).filter((address): address is string => address !== null);
}

/** Step 1: the posting addresses the sitemaps list (see the top). Throws when no sitemap could be read. */
async function readSitemaps(
  deps: AppDeps,
  robots: RobotsCheck,
  config: CareerSiteConfig,
  ctx: AdapterContext,
): Promise<{ listed: Map<string, Listed>; partial: boolean; files: number }> {
  const host = config.host;
  const queue: string[] = [];
  const queued = new Set<string>();
  const add = (address: string) => {
    if (!queued.has(address)) {
      queued.add(address);
      queue.push(address);
    }
  };
  for (const address of config.sitemaps) add(address);
  if (queue.length === 0) for (const address of await announcedSitemaps(robots, host)) add(address);
  const fallback = `https://${host}/sitemap.xml`;
  if (queue.length === 0) add(fallback);

  const listed = new Map<string, Listed>();
  let files = 0;
  let readable = 0;
  let missing = 0;
  let partial = false;
  let refusal: Error | null = null;
  const maxFiles = constantsOf(deps).get('CAREER_SITEMAPS_PER_RUN');
  while (queue.length > 0 && files < maxFiles) {
    if (ctx.signal.aborted) throw new IngestError('The run was stopped before it finished.');
    const address = queue.shift()!;
    files += 1;
    const page = await readPage(deps, robots, address, 'xml');
    if (page.kind === 'stop') throw page.error;
    // The reader read robots.txt before its first ask of the host: its Sitemap: lines join the queue.
    if (address === fallback && config.sitemaps.length === 0) for (const announced of await announcedSitemaps(robots, host)) add(announced);
    if (page.kind === 'disallowed') {
      refusal ??= new RobotsRefusal('disallowed', `${host}'s robots.txt disallows its sitemap ${new URL(address).pathname}: the site is not read.`);
      partial = true;
      continue;
    }
    if (page.kind === 'gone') {
      missing += 1;
      continue;
    }
    if (page.kind === 'failed') {
      ctx.log(`The sitemap ${address} could not be read: ${page.message}`);
      partial = true;
      continue;
    }
    const text = sitemapText(page.body);
    const parsed = text === null ? null : parseSitemap(text);
    if (!parsed || parsed.kind === 'none') {
      ctx.log(`${address} is not a sitemap.`);
      partial = true;
      continue;
    }
    readable += 1;
    if (parsed.truncated) partial = true;
    if (parsed.kind === 'index') {
      for (const entry of sitemapsByPromise(parsed.entries)) {
        const child = siteAddress(entry.loc, host);
        if (child) add(child);
      }
      continue;
    }
    for (const entry of parsed.entries) {
      if (!isPostingAddress(entry.loc, host, config.postingPaths)) continue;
      const id = careerPostingIdOf(entry.loc);
      if (!id) continue;
      if (listed.size >= CAREER_LISTED_MAX && !listed.has(id)) {
        partial = true;
        break;
      }
      const lastmod = entry.lastmod ? Date.parse(entry.lastmod) : null;
      const before = listed.get(id);
      if (!before || (lastmod ?? 0) > (before.lastmod ?? 0)) listed.set(id, { address: entry.loc.trim(), lastmod });
    }
  }
  if (queue.length > 0) partial = true;
  if (readable === 0) {
    if (refusal) throw refusal;
    if (missing > 0 && !partial) {
      throw new SourceNotFoundError(`${host} has no sitemap TailorIT can read (/sitemap.xml and robots.txt's Sitemap: lines answered 404).`);
    }
    throw new IngestError(`${host}'s sitemaps could not be read this time; the run is tried again later.`);
  }
  return { listed, partial, files };
}

/** The source's live links (idx_jsl_live). */
async function liveLinksOf(db: DbQueries, sourceId: number): Promise<Map<string, LiveLink>> {
  const rows = await db.all<{ source_job_id: string; job_id: number; checked_at: string }>(
    `SELECT source_job_id, job_id, COALESCE(liveness_checked_at, first_seen_at) AS checked_at
     FROM job_source_links WHERE source_id = ? AND missing_since IS NULL`,
    [sourceId],
  );
  return new Map(rows.map((row) => [row.source_job_id, { sourceJobId: row.source_job_id, jobId: Number(row.job_id), checkedAt: Date.parse(row.checked_at) }]));
}

/** Of `ids`, the source's closed links and when each closed (epoch ms). */
async function closedLinksOf(db: DbQueries, sourceId: number, ids: readonly string[]): Promise<Map<string, number>> {
  const closed = new Map<string, number>();
  for (let start = 0; start < ids.length; start += LOOKUP_CHUNK) {
    const rows = await db.all<{ source_job_id: string; missing_since: string }>(
      `SELECT source_job_id, missing_since FROM job_source_links
       WHERE source_id = ? AND missing_since IS NOT NULL AND source_job_id IN (SELECT value FROM ${db.dialect.jsonEach('?')})`,
      [sourceId, JSON.stringify(ids.slice(start, start + LOOKUP_CHUNK))],
    );
    for (const row of rows) closed.set(row.source_job_id, Date.parse(row.missing_since));
  }
  return closed;
}

/** One page to read: its address and id, and whether it is a live link of the source. */
interface PageToRead {
  address: string;
  sourceJobId: string;
  live: LiveLink | null;
  why: 'absent' | 'new' | 'changed' | 'recheck';
}

/** Step 2: the pages of this run, in order, at most `budget` (see the top). */
export function planReads(
  listed: ReadonlyMap<string, Listed>,
  live: ReadonlyMap<string, LiveLink>,
  closed: ReadonlyMap<string, number>,
  now: number,
  budget: number,
  recheckAfterDays: number,
): PageToRead[] {
  const oldestFirst = (a: LiveLink, b: LiveLink) => a.checkedAt - b.checkedAt;
  const absent = [...live.values()]
    .filter((link) => !listed.has(link.sourceJobId) && /^https:\/\//.test(link.sourceJobId))
    .sort(oldestFirst)
    .map((link): PageToRead => ({ address: link.sourceJobId, sourceJobId: link.sourceJobId, live: link, why: 'absent' }));
  const fresh = [...listed.entries()]
    .filter(([id, entry]) => !live.has(id) && (!closed.has(id) || (entry.lastmod !== null && entry.lastmod > closed.get(id)!)))
    .sort(([, a], [, b]) => (b.lastmod ?? 0) - (a.lastmod ?? 0))
    .map(([id, entry]): PageToRead => ({ address: entry.address, sourceJobId: id, live: null, why: 'new' }));
  const changed: PageToRead[] = [];
  const recheck: LiveLink[] = [];
  const recheckBefore = now - recheckAfterDays * 86_400_000;
  for (const [id, entry] of listed) {
    const link = live.get(id);
    if (!link) continue;
    if (entry.lastmod !== null && entry.lastmod > link.checkedAt) changed.push({ address: entry.address, sourceJobId: id, live: link, why: 'changed' });
    else if (link.checkedAt <= recheckBefore) recheck.push(link);
  }
  const rechecks = recheck
    .sort(oldestFirst)
    .map((link): PageToRead => ({ address: listed.get(link.sourceJobId)!.address, sourceJobId: link.sourceJobId, live: link, why: 'recheck' }));
  return [...absent, ...fresh, ...changed, ...rechecks].slice(0, Math.max(0, budget));
}

/** The JobPosting as a RawPosting of the site (null when no company can be named). */
export function rawPostingOf(
  data: JobPostingData,
  page: { address: string; sourceJobId: string },
  config: Pick<CareerSiteConfig, 'companyName'>,
  keys: RawPosting['keys'],
): RawPosting | null {
  const org = data.hiringOrganization;
  const companyName = org?.name ?? config.companyName;
  if (!companyName) return null;
  // The organisation's own site (its sameAs, then its url; never LinkedIn or an ATS): resolveCompany's domain hint.
  const website = org ? ([...org.sameAs, org.url].find((link): link is string => Boolean(link) && companyDomainsOf([link]).length > 0) ?? null) : null;
  const remote = data.remote ? (data.applicantLocations.length > 0 ? data.applicantLocations.map((name) => `Remote, ${name}`) : ['Remote']) : [];
  return {
    sourceJobId: page.sourceJobId,
    title: data.title,
    company: { name: companyName, website },
    descriptionHtml: data.descriptionHtml,
    url: page.address,
    locations: [...data.locations, ...remote],
    employmentText: data.employmentText,
    salary: data.salary,
    industry: data.industry,
    postedAt: data.datePosted,
    ...(keys && keys.length > 0 ? { keys } : {}),
    ...(org ? { hiringOrganization: { name: org.name, sameAs: org.sameAs, url: org.url, logo: org.logo } } : {}),
  };
}

/**
 * The run's writes (not a Test): the gone links closed, the live ones' read time, the boards offered (see the top).
 * Answers the jobs it closed (the run's `closedByRead`).
 */
async function settleReads(
  deps: AppDeps,
  source: SourceRecord,
  gone: readonly LiveLink[],
  liveRead: readonly string[],
  boards: ReadonlyArray<{ kind: JobSourceKind; name: string }>,
  ctx: AdapterContext,
): Promise<number> {
  const at = nowIso(deps);
  let closed = 0;
  for (const link of gone) {
    const result = await deps.db.tx(
      (t) => closeLink(deps, t, { jobId: link.jobId, link: { sourceId: source.id, sourceJobId: link.sourceJobId }, reason: 'gone', at }),
      { label: 'career page gone' },
    );
    if (result.jobClosed) closed += 1;
  }
  if (gone.length > 0) ctx.log(`${gone.length} postings are gone (404 or 410, no JobPosting any more, or past their validThrough); ${closed} jobs closed.`);
  for (let start = 0; start < liveRead.length; start += LOOKUP_CHUNK) {
    await deps.db.run(
      `UPDATE job_source_links SET liveness_checked_at = CAST(? AS timestamptz)
       WHERE source_id = ? AND source_job_id IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})`,
      [at, source.id, JSON.stringify(liveRead.slice(start, start + LOOKUP_CHUNK))],
    );
  }
  if (boards.length > 0) {
    await deps.db.tx(
      async (t) => {
        for (const board of boards) await offerToDiscovery(deps, t, { kind: board.kind, name: board.name, via: 'cross_link', at });
      },
      { label: 'career page boards' },
    );
  }
  return closed;
}

/** The ATS boards a posting's JSON-LD url names (12 §4.1 signal 5). */
function crossLinkBoard(data: JobPostingData): { kind: JobSourceKind; name: string } | null {
  const parsed = data.url ? parseAtsUrl(data.url) : null;
  return parsed && parsed.board && CROSS_LINK_KINDS.has(parsed.kind) ? { kind: parsed.kind as JobSourceKind, name: parsed.board } : null;
}

/** One run of a career_site source (see the top): the career_site adapter's fetch. */
export async function readCareerSite(source: SourceRecord, ctx: AdapterContext): Promise<FetchResult> {
  const deps = ctx.deps;
  assertCareerPagesAllowed(deps);
  const config = careerSiteConfigOf(source.config);
  if (await hostOptedOut(deps.db, config.host)) throw new CareerSiteOptedOutError(config.host);
  const robots = createRobotsCheck(deps);
  const now = deps.now();
  const { listed, partial, files } = await readSitemaps(deps, robots, config, ctx);

  const testing = ctx.listingOnly === true;
  const live = testing ? new Map<string, LiveLink>() : await liveLinksOf(deps.db, source.id);
  const closed = testing ? new Map<string, number>() : await closedLinksOf(deps.db, source.id, [...listed.keys()]);
  const c = constantsOf(deps);
  const plan = planReads(listed, live, closed, now.getTime(), testing ? CAREER_VALIDATION_PAGES : c.get('CAREER_PAGE_READS_PER_RUN'), c.get('CAREER_RECHECK_AFTER_DAYS'));
  ctx.log(`Read ${files} sitemap files: ${listed.size} posting pages listed; ${live.size} live postings; ${plan.length} pages to read.`);

  const postings: RawPosting[] = [];
  const failures: FetchFailure[] = [];
  const gone: LiveLink[] = [];
  const noMarkup: LiveLink[] = [];
  const liveRead: string[] = [];
  const carried = new Set(live.keys());
  const ldHolders = new Map<string, Set<string>>();
  const boards = new Map<string, { kind: JobSourceKind; name: string }>();
  let handled = 0;
  let disallowed = 0;
  let liveReads = 0;
  let stopped: Error | null = null;
  for (const page of plan) {
    if (ctx.signal.aborted) throw new IngestError('The run was stopped before it finished.');
    const read = await readPage(deps, robots, page.address, 'html');
    if (read.kind === 'stop') {
      stopped = read.error;
      break;
    }
    handled += 1;
    if (read.kind === 'disallowed') {
      disallowed += 1;
      continue;
    }
    if (read.kind === 'failed') {
      failures.push(page.live ? { sourceJobId: page.sourceJobId, message: read.message } : { message: read.message });
      continue;
    }
    if (page.live) liveReads += 1;
    if (read.kind === 'gone') {
      if (page.live) {
        gone.push(page.live);
        carried.delete(page.sourceJobId);
      }
      continue;
    }
    const data = pageJobPosting(read.body.toString('utf8'), page.address);
    if (!data || expiredAt(data, now)) {
      if (page.live) {
        (data ? gone : noMarkup).push(page.live);
        carried.delete(page.sourceJobId);
      }
      continue;
    }
    const keys = await careerKeysOf(deps.db, page.address, data);
    const raw = rawPostingOf(data, page, config, keys.keys);
    if (!raw) {
      failures.push({ sourceJobId: page.sourceJobId, message: `${page.address}'s JobPosting names no company (give the source a companyName).` });
      continue;
    }
    postings.push(raw);
    carried.delete(page.sourceJobId);
    if (page.live) liveRead.push(page.sourceJobId);
    if (keys.ld) ldHolders.set(keys.ld, (ldHolders.get(keys.ld) ?? new Set()).add(page.sourceJobId));
    const board = crossLinkBoard(data);
    if (board) boards.set(`${board.kind}:${board.name.toLowerCase()}`, board);
  }
  if (stopped && (testing || handled === 0)) throw stopped;

  // One identifier on several pages is no posting's own: its `ld` key is dropped from each (keys.ts).
  const shared = new Set([...ldHolders].filter(([, ids]) => ids.size > 1).map(([key]) => key));
  if (shared.size > 0) {
    for (const raw of postings) {
      const kept = raw.keys?.filter((key) => !(key.kind === 'ld' && shared.has(key.key)));
      if (kept && kept.length !== raw.keys?.length) {
        if (kept.length > 0) raw.keys = kept;
        else delete raw.keys;
      }
    }
    ctx.log(`${shared.size} JobPosting identifiers were written on more than one page: they identify no posting.`);
  }

  // Every live page read lost its markup: the site changed (a new template), not its postings: nothing closes.
  const suspect = noMarkup.length >= CAREER_SUSPECT_MIN && noMarkup.length === liveReads;
  if (suspect) {
    for (const link of noMarkup) carried.add(link.sourceJobId);
    ctx.log(`None of the ${noMarkup.length} live pages read carries its JobPosting any more: the site's pages changed, so nothing closes this time.`);
  } else {
    gone.push(...noMarkup);
  }
  if (disallowed > 0) ctx.log(`${disallowed} pages were not read: robots.txt disallows them (their postings are left as they are).`);
  if (stopped) ctx.log(`The run stopped reading pages: ${stopped.message}`);

  const closedByRead = testing ? 0 : await settleReads(deps, source, gone, liveRead, [...boards.values()], ctx);
  return {
    postings,
    complete: !partial && stopped === null && !suspect,
    failures,
    skippedIds: [...carried],
    closedByRead,
  };
}
