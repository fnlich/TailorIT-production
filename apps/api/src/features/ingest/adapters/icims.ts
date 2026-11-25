import { DAY_MS, HOUR_MS } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
// The one close function (core/seams re-exports it from here; a test's vi.mock of this path reaches this import too).
import { closeLink } from '../close';
import { expiredAt, pageJobPosting, type JobPostingData } from '../career/jsonld';
import { icimsBoardOf, icimsHostOf } from '../career/platforms';
import { HostHeldError, IngestHttpError, type IngestHttp } from '../http'; // v37 INT-B IngestHttpError
import { holdOf } from '../hosts'; // v37 INT-B
import { assertRobotsAllow, hostRobots, RobotsRefusal } from '../robots';
import { readSitemap } from '../sitemap';
import { IngestError, SourceNotFoundError, type AdapterContext, type FetchFailure, type RawPosting, type SourceRecord } from '../types';
import { nameFromSlug, str } from './common';
import { defineAdapter } from './define';
import { loadReadFailures, orderByFailures, saveReadFailures, type ReadFailures } from './read-failures'; // v37 FIX-37A

// v37 BOARDS (SP v37 PLAN I1-I4): an employer's iCIMS site as a source. iCIMS has no public API, but each employer's
// site (<board>.icims.com: careers-acme.icims.com) publishes what a reader needs, read 2026-11-24 (SP v37 EVIDENCE.md):
//   - robots.txt (User-agent: *) names its sitemap (Sitemap: https://<host>/sitemap.xml) and allows the job pages
//     (it disallows the referral, login and candidate pages, which TailorIT never reads);
//   - /sitemap.xml lists /jobs/search and one <url> per posting: https://<host>/jobs/<id>/<slug>/job with its <lastmod>;
//   - a posting's page (/jobs/<id>/<slug>/job) is a frame with no JSON-LD: its content is the same address with
//     ?in_iframe=1, one schema.org JobPosting (title, description HTML, datePosted, validThrough, hiringOrganization,
//     jobLocation) and <meta name="robots" content="index,follow">;
//   - a posting that is gone (closed, or no such id) answers 410 there.
// The owner decided on 2026-11-24 that TailorIT reads them (sources.ts KIND_TERMS: a new source starts "allowed with
// conditions" with the dated note).
//
// A source is one employer's site: config `{ board, companyName? }`, the board its host's first label (career/platforms.ts
// ICIMS_BOARD_HOST: never iCIMS's own hosts); its host is the board's (sources.ts hostOf). An employer's own domain in
// front of iCIMS (jobs.acme.com) stays a career site. A run, after the identity guard (a new kind of read: BOT_USER_AGENT,
// assertNewReadAllowed 'feed_read'), reads through the ingest client (its bot user agent, robots.txt before every read,
// the host's pace, holds), never the shared site reader (not behind SITE_READER_CAREER_PAGES):
//   1. robots.txt (it must allow the sitemap) and its `Sitemap:` lines on this host, else /sitemap.xml; a sitemap that
//      answers 404 or 410 is a site that is gone (SourceNotFoundError);
//   2. the sitemap's postings (/jobs/<id>/[<slug>/]job on this host);
//   3. each planned posting's page read as …/job?in_iframe=1 and its JobPosting (career/jsonld.ts), at most
//      ICIMS_READS_PER_RUN, in turn: new postings (and closed ones the sitemap lists again, after
//      ICIMS_UNLISTED_RECHECK_HOURS), then live ones the sitemap no longer lists (read again after
//      ICIMS_UNLISTED_RECHECK_HOURS: absence alone never closes), then listed ones not read for ICIMS_RECHECK_DAYS;
//   4. a JobPosting is a posting the run stores (its title, text, dates, places, employer, employment type, pay); each
//      link read gets liveness_checked_at; a 404 or 410, or a past validThrough, closes its link through closeLink
//      (reason `gone`), and its job once no live link is left. A page with no JobPosting is that posting's failure
//      (nothing closes).
// The sitemap is never taken as complete, so nothing closes by absence. A held host, or a robots.txt that cannot be
// read, stops the reads (the run keeps what it read).
// v37 FIX-37A (SP v37 FIXES-37): a run that read every posting it planned (none failed, none due left past the cap) ends
// `succeeded` (FetchResult.readAll; E9), any other `partial`; ICIMS_FAILURES_IN_A_ROW failed page reads in a row stop the
// reads (F2); a posting whose read failed waits and is read after the others (adapters/read-failures.ts; F8); the pages
// are asked for as HTML and the sitemap as XML (F7).
//
// Add job, an import's link and the re-checks read one posting the same way (readIcimsPosting; ingest/postings.ts,
// jobs/add/board-link.ts), so a posting is stored alike however it was read.

