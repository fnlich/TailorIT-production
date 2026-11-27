import type { DailyStep } from '../../../core/feature';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbTx } from '../../../core/db/types';
import { offerToDiscovery } from '../../../core/seams';
import { isCompanyDomain, registrableDomain } from '../../companies/domain';
import { isRefusedPageHost, isSiteHost, normalHost } from '../../job-reviews/hosts';
import { careerPagesOn, type CareerDeps } from './switch';
import { isBoardKindHost, isEmployerPlatformHost, isSharedPlatformHost } from './platforms'; // v30 FIX-A (REQ-5); v38 INT: isBoardKindHost

// v30 S5: finding career sites (docs/design/part2/12-job-sourcing.md §3.4 step 1, §3.5, §4.1 signal 2), behind
// SITE_READER_CAREER_PAGES like the reads themselves (PLAN §5: "S5's career-page reads and the discovery of career
// sites"). While it is off nothing is offered. Once on, the daily step `ingest.career_sites` takes, from every account
// at once, only the HOST of each new page job (a job a person made from a page TailorIT reads no API for) and of each
// new tracked application's link, never the account, the job or the text, and offers each employer host as a
// `career_site` candidate (offerToDiscovery: a count, never a user id; an opted-out site is kept `forbidden`). S2's
// validation reads a candidate once through the career_site adapter (ctx.listingOnly) before it becomes a source
// (config.ts careerSiteSourceOf). Where it stopped is kept in app_settings (CAREER_DISCOVERY_MARKER), so each job and
// application is offered once.
// v36 FIX-SRC (the final data review's D5; SP v36 PLAN S6, as discovery/links.ts): a held job (jobs.held_since: waiting
// in Admin › Review), and a Tracker entry of one, offers nothing: its site becomes a candidate only once an admin
// approves the job (job-reviews/decide.ts offers it then). The marker still moves past them.
//
// A career site is an employer's own host: an https or http page on a host TailorIT may keep as a site, not LinkedIn
// or a refused job board, and not an ATS, job board or other shared platform's domain (companies/domain.ts
// isCompanyDomain): an ATS board is S2's signal (its board, not its host).
// v30 FIX-A (REV-REQ REQ-5): except one employer's own host on an ATS platform with no public API (platforms.ts:
// careers-acme.icims.com, acme.taleo.net, acme.teamtailor.com, ...): those employers are what career pages are for.

/** app_settings' key of where the step stopped: {"job": <jobs.id>, "application": <applications.seq>}. */
export const CAREER_DISCOVERY_MARKER = 'v30:career-sites';
/** Rows one transaction of the step reads. */
export const CAREER_DISCOVERY_BATCH = 2000;
/** Batches one pass reads of each table (the rest wait for the next day). */
export const CAREER_DISCOVERY_BATCHES = 50;

/** The career site an address is on (its host), or null (see the top). */
export function careerSiteHostOf(address: string | null | undefined): string | null {
  if (!address) return null;
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = normalHost(url.hostname);
  if (!isSiteHost(host) || isRefusedPageHost(host)) return null;
  if (isSharedPlatformHost(host)) return null;
  // v38 ATS-A (SP v38 PLAN A9, FRAME open item 7), ATS-C: a host a board kind claims (a Teamtailor company's, Taleo's,
  // Avature's, Paycom's...) is that kind's board, never a career site (v38 INT: the one rule, platforms.ts isBoardKindHost,
  // as discovery/boards.ts careerSiteOfUrl reads it; offerCareerSites below takes only this function's hosts).
  if (isBoardKindHost(host)) return null;
  return isCompanyDomain(registrableDomain(host)) || isEmployerPlatformHost(host) ? host : null;
}

/**
 * Offers the career sites of these addresses as `career_site` candidates (see the top), in the caller's transaction.
 * Nothing while SITE_READER_CAREER_PAGES is off. Answers how many candidates were added or seen again.
 */
