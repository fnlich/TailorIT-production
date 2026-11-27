import type { JobSourceDiscoveredVia } from '@tailorit/shared';
import { addablePosting } from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../../core/context';
import { offerToDiscovery } from '../../../core/seams';
import { workdayLinkPosting } from '../../ingest/adapters/workday';
import { boardOfUrl } from '../../ingest/discovery/boards';
import { IMPORT_BOARD_KINDS, importBoardOfPosting, importBoardOfUrl, type ImportBoardInput } from '../../ingest/import-sources'; // v37 INT-B importBoardOfUrl
import { readPage, type PageReading } from '../../autofill/lookup';

// v37 CLOSED (SP v37 PLAN.md C7, the owner's "even if the job is closed, the source should be extracted and added"):
//   - importBoardOfLink: the board an admin import's link names (a Greenhouse, Lever, Ashby or Workable board, or a
//     Workday career site; v37 INT-B: a BambooHR company or an iCIMS site too, by BOARDS' importBoardOfUrl), from the
//     posting the link names (importBoardOfPosting: the shared lookup's addablePosting, else a Workday link without a
//     location) or, failing that, from the address alone (discovery's boardOfUrl, the import's board kinds only). import-pipeline.ts remembers it as a source (off, Found by import, in Runs' Sources
//     found) whatever TailorIT's read gave: open, closed, try later, to review, can't read.
//   - offerBoardOfClosedLink: a person's, the extension's or the MCP tool's add of a link whose posting has closed offers
//     its board to discovery (offerToDiscovery: a candidate waiting for an admin; never a person's id, the job or the
//     page), in its own transaction; a failure is logged, never the add's.
// Neither turns anything on (v3.6's fence: only enableSources does).

/** The posting a link names: the shared lookup's (a located posting), else a Workday link without a location (C4). */
export function postingOfLink(page: PageReading, url: string) {
  return addablePosting(page.ats) ?? workdayLinkPosting(url);
}

/** A Workday career site as discovery names it (`<host>/<site>`, `<host>/recruiting/<tenant>/<site>`), as a source's config. */
function workdaySiteConfig(name: string): Record<string, unknown> | null {
  const [host, ...rest] = name.split('/');
  if (!host) return null;
  if (rest[0] === 'recruiting' && rest[1] && rest[2]) return { host, tenant: rest[1], careerSite: rest[2] };
  const own = /^([a-z0-9-]+)\.(?:wd\d{1,3}\.)?myworkdayjobs\.com$/.exec(host);
  return own && rest[0] ? { host, tenant: own[1], careerSite: rest[0] } : null;
}

/** The board an admin import's link names (see the top), as rememberImportBoard takes it; null for none. */
export function importBoardOfLink(page: PageReading, url: string): Omit<ImportBoardInput, 'runId' | 'companyName'> | null {
  const posted = importBoardOfPosting(postingOfLink(page, url));
  if (posted) return posted;
  const found = boardOfUrl(url);
  if (!found || !(IMPORT_BOARD_KINDS as readonly string[]).includes(found.kind)) return null;
  switch (found.kind) {
    case 'greenhouse':
      return { kind: 'greenhouse', name: found.name, config: { token: found.name } };
    case 'lever':
      return { kind: 'lever', name: found.name, config: { site: found.name, region: /(^|\.)eu\.lever\.co$/.test(new URL(url).hostname) ? 'eu' : 'global' } };
    case 'ashby':
      return { kind: 'ashby', name: found.name, config: { board: found.name } };
    case 'workable':
      return { kind: 'workable', name: found.name, config: { account: found.name } };
    case 'workday_site': {
      const config = workdaySiteConfig(found.name);
      return config ? { kind: 'workday_site', name: found.name, config } : null;
    }
    // v37 INT-B (BOARDS B4, I4; CLOSED C7): a BambooHR opening's or an iCIMS posting's link names its company or site,
    // closed or not (their config as BOARDS' Add source writes it: {company} / {board}). v38 FRAME (SP v38 PLAN A9): so
    // does every other importable board kind's (its descriptor's config).
    default:
      return importBoardOfUrl(url);
  }
}

/** A board of a closed link offered to discovery (see the top): `via` the extension's, or a link in an application. */
export async function offerBoardOfClosedLink(deps: AppDeps, url: string, via: Extract<JobSourceDiscoveredVia, 'extension' | 'application_link'>): Promise<void> {
  const posted = importBoardOfPosting(postingOfLink(readPage(url), url));
  const board = posted ? { kind: posted.kind, name: posted.name } : boardOfUrl(url);
  if (!board) return;
  try {
    await deps.db.tx((t) => offerToDiscovery(deps, t, { kind: board.kind, name: board.name, via, at: nowIso(deps) }), {
      label: 'add job: a closed link offers its board',
    });
  } catch (error) {
    // Never the error's own text (it can hold the link).
    deps.log.warn('[job-links] the board of a closed link could not be offered to discovery', error instanceof Error ? error.name : 'unknown');
  }
}