/** This kind's new read (core/http/identity.ts; scheduler.ts NEW_READ_KIND_OF maps the kind to it). */
const NEW_READ: NewReadKind = 'feed_read';

/** The most of one posting's page read (a page runs to about 100 kB): 2 MB. Past it the read fails (413). */
export const ICIMS_PAGE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * v37 FIX-37A (REVIEW37-beh F7): a posting's page is asked for as HTML (a browser's Accept), its sitemap as XML; never as
 * text/plain (an unusual header set for a page, and a strict server may answer 406).
 */
export const ICIMS_PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
export const ICIMS_SITEMAP_ACCEPT = 'application/xml,text/xml;q=0.9,*/*;q=0.8';

/** v37 FIX-37A (F7): a client that asks with `accept` unless the request names its own (the sitemap reader's). */
const askingFor = (http: IngestHttp, accept: string): IngestHttp => ({
  getJson: (url, options = {}) => http.getJson(url, { ...options, accept: options.accept ?? accept }),
});

/** A posting's id as iCIMS writes it (the shared lookup's rule). */
const POSTING_ID = /^\d{1,12}$/;
/** A posting's page: /jobs/<id>/[<slug>/]job. */
const POSTING_PATH = /^\/jobs\/(\d{1,12})(?:\/([^/]+))?\/job\/?$/;
/** The words a board's first label starts with that name no employer ("careers-acme" is Acme's). */
const BOARD_PREFIX = /^(?:careers?|jobs?|uscareers|external|ext)-/;

/** An iCIMS site as a source's config names it. */
export interface IcimsSite {
  board: string;
  host: string;
  companyName: string | null;
}

/** The site a source's config names; throws IngestError for one TailorIT does not read. */
export function icimsSiteOf(config: Record<string, unknown>): IcimsSite {
  const board = icimsBoardOf(str(config.board) ?? '');
  if (!board) throw new IngestError('This source has no iCIMS site (<company>.icims.com). Edit the source and add it.');
  return { board, host: icimsHostOf(board), companyName: str(config.companyName) };
}

/** A posting of the site: its id and its page's address (no query). */
export interface IcimsPostingRef {
  id: string;
  /** https://<host>/jobs/<id>/[<slug>/]job */
  page: string;
}

/** The posting an address names when it is a posting page on `host` (any page of it: the query is dropped), or null. */
export function icimsPostingRef(address: string, host: string): IcimsPostingRef | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname.toLowerCase() !== host) return null;
  const match = POSTING_PATH.exec(url.pathname);
  if (!match) return null;
  const slug = match[2] ? `/${match[2]}` : '';
  return { id: match[1]!, page: `https://${host}/jobs/${match[1]}${slug}/job` };
}

/** A posting's content page: its page with ?in_iframe=1 (the frame's inner page, which holds its JobPosting). */
export const icimsContentUrl = (page: string) => `${page}?in_iframe=1`;

/** The employer's name when neither the source nor the page names one: the board without its "careers-" word. */
export const icimsCompanyOfBoard = (board: string) => nameFromSlug(board.replace(BOARD_PREFIX, '') || board);

