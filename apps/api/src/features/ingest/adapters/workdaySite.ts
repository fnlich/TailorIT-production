import { addablePosting, parseAtsUrl } from '@tailorit/shared/autofill';
import { constantsOf } from '../../../core/constants/index';
import { nowIso, type AppDeps } from '../../../core/context';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
// The one close function (core/seams re-exports it from here; a test's vi.mock of this path reaches this import too).
import { closeLink } from '../close';
import { HostHeldError } from '../http';
import { storedSourceJobId } from '../normalize';
import { assertRobotsAllow, hostRobots, RobotsRefusal } from '../robots';
import { readSitemap } from '../sitemap';
import { IngestError, SourceNotFoundError, type AdapterContext, type FetchFailure, type RawPosting, type SourceRecord } from '../types';
import { str } from './common';
import { defineAdapter } from './define';
import { isWorkdayHost, readWorkdayPosting, workdayTenant, type WorkdayRef } from './workday';

// v30 S3: a Workday career site, listed by its own sitemap (docs/design/part2/12-job-sourcing.md §3.2, §8.1, §8.3, §11
// phase 3; the owner's answer to question 11: sitemaps only, the site's own search call is not built).
//
// A source is one career site of one tenant: config `{ host, tenant, careerSite, companyName? }` (host
// <tenant>.wd<n>.myworkdayjobs.com, its first label the tenant, or wd<n>.myworkdaysite.com with the tenant in the
// path). Its board alias is the tenant's (`workday:<tenant>`: companies/aliases.ts reads config.tenant, so every site
// of a tenant is one company's). Its host is the tenant's (sources.ts feedHostOf): one pace for every site of it.
//
// A run, after the identity guard (a new kind of read: BOT_USER_AGENT, assertNewReadAllowed 'feed_read'):
//   1. the tenant's robots.txt (it must allow the sitemap) and its `Sitemap:` lines: the one of this career site, else
//      the site's own /<site>/siteMap.xml; a sitemap that answers 404 is a site that is gone (SourceNotFoundError);
//   2. the sitemap's postings (their addresses parsed by the shared Workday parser, this tenant, host and site only);
//   3. each posting read on its own, through today's per-posting read (adapters/workday.ts readWorkdayPosting: the
//      tenant's robots.txt for its paths, the answer capped and checked), WORKDAY_SITE_READS_PER_RUN at most, in turn:
//      new postings (and closed ones the sitemap lists again), then live ones the sitemap no longer lists (read again
//      after WORKDAY_SITE_UNLISTED_RECHECK_HOURS: absence alone never closes), then listed ones not read for
//      WORKDAY_SITE_RECHECK_DAYS (so every live posting is read within the unverified window, 12 §8.3);
//   4. a live answer is a posting the run stores; each link read (live or gone) gets liveness_checked_at (the unverified
//      sweep reads it); a gone answer (404/410, an error code, `posted: false`) closes its link through closeLink
//      (reason `gone`), and its job once no live link is left (12 §8.1: "Workday postings close by their reads").
// The sitemap is never taken as complete (12 §3.2: whether Workday caps one at 100 addresses is unknown, and its
// completeness check needs the site's own count, the search call that is not built), so the run is `partial` and
// nothing closes by absence. A held host stops the reads (the run keeps what it read); a robots.txt that refuses one
// posting's read is that posting's failure.

/** This kind's new read (core/http/identity.ts; scheduler.ts NEW_READ_KIND_OF maps the kind to it). */
const NEW_READ: NewReadKind = 'feed_read';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A career site's name as Workday's addresses write it. */
const CAREER_SITE = /^[A-Za-z0-9_-]{1,100}$/;
/** A locale segment before a site in a Workday address (en-US). */
const LOCALE_SEGMENT = /^\/[a-z]{2,3}(?:-[a-z0-9]{2,4})?(?=\/)/i;

/** A Workday career site as a source's config names it. */
export interface WorkdaySite {
  host: string;
  /** Lower case: the host's first label, or the path's on myworkdaysite.com. */
  tenant: string;
  /** As written (Workday reads it in any case). */
  careerSite: string;
  /** '' on a tenant's own host; /recruiting/<tenant> on myworkdaysite.com. */
  prefix: string;
  companyName: string | null;
}

