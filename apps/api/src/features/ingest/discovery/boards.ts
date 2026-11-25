import { JOB_SOURCE_KIND_PLATFORM, type JobSourceKind } from '@tailorit/shared';
import { ICIMS_SERVICE_HOST, icimsBoardOf, isEmployerPlatformHost, isIcimsBoardHost, isSharedPlatformHost } from '../career/platforms'; // v30 FIX-A (REQ-5); v37 BOARDS: iCIMS; v37 FIX-37A
import { isRefusedPageHost, isSiteHost, normalHost } from '../../job-reviews/hosts';
import { ashbyBoard } from '../adapters/ashby';
import { bamboohrCompany } from '../adapters/bamboohr'; // v30 INT-4 (S2 edit A)
import { breezyCompany } from '../adapters/breezy'; // v30 INT-4 (S2 edit A)
import { greenhouseToken } from '../adapters/greenhouse';
import { leverSite } from '../adapters/lever';
import { personioCompany } from '../adapters/personio'; // v30 INT-4 (S2 edit A)
import { recruiteeCompany } from '../adapters/recruitee'; // v30 INT-4 (S2 edit A)
import { workableAccount } from '../adapters/workable';
import { workdayTenant } from '../adapters/workday';
import { careerSiteSourceOf } from '../career/config'; // v30 INT-4 (S2 edit A)

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

/**
 * A Workday career site's name: <host>/<site> or <host>/recruiting/<tenant>/<site>; '' when none. v30 FIX-A (INT-4 open
 * item 7): the host in lower case, the tenant and the site as written: a site's path is read as it is named
 * ("External", "Careers_US"), so a lower-cased one may name no site. Lookups of a board compare names in any case.
 */
export function workdaySiteName(input: string): string {
  const text = input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const own = /^([a-z0-9-]+\.(?:wd\d{1,3}\.)?myworkdayjobs\.com)\/([a-z0-9_-]{1,100})$/i.exec(text);
  if (own && !/^(?:www|wd\d{1,3})\./i.test(own[1]!)) return `${own[1]!.toLowerCase()}/${own[2]}`;
  const shared = /^(wd\d{1,3}\.myworkdaysite\.com)\/recruiting\/([a-z0-9_-]{1,100})\/([a-z0-9_-]{1,100})$/i.exec(text);
  return shared ? `${shared[1]!.toLowerCase()}/recruiting/${shared[2]}/${shared[3]}` : '';
}