/** A posting's title as its page's slug writes it ("Senior-Engineer" -> "Senior Engineer"), for a listing alone. */
function titleOfPage(page: string): string {
  const slug = /\/jobs\/\d+\/([^/]+)\/job$/.exec(page)?.[1];
  if (!slug) return 'iCIMS posting';
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    /* kept as written */
  }
  return text.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim() || 'iCIMS posting';
}

/**
 * A posting's JobPosting as a RawPosting (its page the Apply link), as a career page's is read (career/run.ts
 * rawPostingOf's fields; kept here, so the adapters' registry never loads the career reader's seams): its title, text,
 * dates, places (a remote posting's applicant places too), employment type, pay and industry; the employer by name.
 */
export function icimsRawPosting(data: JobPostingData, ref: IcimsPostingRef, companyName: string): RawPosting {
  const remote = data.remote ? (data.applicantLocations.length > 0 ? data.applicantLocations.map((name) => `Remote, ${name}`) : ['Remote']) : [];
  return {
    sourceJobId: ref.id,
    title: data.title,
    company: { name: companyName },
    descriptionHtml: data.descriptionHtml,
    url: ref.page,
    locations: [...data.locations, ...remote],
    employmentText: data.employmentText,
    salary: data.salary,
    industry: data.industry,
    postedAt: data.datePosted,
  };
}

/** One posting's read: found (its posting), or gone (404, 410, a past validThrough). */
export type IcimsRead = { found: true; raw: RawPosting } | { found: false };

/**
 * One posting read from its content page (at most ICIMS_PAGE_MAX_BYTES, on the site's host only): its JobPosting as a
 * RawPosting (the posting's page its Apply link), or gone (404, 410, a past validThrough at `now`). The employer is the
 * source's companyName, else the page's hiringOrganization, else the board's name. Throws IngestHttpError when iCIMS
 * fails, RobotsRefusal when robots.txt refuses the read, and IngestError when the page holds no JobPosting.
 */
export async function readIcimsPosting(
  http: IngestHttp,
  site: IcimsSite,
  ref: IcimsPostingRef,
  options: { signal?: AbortSignal; now: Date },
): Promise<IcimsRead> {
  if (!POSTING_ID.test(ref.id) || !icimsPostingRef(ref.page, site.host)) throw new IngestError('TailorIT does not know this iCIMS posting.');
  const answer = await http.getJson(icimsContentUrl(ref.page), {
    signal: options.signal,
    text: true,
    accept: ICIMS_PAGE_ACCEPT, // v37 FIX-37A (F7)
    allow: [404, 410],
    maxBytes: ICIMS_PAGE_MAX_BYTES,
    allowRedirectHost: (to) => to === site.host,
  });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  const html = typeof answer.data === 'string' ? answer.data : '';
  const posting = pageJobPosting(html, ref.page);
  if (!posting) throw new IngestError("The posting's page holds no JobPosting.");
  // 12 §8.1: a past validThrough is a closed posting.
  if (expiredAt(posting, options.now)) return { found: false };
  const companyName = site.companyName ?? posting.hiringOrganization?.name ?? icimsCompanyOfBoard(site.board);
  return { found: true, raw: icimsRawPosting(posting, ref, companyName) };
}

/** One of the source's links as the run reads it. */
interface KnownLink {
  source_job_id: string;
  job_id: number;
  live: boolean;
  /** When it was last read or seen: its first sighting, its last read, its close (the latest of them), ISO. */
  read_at: string;
  /** Its job's Apply link, for a live link the sitemap no longer lists. */
  apply_url: string | null;
}

/** A posting this run reads, and its link when the source has one. */
interface Planned {
  ref: IcimsPostingRef;
  link: KnownLink | null;
}

/**
 * The source's links a run plans with: every live one, and the closed ones the sitemap lists again (a job's address only
 * for a live link the sitemap no longer lists).
 */