/** The career site a source's config names; throws IngestError for one TailorIT does not read. */
export function workdaySiteOf(config: Record<string, unknown>): WorkdaySite {
  const host = (str(config.host) ?? '').toLowerCase();
  if (!isWorkdayHost(host)) {
    throw new IngestError('This source has no Workday host (<tenant>.wd<n>.myworkdayjobs.com). Edit the source and add it.');
  }
  const careerSite = str(config.careerSite) ?? '';
  if (!CAREER_SITE.test(careerSite)) throw new IngestError('This source has no Workday career site name. Edit the source and add it.');
  const shared = host.endsWith('.myworkdaysite.com');
  // The tenant is named in the config even where the host names it: the source's board alias reads it there.
  const tenant = workdayTenant(str(config.tenant) ?? '');
  if (!tenant || (!shared && host.slice(0, host.indexOf('.')) !== tenant)) {
    throw new IngestError("This source has no Workday tenant, or not its host's. Edit the source and add it.");
  }
  return { host, tenant, careerSite, prefix: shared ? `/recruiting/${tenant}` : '', companyName: str(config.companyName) };
}

/** The career site's own sitemap path: <prefix>/<site>/siteMap.xml (Workday's spelling). */
export const workdaySitemapPath = (site: WorkdaySite) => `${site.prefix}/${site.careerSite}/siteMap.xml`;

/** An address's path without a leading locale segment, in lower case ("/en-US/External/x" -> "/external/x"). */
function pathOf(url: URL): string {
  return url.pathname.replace(LOCALE_SEGMENT, '').toLowerCase();
}

/**
 * The sitemap to read for the career site: the first of the tenant's announced `Sitemap:` lines that is this site's
 * (on its host, <prefix>/<site>/siteMap.xml in any case, a locale before it allowed), else the site's own path.
 */
export function workdaySitemapOf(site: WorkdaySite, announced: readonly string[]): string {
  const wanted = workdaySitemapPath(site).toLowerCase();
  for (const line of announced) {
    try {
      const url = new URL(line);
      if (url.protocol === 'https:' && url.hostname === site.host && pathOf(url) === wanted) return url.href;
    } catch {
      /* not an address */
    }
  }
  return `https://${site.host}${workdaySitemapPath(site)}`;
}

/**
 * The career sites a Workday host's robots.txt announces sitemaps for (its `Sitemap:` lines on that host:
 * [<locale>/][recruiting/<tenant>/]<site>/siteMap.xml), each once, as written: what discovery offers as this kind's
 * sources (one per site).
 */
export function workdayCareerSitesOf(host: string, sitemaps: readonly string[]): string[] {
  const sites = new Map<string, string>();
  const shape = host.endsWith('.myworkdaysite.com')
    ? /^\/recruiting\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]{1,100})\/sitemap\.xml$/i
    : /^\/([A-Za-z0-9_-]{1,100})\/sitemap\.xml$/i;
  for (const line of sitemaps) {
    try {
      const url = new URL(line);
      if (url.hostname !== host) continue;
      const site = shape.exec(url.pathname.replace(LOCALE_SEGMENT, ''))?.[1];
      if (site && !sites.has(site.toLowerCase())) sites.set(site.toLowerCase(), site);
    } catch {
      /* not an address */
    }
  }
  return [...sites.values()];
}

/**
 * The posting an address names when it is one of this tenant's on this host (any of its career sites when `anySite`,
 * else this one), with the read's parts; null otherwise.
 */
export function workdaySiteRef(address: string, site: WorkdaySite, anySite = false): WorkdayRef | null {
  const posting = addablePosting(parseAtsUrl(address));
  if (posting?.kind !== 'workday' || !posting.workday) return null;
  if (posting.workday.host !== site.host || posting.board !== site.tenant) return null;
  if (!anySite && posting.workday.site.toLowerCase() !== site.careerSite.toLowerCase()) return null;
  return { ...posting.workday, tenant: site.tenant, reqId: posting.externalId };
}

