import { JOB_SOURCE_KIND_PLATFORM, type JobSourceKind } from '@tailorit/shared';
import { boardOfAddress, BOARD_DOMAINS, boardUrlOf, personioBoardName, workdaySiteName } from '@tailorit/shared/sourcing'; // v38 FRAME
import { isBoardKindHost, isEmployerPlatformHost, isSharedPlatformHost } from '../career/platforms'; // v30 FIX-A (REQ-5); v38 INT: isBoardKindHost
import { isRefusedPageHost, isSiteHost, normalHost } from '../../job-reviews/hosts';
import { API_BOARDS, apiBoardOf, boardOfInput, boardSourceConfig } from '../boards/index'; // v38 FRAME: the board registry

// v30 S2: the boards discovery knows (docs/design/part2/12-job-sourcing.md §4): for each board kind, how a board's
// name is normalised (today's adapters' normalisers, 12 §4.2), the source config a validated board gets, and whether
// validation may read it yet; and `boardOfUrl`, the board an address names (a posting's or a board's page), which every
// signal reads: applications' and page jobs' links, cross-links, Common Crawl's URLs, an admin's list.
//
// A board's name is what job_source_candidates keeps (UNIQUE (kind, name)) and what a new source is named:
//   greenhouse  the board token, lower case            boards.greenhouse.io/<token>, job-boards.greenhouse.io/<token>
//   lever       the site, lower case                   jobs.lever.co/<site>, jobs.eu.lever.co/<site> (validation finds
//                                                      the region: the global host first, then the EU one)
//   ashby       the job board, as written              jobs.ashbyhq.com/<board>
//   workable    the account, lower case                apply.workable.com/<account>, <account>.workable.com
//   workday     the tenant (Add job's one-posting kind; never validated: it lists nothing)
//   workday_site <host>/<site> or <host>/recruiting/<tenant>/<site>, the host in lower case, the tenant and the site as
//                written (v30 FIX-A: a site path's case is kept; one career site: S3's sitemap kind)
//   personio     the tenant, lower case; a tenant on Personio's .com host keeps it: <tenant>.jobs.personio.com (v30 FIX-A)
//   recruitee, breezy, bamboohr: the tenant, its host's first label, lower case (S3's feed kinds)
//   career_site the host, lower case (only while SITE_READER_CAREER_PAGES is on, for discovery's own signals)
//   icims       v37 BOARDS: the employer's iCIMS host's first label, lower case (careers-acme.icims.com: careers-acme;
//               career/platforms.ts ICIMS_BOARD_HOST), from any page on that host; never a career site any more
//
// `validates`: the four public APIs, and (v30 INT-4, S2's edit A) S3's kinds and S5's career sites, each `configOf` the
// config its adapter reads: a Workday career site `{ host, tenant, careerSite }` (adapters/workdaySite.ts), a feed
// `{ company }` (adapters/personio.ts, recruitee.ts, breezy.ts, bamboohr.ts, their normalisers), a career site
// `{ host }` (career/config.ts careerSiteSourceOf). Validation still reads a kind only when the worker may run it and
// its terms are recorded (validate.ts validatableKinds): Breezy has no recorded terms, so its candidates wait (v37 BOARDS:
// BambooHR's and iCIMS's are recorded, sources.ts KIND_TERMS); career sites wait while SITE_READER_CAREER_PAGES is off
// (scheduler.ts runnableKinds).

/** One kind of board discovery knows. */
export interface BoardKind {
  kind: JobSourceKind;
  /** The source config key that names the board (boardNameOf reads it back). */
  configKey: string;
  /** The board as typed or read from an address, normalised; '' when it names none. */
  normalize: (input: string) => string;
  /** Kept in lower case (an Ashby board keeps its case: its API reads it as written). */
  lower: boolean;
  /** A validated board's source config. */
  configOf: (name: string) => Record<string, unknown>;
  /** Validation reads it now (its adapter reads `configOf`'s config). */
  validates: boolean;
}

// v38 FRAME (SP v38 PLAN A1, A9): the board kinds are the board registry's (ingest/boards, @tailorit/shared/sourcing):
// each descriptor's normaliser (boardOf), config key, case, a validated board's config (configOfBoard) and the board an
// address names (boardOfUrl), moved there unchanged. Validation reads a kind whose sources run (its row's `runs`: every
// board kind but Workday's one-posting kind).

/** v30 FIX-A (INT-4 open item 7): a Workday career site's name (the board registry's, moved there unchanged). */
export { workdaySiteName, personioBoardName };