/** v30 FIX-A (INT-4 open item 7): a Personio board's name: its tenant, or <tenant>.jobs.personio.com on the .com host. */
export function personioBoardName(input: string): string {
  const tenant = personioCompany(input);
  if (!tenant) return '';
  return /(?:^|[./])jobs\.personio\.com(?:[/:?#]|$)/i.test(input.trim()) ? `${tenant}${PERSONIO_COM}` : tenant;
}

/** The suffix of a Personio board on the .com host. */
const PERSONIO_COM = '.jobs.personio.com';

/** A Personio board's source config: `{ company }`, and `domain: 'com'` for the .com host (adapters/personio.ts). */
function personioConfig(name: string): Record<string, unknown> {
  return name.endsWith(PERSONIO_COM) ? { company: name.slice(0, -PERSONIO_COM.length), domain: 'com' } : { company: name };
}

/**
 * A Workday career site's source config from its name: its host, tenant and site, as adapters/workdaySite.ts reads them
 * (`careerSite` as written; the tenant is the host's first label on a tenant host, in lower case as the adapter checks
 * it against the host).
 */
function workdaySiteConfig(name: string): Record<string, unknown> {
  const [host, ...path] = name.split('/');
  const careerSite = path[path.length - 1]!;
  const tenant = path[0] === 'recruiting' ? path[1]! : host!.split('.')[0]!.toLowerCase();
  return { host, tenant, careerSite };
}

const boardKind = (kind: JobSourceKind, configKey: string, normalize: (input: string) => string, extra: Partial<BoardKind> = {}): BoardKind => ({
  kind,
  configKey,
  normalize,
  lower: true,
  configOf: (name) => ({ [configKey]: name }),
  validates: false,
  ...extra,
});

/** Every board kind discovery knows, by kind (see the top). */
export const BOARD_KINDS: Readonly<Partial<Record<JobSourceKind, BoardKind>>> = {
  greenhouse: boardKind('greenhouse', 'token', greenhouseToken, { validates: true }),
  lever: boardKind('lever', 'site', leverSite, { validates: true }),
  ashby: boardKind('ashby', 'board', ashbyBoard, { lower: false, validates: true }),
  workable: boardKind('workable', 'account', workableAccount, { validates: true }),
  workday: boardKind('workday', 'tenant', workdayTenant),
  // v30 INT-4 (S2 edit A): S3's kinds and S5's career sites (see the top).
  workday_site: boardKind('workday_site', 'careerSite', workdaySiteName, { lower: false, configOf: workdaySiteConfig, validates: true }),
  personio: boardKind('personio', 'company', personioBoardName, { configOf: personioConfig, validates: true }),
  recruitee: boardKind('recruitee', 'company', recruiteeCompany, { validates: true }),
  breezy: boardKind('breezy', 'company', breezyCompany, { validates: true }),
  bamboohr: boardKind('bamboohr', 'company', bamboohrCompany, { validates: true }),
  career_site: boardKind('career_site', 'host', (input) => careerSiteSourceOf(input)?.name ?? '', {
    configOf: (name) => careerSiteSourceOf(name)?.config ?? { host: name },
    validates: true,
  }),
  // v37 BOARDS (SP v37 PLAN I1, I5): an employer's iCIMS site, config `{ board }` (adapters/icims.ts).
  icims: boardKind('icims', 'board', icimsBoardOf, { validates: true }),
};

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
  const board = BOARD_KINDS[kind];
  if (!board) return null;
  if (kind === 'workday_site') {
    const { host, careerSite: site, tenant } = config;
    if (typeof host !== 'string' || typeof site !== 'string') return null;
    const shared = /\.myworkdaysite\.com$/i.test(host) && typeof tenant === 'string';
    return candidateName(kind, shared ? `${host}/recruiting/${tenant}/${site}` : `${host}/${site}`);
  }
  const value = config[board.configKey];
  // v30 FIX-A: a Personio source on the .com host names its board <tenant>.jobs.personio.com.
  if (kind === 'personio' && typeof value === 'string' && config.domain === 'com') return candidateName(kind, `${value}${PERSONIO_COM}`);
  return typeof value === 'string' ? candidateName(kind, value) : null;
}

/** A board an address names. */
export interface FoundBoard {
  kind: JobSourceKind;
  /** As candidateName keeps it. */
  name: string;
}

/** Greenhouse's board hosts (the EU twins too: validation tells whether the global API reads the board). */
const GREENHOUSE_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'job-boards.eu.greenhouse.io']);
const LEVER_HOSTS = new Set(['jobs.lever.co', 'jobs.eu.lever.co']);
/** First path segments of Greenhouse's and Lever's hosts that are no board. */
const NOT_A_BOARD = new Set(['embed', 'v1', 'static', 'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'api', 'j', 'jobs', 'login', 'search']);
/** A tenant host's first labels that are the platform's own (www, its app, its API...), never a customer's. */
const SERVICE_LABELS = new Set(['www', 'app', 'api', 'apply', 'help', 'support', 'docs', 'blog', 'status', 'login', 'jobs', 'careers', 'marketplace', 'partners', 'developers', 'static', 'cdn', 'mail', 'go', 'info']);
/** Workday's own words where a site would stand. */
const WORKDAY_NOT_A_SITE = new Set(['job', 'jobs', 'login', 'userhome', 'wday', 'details', 'apply', 'recruiting', 'search', 'jobalerts', 'robots.txt', 'sitemap.xml']);
/** A locale segment before a Workday site (en-US, fr-FR, de). */
const WORKDAY_LOCALE = /^[a-z]{2}(?:-[a-z0-9]{2,4})?$/i;

function urlOf(address: string): URL | null {
  const text = address.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const segmentsOf = (url: URL) =>
  url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

/** The tenant label of `host` under `suffix` (acme.recruitee.com: acme), unless it is the platform's own. */
function tenantOf(host: string, suffix: string): string | null {
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return label && !label.includes('.') && !SERVICE_LABELS.has(label) ? label : null;
}

/** The Workday career site an address names: <host>/<site> or <host>/recruiting/<tenant>/<site>. */
function workdaySiteOf(host: string, parts: string[]): string | null {
  const own = /^([a-z0-9-]+)\.(?:wd\d{1,3}\.)?myworkdayjobs\.com$/.exec(host);
  const shared = /^wd\d{1,3}\.myworkdaysite\.com$/.test(host);
  if ((!own || /^(?:www|wd\d{1,3})$/.test(own[1]!)) && !shared) return null;
  let rest = parts;
  if (shared) {
    // /[<locale>/]recruiting/<tenant>/<site>/...
    if (rest.length >= 2 && WORKDAY_LOCALE.test(rest[0]!) && rest[1]!.toLowerCase() === 'recruiting') rest = rest.slice(1);
    if (rest[0]?.toLowerCase() !== 'recruiting' || !rest[1] || !rest[2] || WORKDAY_NOT_A_SITE.has(rest[2].toLowerCase())) return null;
    return `${host}/recruiting/${rest[1]}/${rest[2]}`;
  }
  // /[<locale>/]<site>/...: a locale goes first only where a site follows it (a site named "de" before /job is none).
  if (rest.length >= 2 && WORKDAY_LOCALE.test(rest[0]!) && !WORKDAY_NOT_A_SITE.has(rest[1]!.toLowerCase())) rest = rest.slice(1);
  const site = rest[0];
  if (!site || WORKDAY_NOT_A_SITE.has(site.toLowerCase())) return null;
  return `${host}/${site}`;
}

/** The kind and raw board an address names, before candidateName (null for none). */
function rawBoardOf(url: URL): { kind: JobSourceKind; raw: string } | null {
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  const parts = segmentsOf(url);
  if (GREENHOUSE_HOSTS.has(host)) {
    if (parts[0] === 'embed') {
      const named = url.searchParams.get('for');
      return named ? { kind: 'greenhouse', raw: named } : null;
    }
    return parts[0] && !NOT_A_BOARD.has(parts[0].toLowerCase()) ? { kind: 'greenhouse', raw: parts[0] } : null;
  }
  if (LEVER_HOSTS.has(host)) return parts[0] && !NOT_A_BOARD.has(parts[0].toLowerCase()) ? { kind: 'lever', raw: parts[0] } : null;
  if (host === 'jobs.ashbyhq.com') return parts[0] && !NOT_A_BOARD.has(parts[0].toLowerCase()) ? { kind: 'ashby', raw: parts[0] } : null;
  if (host === 'apply.workable.com') return parts[0] && !NOT_A_BOARD.has(parts[0].toLowerCase()) ? { kind: 'workable', raw: parts[0] } : null;
  const workable = tenantOf(host, '.workable.com');
  if (workable) return { kind: 'workable', raw: workable };
  const workday = workdaySiteOf(host, parts);
  if (workday) return { kind: 'workday_site', raw: workday };
  const personio = tenantOf(host, '.jobs.personio.de');
  if (personio) return { kind: 'personio', raw: personio };
  // v30 FIX-A: the .com host is kept (its feed is there, not on .de).
  if (tenantOf(host, '.jobs.personio.com')) return { kind: 'personio', raw: host };
  const recruitee = tenantOf(host, '.recruitee.com');
  if (recruitee) return { kind: 'recruitee', raw: recruitee };
  const breezy = tenantOf(host, '.breezy.hr');
  if (breezy) return { kind: 'breezy', raw: breezy };
  const bamboo = tenantOf(host, '.bamboohr.com');
  // A BambooHR tenant's own host serves its staff too: only its careers pages name a board.
  if (bamboo && ['careers', 'jobs'].includes(parts[0]?.toLowerCase() ?? '')) return { kind: 'bamboohr', raw: bamboo };
  // v37 BOARDS (SP v37 PLAN I5): any page on one employer's iCIMS host names its site (never iCIMS's own hosts).
  // v37 FIX-37A (F11): a host iCIMS runs for itself (its developers', community, status pages) only by a posting's page.
  if (isIcimsBoardHost(host) && (!ICIMS_SERVICE_HOST.test(host) || (parts[0] === 'jobs' && /^\d{1,12}$/.test(parts[1] ?? '')))) {
    return { kind: 'icims', raw: host };
  }
  return null;
}

/** The board an address names (a posting's or a board's page on a board kind's host), normalised; null for none. */
export function boardOfUrl(address: string): FoundBoard | null {
  const url = urlOf(address);
  if (!url) return null;
  const found = rawBoardOf(url);
  if (!found) return null;
  const name = candidateName(found.kind, found.raw);
  return name ? { kind: found.kind, name } : null;
}

/** Hosts of every ATS platform TailorIT knows (jobs.apply_platform's suffixes): a page there is no career site. */
const PLATFORM_SUFFIXES = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com', 'workable.com', 'icims.com',
  'taleo.net', 'successfactors.com', 'successfactors.eu', 'oraclecloud.com', 'oraclegovcloud.com', 'jobvite.com',
  'applytojob.com', 'bamboohr.com', 'rippling.com', 'breezy.hr', 'careerplug.com', 'pinpointhq.com',
  'recruitingbypaycor.com', 'hibob.com', 'ultipro.com', 'dayforcehcm.com', 'paylocity.com', 'dice.com',
  'clearcompany.com', 'adp.com', 'smartrecruiters.com', 'personio.de', 'personio.com', 'recruitee.com', 'teamtailor.com',
];

/**
 * The career site an address is on (its host, as candidateName keeps a career_site), or null: no https page, an ATS
 * platform's host, LinkedIn or a refused job board. Discovery offers it only while SITE_READER_CAREER_PAGES is on.
 * v30 FIX-A (REV-REQ REQ-5): one employer's own host on an ATS platform with no public API (career/platforms.ts) is a
 * career site.
 */
export function careerSiteOfUrl(address: string): FoundBoard | null {
  const url = urlOf(address);
  if (!url || url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (isSharedPlatformHost(host)) return null;
  if (!isEmployerPlatformHost(host) && PLATFORM_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  const name = candidateName('career_site', host);
  return name ? { kind: 'career_site', name } : null;
}