/** A posting's title as its address's slug writes it ("Senior-Engineer--Platform_R123" -> "Senior Engineer Platform"). */
function titleOfSlug(posting: string): string {
  let slug = posting.slice(0, posting.lastIndexOf('_'));
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* kept as written */
  }
  return slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || posting;
}

/** One of the source's links as the run reads it. */
interface KnownLink {
  source_job_id: string;
  job_id: number;
  live: boolean;
  /** When it was last read or seen: its first sighting, its last liveness read, its close (the latest of them). */
  read_at: string;
  apply_url: string | null;
}

/** A posting this run reads: its id as links keep it, the read's parts, its link when the source has one. */
interface Planned {
  id: string;
  ref: WorkdayRef;
  link: KnownLink | null;
}

type RunDeps = Pick<AppDeps, 'db'>;

/**
 * The source's links a run plans with, the longest unread first: every live one, and the closed ones the sitemap lists
 * again (planWorkdayReads reads no other closed link). A link's job address only where the plan reads it: a live link
 * the sitemap no longer lists.
 *
 * v30 FIX-PERF (PG-LOAD PGL-11): it read every link the source ever had, closed ones included (they are never
 * deleted), each with its job, sorted: 52,761 links for the largest Workday source at mix B's size (13,605 of them
 * live), 652 ms a run and growing every month. Now the live links on idx_jsl_live, and each listed posting's closed
 * link by the primary key (one probe each: LIMIT 1 keeps the planner from joining the source's whole history).
 */