export async function offerCareerSites(
  deps: AppDeps,
  t: DbTx,
  addresses: ReadonlyArray<string | null | undefined>,
  via: 'extension' | 'application_link' | 'company_site' | 'cross_link',
  at: string,
): Promise<number> {
  if (!careerPagesOn(deps)) return 0;
  const hosts = new Set(addresses.map(careerSiteHostOf).filter((host): host is string => host !== null));
  let offered = 0;
  for (const host of [...hosts].sort()) {
    const result = await offerToDiscovery(deps, t, { kind: 'career_site', name: host, via, at });
    if (result.outcome === 'added' || result.outcome === 'bumped') offered += 1;
  }
  return offered;
}

interface Marker {
  job: number;
  application: number;
}

async function markerOf(deps: CareerDeps): Promise<Marker> {
  const row = await deps.db.one<{ value: unknown }>('SELECT value FROM app_settings WHERE key = ?', [CAREER_DISCOVERY_MARKER]);
  const value = (typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value) as Partial<Marker> | undefined;
  return { job: Number(value?.job ?? 0) || 0, application: Number(value?.application ?? 0) || 0 };
}

async function saveMarker(t: DbTx, marker: Marker, at: string): Promise<void> {
  await t.run(
    `INSERT INTO app_settings(key, value, updated_at) VALUES (?, CAST(? AS json), CAST(? AS timestamptz))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [CAREER_DISCOVERY_MARKER, JSON.stringify(marker), at],
  );
}

/**
 * The daily step's pass (see the top): the page jobs and tracked applications made since the last pass, their hosts
 * offered. Nothing while the switch is off (and the marker does not move: the rows wait). Answers the candidates
 * offered.
 */
export async function discoverCareerSites(deps: AppDeps): Promise<number> {
  if (!careerPagesOn(deps)) return 0;
  const marker = await markerOf(deps);
  const at = nowIso(deps);
  let offered = 0;
  for (let batch = 0; batch < CAREER_DISCOVERY_BATCHES; batch += 1) {
    // v36 FIX-SRC: a held job offers nothing (see the top); the marker still moves past it.
    const rows = await deps.db.all<{ id: number; apply_url: string | null }>(
      'SELECT id, CASE WHEN held_since IS NULL THEN apply_url END AS apply_url FROM jobs WHERE owner_user_id IS NOT NULL AND id > ? ORDER BY id LIMIT ?',
      [marker.job, CAREER_DISCOVERY_BATCH],
    );
    if (rows.length === 0) break;
    marker.job = Number(rows[rows.length - 1]!.id);
    offered += await deps.db.tx(
      async (t) => {
        const count = await offerCareerSites(deps, t, rows.map((row) => row.apply_url), 'extension', at);
        await saveMarker(t, marker, at);
        return count;
      },
      { label: 'career sites from page jobs' },
    );
  }
  for (let batch = 0; batch < CAREER_DISCOVERY_BATCHES; batch += 1) {
    // v36 FIX-SRC: an entry of a held job offers nothing (see the top); the marker still moves past it.
    const rows = await deps.db.all<{ seq: number; posting_url: string | null }>(
      `SELECT a.seq, CASE WHEN j.held_since IS NULL THEN a.posting_url END AS posting_url
       FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
       WHERE a.seq > ? AND a.posting_url <> '' ORDER BY a.seq LIMIT ?`,
      [marker.application, CAREER_DISCOVERY_BATCH],
    );
    if (rows.length === 0) break;
    marker.application = Number(rows[rows.length - 1]!.seq);
    offered += await deps.db.tx(
      async (t) => {
        const count = await offerCareerSites(deps, t, rows.map((row) => row.posting_url), 'application_link', at);
        await saveMarker(t, marker, at);
        return count;
      },
      { label: 'career sites from applications' },
    );
  }
  return offered;
}

/** The ingest feature's daily step `ingest.career_sites` (registered in features/ingest/index.ts). */
export const careerSitesStep: DailyStep = { name: 'career_sites', run: discoverCareerSites };
