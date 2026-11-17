import { siteAlias } from '@tailorit/shared';
import type { DbQueries } from '../../../core/db/types';
import { registrableDomain } from '../../companies/domain';
import { createRobotsStore } from '../hosts';
import { ROBOTS_KEEP_MS, robotsVerdict, type StoredRobots } from '../robots';
import type { CareerDeps } from './switch';

// v30 S5: the checks a career run makes itself before it asks the shared reader for anything (12 §11 phase 5's exit
// checks: "no read against a disallow", "an opt-out removes a site within a day"). The reader (E2's siteReader) checks
// robots.txt and the opt-outs again on every read; these come first, from what the database already holds, so a
// disallowed or opted-out address is never even handed to it:
// - robots.txt: the host's file as site_robots keeps it (read by the reader or the worker, used at most ROBOTS_KEEP_MS,
//   24 hours, RFC 9309). A fresh file that disallows the path: the address is skipped; a fresh "unreachable" (429, 5xx,
//   no answer): nothing is read from the host this run. No fresh file: the reader reads robots.txt first itself.
// - opt-outs: the host or a parent domain on crawl_opt_outs, or the site's company opted out (its site:<host> board
//   alias or its domain alias, companies.do_not_fetch).

/** robots.txt's say about one address: `unknown` when no fresh file is kept (the reader then reads it first). */
export type StoredVerdict = 'allowed' | 'disallowed' | 'unreachable' | 'unknown';

/** The host's robots.txt as site_robots keeps it, judged per address; one database read per host until forgotten. */
export interface RobotsCheck {
  verdict(address: string): Promise<StoredVerdict>;
  /** The host's file as kept (its Sitemap: lines), or null. */
  stored(host: string): Promise<StoredRobots | null>;
  /** Reads the host's row again on the next ask (after the reader may have read robots.txt). */
  forget(host: string): void;
}

export function createRobotsCheck(deps: CareerDeps): RobotsCheck {
  const store = createRobotsStore(deps);
  const kept = new Map<string, StoredRobots | null>();
  const stored = async (host: string): Promise<StoredRobots | null> => {
    if (!kept.has(host)) kept.set(host, await store.read(host));
    return kept.get(host) ?? null;
  };
  return {
    stored,
    forget: (host) => void kept.delete(host),
    async verdict(address) {
      let url: URL;
      try {
        url = new URL(address);
      } catch {
        return 'disallowed';
      }
      const robots = await stored(url.hostname.toLowerCase());
      if (!robots) return 'unknown';
      const fetched = Date.parse(robots.fetchedAt);
      if (!Number.isFinite(fetched) || deps.now().getTime() - fetched > ROBOTS_KEEP_MS) return 'unknown';
      return robotsVerdict(robots, [`${url.pathname}${url.search}`]);
    },
  };
}

/** The host and each parent domain of two or more labels (careers.acme.com: careers.acme.com, acme.com). */
export function domainsOfHost(host: string): string[] {
  const labels = host.split('.');
  const out: string[] = [];
  for (let at = 0; at <= labels.length - 2; at += 1) out.push(labels.slice(at).join('.'));
  return out;
}

/** Whether a career site's host opted out (see the top). */
export async function hostOptedOut(db: DbQueries, host: string): Promise<boolean> {
  const domains = domainsOfHost(host);
  const registrable = registrableDomain(host);
  const row = await db.one<{ opted: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM crawl_opt_outs o WHERE o.domain IN (SELECT value FROM ${db.dialect.jsonEach('?')}))
          OR EXISTS (SELECT 1 FROM company_aliases a JOIN companies c ON c.id = a.company_id
                      WHERE c.do_not_fetch AND ((a.kind = 'board' AND a.value = ?)
                        OR (a.kind IN ('domain', 'domain_shared') AND a.value = ?)))) AS opted`,
    [JSON.stringify(domains), siteAlias(host) ?? '', registrable ?? ''],
  );
  return row?.opted === true;
}