async function knownLinks(deps: Pick<AppDeps, 'db'>, sourceId: number, listed: readonly string[]): Promise<KnownLink[]> {
  const db = deps.db;
  const rows = await db.all<Omit<KnownLink, 'read_at'> & { read_at: string | Date }>(
    `WITH listed AS MATERIALIZED (SELECT value AS id FROM ${db.dialect.jsonEach('@listed')})
     SELECT k.source_job_id, k.job_id, k.live, k.read_at, k.apply_url FROM (
       SELECT l.source_job_id, l.job_id, true AS live, GREATEST(l.first_seen_at, l.liveness_checked_at) AS read_at,
         CASE WHEN l.source_job_id IN (SELECT id FROM listed) THEN NULL
              ELSE (SELECT j.apply_url FROM jobs j WHERE j.id = l.job_id) END AS apply_url
       FROM job_source_links l
       WHERE l.source_id = @sourceId AND l.missing_since IS NULL
       UNION ALL
       SELECT c.source_job_id, c.job_id, false, c.read_at, NULL
       FROM listed CROSS JOIN LATERAL (
         SELECT l.source_job_id, l.job_id, GREATEST(l.first_seen_at, l.liveness_checked_at, l.missing_since) AS read_at
         FROM job_source_links l
         WHERE l.source_id = @sourceId AND l.source_job_id = listed.id AND l.missing_since IS NOT NULL
         LIMIT 1) c
     ) k
     ORDER BY k.read_at, k.source_job_id`,
    { sourceId, listed: JSON.stringify(listed) },
  );
  return rows.map((row) => ({ ...row, live: row.live === true, read_at: new Date(row.read_at).toISOString() }));
}

/**
 * Which postings this run reads (see the top), at most `budget`: new ones in the sitemap's order (and closed ones it
 * lists again, once `unlistedMs` has passed since their last read), then live ones it no longer lists, then listed ones
 * read `recheckMs` ago or more (each group the longest unread first). Answers the plan and the live links it could not
 * read again (no iCIMS address of the site on their job).
 * v37 FIX-37A (REVIEW37-beh F8): a posting whose own read failed lately (`failures`, adapters/read-failures.ts) is read
 * after every other due one once its wait is over, and not at all while it waits (`waiting`); `left`: the due postings
 * past the budget (read on later runs).
 */
export function planIcimsReads(
  listed: ReadonlyMap<string, IcimsPostingRef>,
  known: readonly KnownLink[],
  host: string,
  options: { now: number; budget: number; recheckMs: number; unlistedMs: number; failures?: ReadFailures },
): { plan: Planned[]; unreadable: number; left: number; waiting: number } {
  const byId = new Map(known.map((link) => [link.source_job_id, link]));
  const due = (link: KnownLink, wait: number) => options.now - Date.parse(link.read_at) >= wait;
  const fresh: Planned[] = [];
  for (const [id, ref] of listed) {
    const link = byId.get(id) ?? null;
    if (!link) fresh.push({ ref, link });
    else if (!link.live && due(link, options.unlistedMs)) fresh.push({ ref, link });
  }
  const unlisted: Planned[] = [];
  const stale: Planned[] = [];
  let unreadable = 0;
  for (const link of known) {
    if (!link.live) continue;
    const ref = listed.get(link.source_job_id);
    if (ref) {
      if (due(link, options.recheckMs)) stale.push({ ref, link });
      continue;
    }
    if (!due(link, options.unlistedMs)) continue;
    const own = link.apply_url ? icimsPostingRef(link.apply_url, host) : null;
    if (own && own.id === link.source_job_id) unlisted.push({ ref: own, link });
    else unreadable += 1;
  }
  const { ordered, waiting } = orderByFailures([...fresh, ...unlisted, ...stale], (item) => item.ref.id, options.failures ?? new Map(), options.now);
  const budget = Math.max(0, options.budget);
  return { plan: ordered.slice(0, budget), unreadable, left: Math.max(0, ordered.length - budget), waiting };
}

/**
 * v37 FIX-37A (REVIEW37-beh F2): a run stops after this many failed page reads in a row (pages with no JobPosting: a bot
 * check answered 200, or a site's new template), marked partial; nothing closes for them (their reads back off: F8).
 */
export const ICIMS_FAILURES_IN_A_ROW = 5;