/** Every board kind discovery knows, by kind (see the top), in the board registry's order. */
export const BOARD_KINDS: Readonly<Partial<Record<JobSourceKind, BoardKind>>> = Object.fromEntries(
  API_BOARDS.map((api): [JobSourceKind, BoardKind] => [
    api.board.kind,
    {
      kind: api.board.kind,
      configKey: api.board.configKey,
      normalize: (input) => boardOfInput(api, input),
      lower: !api.board.keepsCase,
      configOf: (name) => boardSourceConfig(api, name),
      validates: api.board.row.runs,
    },
  ]),
);

/** The board's name as candidates keep it, or null when the kind is no board or the name is none it reads. */
export function candidateName(kind: JobSourceKind, name: string): string | null {
  if (!JOB_SOURCE_KIND_PLATFORM[kind]) return null;
  if (kind === 'career_site') {
    const host = normalHost(name);
    return isSiteHost(host) && !isRefusedPageHost(host) ? host : null;
  }
  const board = BOARD_KINDS[kind];
  if (!board) return null;
  const normalized = board.normalize(name);
  if (!normalized || normalized.length > 300) return null;
  return board.lower ? normalized.toLowerCase() : normalized;
}

/** The board a source's config names (its kind's config key), normalised as candidates keep it; null for none. */
export function boardNameOf(kind: JobSourceKind, config: Record<string, unknown>): string | null {
  // v38 FRAME: its descriptor's boardOfConfig (a Workday career site's host and site, <host>/<site> or
  // <host>/recruiting/<tenant>/<site>; v30 FIX-A: a Personio board on the .com host, <tenant>.jobs.personio.com; else its
  // config key's value).
  const board = apiBoardOf(kind)?.board;
  if (!board) return null;
  const value = board.boardOfConfig!(config);
  return typeof value === 'string' ? candidateName(kind, value) : null;
}

/** A board an address names. */
export interface FoundBoard {
  kind: JobSourceKind;
  /** As candidateName keeps it. */
  name: string;
}

/**
 * The board an address names (a posting's or a board's page on a board kind's host), normalised; null for none. v38
 * FRAME (SP v38 PLAN A9): each board descriptor's boardOfUrl, in the registry's order (@tailorit/shared/sourcing
 * boardOfAddress): a new platform's boards are found as its own kind, never as career sites.
 */
export function boardOfUrl(address: string): FoundBoard | null {
  return boardOfAddress(address);
}

/**
 * Hosts of every ATS platform TailorIT knows (jobs.apply_platform's suffixes): a page there is no career site. v38 FRAME:
 * v3.7's list, then every board descriptor's domains (BOARD_DOMAINS).
 */
const V37_PLATFORM_SUFFIXES = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'workable.com', 'icims.com',
  'taleo.net', 'successfactors.com', 'successfactors.eu', 'oraclecloud.com', 'oraclegovcloud.com', 'jobvite.com',
  'applytojob.com', 'bamboohr.com', 'rippling.com', 'breezy.hr', 'careerplug.com', 'pinpointhq.com',
  'recruitingbypaycor.com', 'hibob.com', 'ultipro.com', 'dayforcehcm.com', 'paylocity.com', 'dice.com',
  'clearcompany.com', 'adp.com', 'smartrecruiters.com', 'personio.de', 'personio.com', 'recruitee.com', 'teamtailor.com',
];
const PLATFORM_SUFFIXES = [...V37_PLATFORM_SUFFIXES, ...BOARD_DOMAINS.filter((domain) => !V37_PLATFORM_SUFFIXES.includes(domain))];

/**
 * The career site an address is on (its host, as candidateName keeps a career_site), or null: no https page, an ATS
 * platform's host, LinkedIn or a refused job board. Discovery offers it only while SITE_READER_CAREER_PAGES is on.
 * v30 FIX-A (REV-REQ REQ-5): one employer's own host on an ATS platform with no public API (career/platforms.ts) is a
 * career site.
 */
export function careerSiteOfUrl(address: string): FoundBoard | null {
  const url = boardUrlOf(address);
  if (!url || url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (isSharedPlatformHost(host)) return null;
  // v38 FRAME (SP v38 PLAN A9): a host a board kind claims is that kind's, never a career site (v38 INT: the one rule).
  if (isBoardKindHost(host)) return null;
  if (!isEmployerPlatformHost(host) && PLATFORM_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  const name = candidateName('career_site', host);
  return name ? { kind: 'career_site', name } : null;
}