async function knownLinks(deps: RunDeps, sourceId: number, listed: readonly string[]): Promise<KnownLink[]> {
  const db = deps.db;
  return db.all<KnownLink>(
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
}

/**
 * Which postings this run reads (see the top), at most `budget`: new ones in the sitemap's order, then live ones the
 * sitemap no longer lists, then listed ones read too long ago (each group the longest unread first). Answers the plan
 * and the live links it could not read again (no Workday address of this tenant on their job).
 */
export function planWorkdayReads(
  listed: ReadonlyMap<string, WorkdayRef>,
  known: readonly KnownLink[],
  site: WorkdaySite,
  options: { now: number; budget: number; recheckMs: number; unlistedMs: number },
): { plan: Planned[]; unreadable: number } {
  const byId = new Map(known.map((link) => [link.source_job_id, link]));
  const due = (link: KnownLink, wait: number) => options.now - Date.parse(link.read_at) >= wait;
  const fresh: Planned[] = [];
  for (const [id, ref] of listed) {
    const link = byId.get(id) ?? null;
    if (!link) fresh.push({ id, ref, link });
    else if (!link.live && due(link, options.unlistedMs)) fresh.push({ id, ref, link });
  }
  const unlisted: Planned[] = [];
  const stale: Planned[] = [];
  let unreadable = 0;
  for (const link of known) {
    if (!link.live) continue;
    const ref = listed.get(link.source_job_id);
    if (ref) {
      if (due(link, options.recheckMs)) stale.push({ id: link.source_job_id, ref, link });
      continue;
    }
    if (!due(link, options.unlistedMs)) continue;
    const own = link.apply_url ? workdaySiteRef(link.apply_url, site, true) : null;
    if (own && storedSourceJobId(own.reqId).toLowerCase() === link.source_job_id.toLowerCase()) {
      unlisted.push({ id: link.source_job_id, ref: own, link });
    } else {
      unreadable += 1;
    }
  }
  return { plan: [...fresh, ...unlisted, ...stale].slice(0, Math.max(0, options.budget)), unreadable };
}

/** A read's failure as a sentence. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const workdaySiteAdapter = defineAdapter({
  kind: 'workday_site',
  label: 'Workday career site',
  access: 'page',
  hosts: ['*.myworkdayjobs.com', '*.myworkdaysite.com'],
  robotsPaths(source: SourceRecord) {
    try {
      const site = workdaySiteOf(source.config);
      return [workdaySitemapPath(site), `${site.prefix}/${site.careerSite}/job/`, `/wday/cxs/${site.tenant}/${site.careerSite}/job/`];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx: AdapterContext) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const site = workdaySiteOf(source.config);
    const signal = ctx.signal;
    const robotsOptions = { signal, ignoreCase: true, allowRedirectHost: isWorkdayHost };
    // 1. The tenant's robots.txt: it must allow the site's sitemap, and it may announce it.
    await assertRobotsAllow(ctx.http, site.host, [workdaySitemapPath(site)], robotsOptions);
    const announced = (await hostRobots(ctx.http, site.host, robotsOptions)).sitemaps;
    const sitemapUrl = workdaySitemapOf(site, announced);
    // 2. The sitemap's postings.
    const sitemap = await readSitemap(ctx.http, sitemapUrl, { signal, allowRedirectHost: isWorkdayHost });
    if (sitemap.notFound) {
      throw new SourceNotFoundError(`Workday has no career site "${site.careerSite}" on ${site.host} (its sitemap answered 404).`);
    }
    const listed = new Map<string, WorkdayRef>();
    let foreign = 0;
    for (const entry of sitemap.entries) {
      const ref = workdaySiteRef(entry.loc, site);
      if (!ref) foreign += 1;
      else if (!listed.has(storedSourceJobId(ref.reqId))) listed.set(storedSourceJobId(ref.reqId), ref);
    }
    ctx.log(
      `Workday site ${site.tenant}/${site.careerSite}: the sitemap lists ${listed.size} postings` +
        `${foreign ? ` (${foreign} other addresses skipped)` : ''}${sitemap.skipped.length ? `; ${sitemap.skipped.length} sitemaps not read` : ''}.`,
    );

    // The admin's Test (stores nothing): the listing alone, titles from the addresses.
    if (ctx.listingOnly || source.id <= 0) {
      const postings: RawPosting[] = [...listed.values()].map((ref) => ({
        sourceJobId: ref.reqId,
        title: titleOfSlug(ref.posting),
        company: { name: site.companyName ?? site.tenant },
        url: `https://${ref.host}${site.prefix}/${ref.site}/job/${ref.location}/${ref.posting}`,
      }));
      return { postings, complete: false, failures: [] };
    }

    // 3. Each planned posting read on its own.
    const deps = ctx.deps;
    const constants = constantsOf(deps);
    const known = await knownLinks(deps, source.id, [...listed.keys()]);
    const { plan, unreadable } = planWorkdayReads(listed, known, site, {
      now: deps.now().getTime(),
      budget: constants.get('WORKDAY_SITE_READS_PER_RUN'),
      recheckMs: constants.get('WORKDAY_SITE_RECHECK_DAYS') * DAY,
      unlistedMs: constants.get('WORKDAY_SITE_UNLISTED_RECHECK_HOURS') * HOUR,
    });
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    const checked: string[] = [];
    const gone: KnownLink[] = [];
    let goneUnstored = 0;
    let read = 0;
    let stopped: string | null = null;
    for (const item of plan) {
      if (signal.aborted) throw new IngestError('The run was stopped before it finished.');
      read += 1;
      try {
        const answer = await readWorkdayPosting(ctx.http, item.ref, site.companyName, signal);
        if (item.link) checked.push(item.id);
        if (answer.found) postings.push(answer.raw);
        else if (item.link?.live) gone.push(item.link);
        else goneUnstored += 1;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof HostHeldError || (error instanceof RobotsRefusal && error.reason === 'unreadable')) {
          read -= 1;
          stopped = messageOf(error);
          break;
        }
        failures.push({ sourceJobId: item.ref.reqId, message: `Posting ${item.ref.reqId}: ${messageOf(error)}` });
      }
    }

    // 4. The links read get their liveness time; the gone ones close (their jobs once no live link is left).
    // v31 RUNS: a run paused (or stopped) once its postings were read closes nothing (its next run reads them again).
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
        { label: 'workday site: postings gone' },
      );
    }
    ctx.log(
      `Read ${read} of ${plan.length} planned postings: ${postings.length} live, ${gone.length} gone (${jobsClosed} jobs closed)` +
        `${goneUnstored ? `, ${goneUnstored} new ones already gone` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`,
    );
    if (unreadable) ctx.log(`${unreadable} live postings the sitemap no longer lists have no Workday address to read them by.`);
    if (stopped) ctx.log(`The reads stopped early: ${stopped}`);
    return { postings, complete: false, failures, closedByRead: jobsClosed };
  },
});