/** A read's failure as a sentence. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const icimsAdapter = defineAdapter({
  kind: 'icims',
  label: 'iCIMS career site',
  access: 'page',
  hosts: ['*.icims.com'],
  robotsPaths(source: SourceRecord) {
    try {
      icimsSiteOf(source.config);
      return ['/sitemap.xml', '/jobs/'];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx: AdapterContext) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const site = icimsSiteOf(source.config);
    const signal = ctx.signal;
    const onSite = (host: string) => host === site.host;
    // 1. robots.txt: it must allow the sitemap, and it may announce it (on this host).
    await assertRobotsAllow(ctx.http, site.host, ['/sitemap.xml'], { signal, allowRedirectHost: onSite });
    const announced = (await hostRobots(ctx.http, site.host, { signal, allowRedirectHost: onSite })).sitemaps.filter((line) => {
      try {
        const url = new URL(line);
        return url.protocol === 'https:' && url.hostname === site.host;
      } catch {
        return false;
      }
    });
    const sitemapUrl = announced[0] ?? `https://${site.host}/sitemap.xml`;
    // 2. The sitemap's postings.
    // v37 FIX-37A (F7): asked for as XML.
    const sitemap = await readSitemap(askingFor(ctx.http, ICIMS_SITEMAP_ACCEPT), sitemapUrl, { signal, allowRedirectHost: onSite });
    if (sitemap.notFound) throw new SourceNotFoundError(`iCIMS has no site at ${site.host} (its sitemap answered 404).`);
    const listed = new Map<string, IcimsPostingRef>();
    let other = 0;
    for (const entry of sitemap.entries) {
      const ref = icimsPostingRef(entry.loc, site.host);
      if (!ref) other += 1;
      else if (!listed.has(ref.id)) listed.set(ref.id, ref);
    }
    ctx.log(
      `iCIMS site ${site.host}: the sitemap lists ${listed.size} postings` +
        `${other ? ` (${other} other addresses skipped)` : ''}${sitemap.skipped.length ? `; ${sitemap.skipped.length} sitemaps not read` : ''}.`,
    );

    // The admin's Test and discovery's validation (they store nothing): the listing alone, titles from the addresses.
    if (ctx.listingOnly || source.id <= 0) {
      const company = site.companyName ?? icimsCompanyOfBoard(site.board);
      const postings: RawPosting[] = [...listed.values()].map((ref) => ({
        sourceJobId: ref.id,
        title: titleOfPage(ref.page),
        company: { name: company },
        url: ref.page,
      }));
      return { postings, complete: false, failures: [] };
    }

    // 3. Each planned posting read on its own.
    const deps = ctx.deps;
    const constants = constantsOf(deps);
    const known = await knownLinks(deps, source.id, [...listed.keys()]);
    const readFailures = await loadReadFailures(deps.db, source.id); // v37 FIX-37A (F8)
    const { plan, unreadable, left, waiting } = planIcimsReads(listed, known, site.host, {
      now: deps.now().getTime(),
      budget: constants.get('ICIMS_READS_PER_RUN'),
      recheckMs: constants.get('ICIMS_RECHECK_DAYS') * DAY_MS,
      unlistedMs: constants.get('ICIMS_UNLISTED_RECHECK_HOURS') * HOUR_MS,
      failures: readFailures,
    });
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    const checked: string[] = [];
    const gone: KnownLink[] = [];
    const answered: string[] = []; // v37 FIX-37A (F8): read, found or gone
    let goneUnstored = 0;
    let read = 0;
    let failedInARow = 0; // v37 FIX-37A (F2)
    let stopped: string | null = null;
    let heldUntil: string | null = null; // v37 INT-B
    for (const item of plan) {
      if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
      read += 1;
      try {
        const answer = await readIcimsPosting(ctx.http, site, item.ref, { signal, now: deps.now() });
        failedInARow = 0;
        answered.push(item.ref.id);
        if (item.link) checked.push(item.ref.id);
        if (answer.found) postings.push(answer.raw);
        else if (item.link?.live) gone.push(item.link);
        else goneUnstored += 1;
      } catch (error) {
        if (signal.aborted) throw error;
        // v37 INT-B (as LANE's W4 stops a Workday run): a 429 past the request's retries (no hold of its own) stops the
        // reads at once as a held host does, never grinding through the rest of the plan; the hold's end, if any, is
        // the run's (FetchResult.heldUntil: its next run is due after it).
        const rateLimited = error instanceof IngestHttpError && !(error instanceof HostHeldError) && error.status === 429;
        if (error instanceof HostHeldError || rateLimited || (error instanceof RobotsRefusal && error.reason === 'unreadable')) {
          if (!rateLimited) read -= 1;
          stopped = messageOf(error);
          if (error instanceof HostHeldError) heldUntil = error.until;
          else if (rateLimited) heldUntil = (await holdOf(deps.db, site.host, nowIso(deps)))?.until ?? null;
          break;
        }
        failures.push({ sourceJobId: item.ref.id, message: `Posting ${item.ref.id}: ${messageOf(error)}` });
        // v37 FIX-37A (F2): pages that keep holding no posting (a bot check, a new template) stop the run.
        failedInARow += 1;
        if (failedInARow >= ICIMS_FAILURES_IN_A_ROW) {
          stopped = `${ICIMS_FAILURES_IN_A_ROW} posting pages in a row could not be read (no JobPosting on them, or no answer).`;
          break;
        }
      }
    }

    // 4. The links read get their read time; the gone ones close (their jobs once no live link is left). A run paused
    // (or stopped) once its postings were read closes nothing (its next run reads them again).
    if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
    const at = nowIso(deps);
    if (checked.length > 0) {
      await deps.db.run(
        `UPDATE job_source_links SET liveness_checked_at = CAST(? AS timestamptz)
         WHERE source_id = ? AND source_job_id IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})`,
        [at, source.id, JSON.stringify(checked)],
      );
    }
    let jobsClosed = 0;
    if (gone.length > 0) {
      await deps.db.tx(
        async (t) => {
          for (const link of gone) {
            const closed = await closeLink(deps, t, {
              jobId: link.job_id,
              link: { sourceId: source.id, sourceJobId: link.source_job_id },
              reason: 'gone',
              at,
            });
            if (closed.jobClosed) jobsClosed += 1;
          }
        },
        { label: 'icims: postings gone' },
      );
    }
    ctx.log(
      `Read ${read} of ${plan.length} planned postings: ${postings.length} live, ${gone.length} gone (${jobsClosed} jobs closed)` +
        `${goneUnstored ? `, ${goneUnstored} more gone (none of them open here)` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`,
    );
    if (unreadable) ctx.log(`${unreadable} live postings the sitemap no longer lists have no iCIMS address to read them by.`);
    if (stopped) ctx.log(`The reads stopped early: ${stopped}`);
    // v37 FIX-37A (F8): the failed reads back off; a read that answered, or a posting no longer listed, forgets its failures.
    const liveIds = new Set(known.filter((link) => link.live).map((link) => link.source_job_id));
    await saveReadFailures(deps.db, source.id, readFailures, {
      failed: failures.flatMap((failure) => (failure.sourceJobId ? [failure.sourceJobId] : [])),
      answered,
      keep: (id) => listed.has(id) || liveIds.has(id),
      now: deps.now().getTime(),
    });
    if (waiting) ctx.log(`${waiting} postings whose reads failed lately wait before they are read again.`);
    if (left) ctx.log(`${left} more postings are due: later runs read them.`);
    // v37 FIX-37A (E9): every planned posting read, none failed and none left for later: the run succeeded (the sitemap
    // still closes nothing by its absence).
    const readAll = !stopped && failures.length === 0 && left === 0 && read === plan.length;
    return {
      postings,
      complete: false,
      failures,
      closedByRead: jobsClosed,
      ...(readAll ? { readAll: true } : {}),
      ...(heldUntil ? { heldUntil } : {}),
    };
  },
});
