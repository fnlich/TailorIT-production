import {
  formatSalaryRange,
  industryLabel,
  linkKey,
  linkParameterKept,
  NOT_SPECIFIED_INDUSTRY,
  secretOrAmbiguousName,
  withoutLinkNoise,
  type LinkParameterKept,
} from '@tailorit/shared';
import {
  addablePosting,
  AUTOFILL_ADDABLE_ATS,
  AUTOFILL_POSTING_TEXT_MAX,
  AutofillLookupMatchSchema,
  isLinkedInHost,
  parseAtsUrl,
  parseLinkedInJobUrl,
  WORK_ARRANGEMENTS,
  type AtsKind,
  type AutofillLookupMatch,
  type AutofillLookupPage,
  type AutofillLookupRequest,
  type AutofillLookupResponse,
  type AutofillResumeChoice,
  type AutofillResumeItem,
  type ParsedAtsUrl,
  type ParsedLinkedInJob,
  type ResumeChoiceReason,
  type WorkArrangement,
} from '@tailorit/shared/autofill';
import { BOARD_DESCRIPTORS } from '@tailorit/shared/sourcing'; // v38 FRAME
import type { AppDeps } from '../../core/context';
import type { Dialect } from '../../core/db/dialect';
import { capUtf16 } from '../../core/files/index';
import { notFound } from '../../core/http/errors';
import { bestResumes } from '../applications/resume-choice';
import { creditFieldOf, jobCreditSql } from '../jobs/credit'; // v30 FIX-B
import { matchResumeForJob } from '../jobs/match';
import { currentJobId } from '../jobs/store';
import { isoTimestamp, salaryOf } from '../jobs/rows';
import { readJobText } from '../jobs/text';
import { jobVisibleTo } from '../jobs/visibility';
import { defaultResumeId } from '../resumes/repository';
import { aliasValueHash } from './alias-key';
import { listedParameters, POSTING_PARAMETERS, postingParameters } from './posting-parameters'; // v31 FIX-LINK
import { readAutofillProfile } from './profile/repository';
import { findAttachableResume, latestAttachableResume } from './resumes';

// The job behind an application page (POST /api/autofill/lookup): the TailorIT job it is, the person's own tracker
// entry for it, the resume to attach and its keyword match to the job. The page's address arrives in the body and is
// used here only: it is never stored, logged or answered back. Read-only throughout: no view is recorded
// (markViewed), no AI work is queued and nothing is written; the best resume is asked read-only (bestResumes, never
// AI) and the suggested resume's keyword match is computed read-only (matchResumeForJob, through the analysis peek).
//
// The job is found by the ATS's own posting id among the ingested sources (job_source_links), else by the posting's
// link (its `link` keys in job_keys: v3.0 DB-INGEST); the application by that job, else by the posting link saved on it. A request that names a
// job (`jobId`, version 3: the side panel's "Autofill for another job") is answered for that job whatever the address
// says, its application found by the job alone. Adding a job (jobs-router.ts) finds an existing one the same way, and
// answers this lookup once it is added.
//
// Version 5: a page that is not the posting's own (a LinkedIn job, a company's careers page) may name the employer's
// link (`employerUrl`). The order is then: the job chosen; the employer's link read by parseAtsUrl (its posting id
// among the sources, then a stored link naming the same posting); the employer's link itself (the jobs' link keys, then
// job_link_aliases); the page's own address through job_link_aliases (a LinkedIn job's canonical address, the page a
// job was added from); the page as before; and, for the application, the posting links saved on the person's entries.
// A LinkedIn job's alias comes first of all, before any employer link the page shows. Aliases are the account's own,
// and a job made from a page answers its own account alone (jobs.owner_user_id: jobs/visibility.ts's jobVisibleTo,
// the viewer's id bound once per use).
// Postings on Workday, iCIMS, Taleo, SuccessFactors and Oracle (and LinkedIn's jobs), and (version 6) on the new ATSs,
// Jobvite to SmartRecruiters, are spelt many ways (a locale, a free location or slug, a step, a query of layout
// parameters): their stored links are compared by what parseAtsUrl (or parseLinkedInJobUrl) reads from them, among the
// links on the same host that hold the posting's id. No address is ever fetched here: a LinkedIn address in particular
// is only ever compared.
//
// v3.0 D2: on the async client. v3.0 PG-A: a substring test is `dialect.contains` (SQLite's instr, PostgreSQL's
// strpos); the link-key and alias ranges (`key >= ? AND key < ?`, '?' sorting just below '@', '/' just below
// '0') compare in byte order, `dialect.collateC` (SQLite's default; PostgreSQL's COLLATE "C", the collation of
// job_keys.key and job_link_aliases.alias, so job_keys' primary key and idx_job_link_aliases_alias serve them).
// v3.0 DB-INGEST: a job's stored links are its `link` keys (job_keys, written by ingest with the job: one per address a
// source wrote it with) where v2.0 read the one jobs.link_key (dropped by migrations-pg/0012). A row read here names
// one of the job's keys as `link_key`; a job with several may come back once per key.

/** How long the lookup waits for TailorIT's best match before it suggests the default resume instead. */
const BEST_MATCH_BUDGET_MS = 300;
/** Applications whose posting links are compared, most recently updated first. */
const POSTING_URL_SCAN = 2000;

/**
 * The board a source's config names, read by its adapter's own rule (a token, site, board or account name, or its
 * URL).
 */
export const SOURCE_BOARD: Partial<Record<AtsKind, (config: Record<string, unknown>) => string>> = Object.fromEntries(
  // v38 FRAME: each board kind's descriptor's (its config key read by its normaliser), for the ATSs the extension's
  // contract adds (AUTOFILL_ADDABLE_ATS, pinned: Greenhouse's token, Lever's site, Ashby's board, Workable's account,
  // Workday's tenant).
  AUTOFILL_ADDABLE_ATS.map((kind) => {
    const board = BOARD_DESCRIPTORS.find((descriptor) => descriptor.atsKind === kind)!;
    return [kind, (config: Record<string, unknown>) => board.boardOf(board.boardOfConfig!(config) ?? '')];
  }),
);

function configOf(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * How a job was found. `posting`: through an ATS posting's identity (its source link, the posting's own addresses,
 * a stored link naming the same posting), not merely a page's link or an alias: an add from the page trusts the
 * others only when the job's title and company agree.
 */
export type JobMatch = { id: number; matchedBy: 'source_link' | 'link_key' | 'chosen' | 'alias'; posting?: boolean };

/** jobVisible's statement: the job's id, the viewer. */
export const JOB_VISIBLE_SQL = `SELECT 1 FROM jobs j WHERE j.id = ? AND ${jobVisibleTo('j')}`;

/** Whether `viewer` may see job `jobId` (it exists, and is shared or theirs). */
export async function jobVisible(deps: Pick<AppDeps, 'db'>, viewer: string, jobId: number): Promise<boolean> {
  return (await deps.db.one(JOB_VISIBLE_SQL, [jobId, viewer])) !== undefined;
}

/**
 * The ATSs whose posting ids are global (Greenhouse's numbers, Lever's and Ashby's UUIDs, Workable's shortcodes): a
 * row of another board is still the posting when it is the only one. Workday's requisition ids are a tenant's own
 * (two tenants may both have R12345), as iCIMS', Taleo's and Oracle's ids are a portal's and SuccessFactors' a
 * company's: their board must match.
 */
const GLOBAL_ID_KINDS: ReadonlySet<AtsKind> = new Set<AtsKind>(['greenhouse', 'lever', 'ashby', 'workable']);

/**
 * The job ingested from this ATS posting: live links first, then live jobs, then the most recently seen. Rows from
 * the board the address names come first; for an ATS whose ids are global, another board's row is still the posting
 * when it is the only one (or when the address names no board); for any other, only the board's own row is.
 */
async function jobBySourceLink(deps: Pick<AppDeps, 'db'>, viewer: string, ats: ParsedAtsUrl): Promise<JobMatch | null> {
  if (!SOURCE_BOARD[ats.kind]) return null;
  return sourceLinkMatch(ats, await deps.db.all<SourceLinkRow>(SOURCE_LINK_SQL, [ats.kind, ats.externalId, viewer]));
}

/** jobBySourceLink's statement: the ATS kind, the posting id, the viewer. */
export const SOURCE_LINK_SQL = `SELECT l.job_id, s.config
       FROM job_source_links l JOIN job_sources s ON s.id = l.source_id JOIN jobs j ON j.id = l.job_id
       WHERE s.kind = ? AND l.source_job_id = ? AND ${jobVisibleTo('j')}
       ORDER BY (l.missing_since IS NULL) DESC, j.active DESC, l.last_seen_at DESC LIMIT 20`;

export type SourceLinkRow = { job_id: number; config: string };

/** The posting's job among its source links' rows (see jobBySourceLink). */
export function sourceLinkMatch(ats: ParsedAtsUrl, rows: readonly SourceLinkRow[]): JobMatch | null {
  const boardOf = SOURCE_BOARD[ats.kind];
  if (!boardOf) return null;
  const global = GLOBAL_ID_KINDS.has(ats.kind);
  const board = ats.board?.toLowerCase() ?? null;
  const row =
    board === null
      ? global
        ? rows[0]
        : undefined
      : (rows.find((candidate) => boardOf(configOf(candidate.config)).toLowerCase() === board) ??
        (global && rows.length === 1 ? rows[0] : undefined));
  return row ? { id: row.job_id, matchedBy: 'source_link', posting: true } : null;
}

// v31 LINK: the query parameters that never name another posting (v3.0's LINK_NOISE and LINK_KEEP_ONLY: Jobright's
// jr_id, Ashby's embed, `source` and `src`, iCIMS's iis and iisn, the mail and ad tools' click ids, Indeed's and
// Glassdoor's visit parameters, ...) are the one shared list (packages/shared/src/jobs/canonical.ts isLinkNoise), which
// linkKey itself drops since v3.1: withoutLinkNoise still drops them from a link or an alias stored before.
export { withoutLinkNoise } from '@tailorit/shared';

// v31 FIX-LINK (SEC-2): the parameters a stored page address never keeps as written (a person's secrets, the ambiguous
// ones, the over-long ones) are the one list in packages/shared/src/jobs/canonical.ts (linkParameterKept), which the
// add pipeline's shared links read too (shareableJobUrl).
type Kept = LinkParameterKept;

function keptOnPage(name: string, value: string): Kept {
  return linkParameterKept(name, value);
}

/**
 * The keyed hash an alias keeps an ambiguous or long parameter's value as (AMBIGUOUS_LINK_PARAMETERS): HMAC-SHA256 of
 * "<name>=<value>" under this TailorIT's own alias key (aliasKey.ts: a file in its data folder, never in the database),
 * its first 12 hex digits after "h:". Null: no key in this process, and the parameter is dropped as an Apply link drops it.
 */
export type AliasValueHash = ((name: string, value: string) => string) | null;

/**
 * A linkKey with each query parameter `decide` answers for: kept as written (undefined), dropped (null) or written with
 * another value (a string); the rest kept in their order, or the key as it is.
 */
function rewriteParameters(key: string, decide: (name: string, value: string, host: string) => string | null | undefined): string {
  const at = key.indexOf('?');
  if (at < 0) return key;
  const host = /^https:\/\/([^/:?#]+)/.exec(key)?.[1] ?? '';
  const kept: string[] = [];
  for (const pair of key.slice(at + 1).split('&')) {
    const equals = pair.indexOf('=');
    const written = equals < 0 ? pair : pair.slice(0, equals);
    const name = decodeURIComponentSafe(written).toLowerCase();
    const value = equals < 0 ? '' : decodeURIComponentSafe(pair.slice(equals + 1).replace(/\+/g, ' '));
    const decided = decide(name, value, host);
    if (decided === undefined) kept.push(pair);
    else if (decided !== null) kept.push(`${written}=${encodeURIComponent(decided)}`);
  }
  return kept.length > 0 ? `${key.slice(0, at)}?${kept.join('&')}` : key.slice(0, at);
}

/**
 * The fragment of an address that names what the page shows, so it is kept: a single-page site's route (#/jobs/101,
 * #!/jobs/101, with a query or not) or parameters (BrassRing's #jobDetails=111_5); '' for any other fragment (#top).
 */
function postingFragment(address: string): string {
  const hash = address.indexOf('#');
  const fragment = hash < 0 ? '' : address.slice(hash);
  return /^#!?\//.test(fragment) || /^#[A-Za-z_][\w.-]*=/.test(fragment) ? fragment : '';
}

/** A path without its segments' matrix parameters (Taleo's ;jsessionid=…), and without a trailing '/'. */
function withoutMatrixParameters(path: string): string {
  const bare = path.replace(/;[^/]*/g, '');
  return bare.length > 1 && bare.endsWith('/') ? bare.slice(0, -1) : bare;
}

// v31 FIX-LINK: POSTING_PARAMETERS, postingParameters and listedParameters live in a leaf module (posting-parameters.ts)
// the add pipeline's address helper reads without this lookup; the one list's test of a name is packages/shared's.
export { listedParameters, POSTING_PARAMETERS, postingParameters };
export { secretOrAmbiguousName };

/**
 * A key's (or a fragment query's, after "x?") parameters as a stored page address keeps them (keptOnPage): a secret's
 * dropped, an ambiguous or long one hashed in an alias (`hash`) or dropped in an Apply link (no `hash`); one in `named`
 * (postingParameters) kept as written.
 */
function keptParameters(key: string, hash: AliasValueHash, named: ReadonlySet<string> = new Set()): string {
  return rewriteParameters(key, (name, written) => {
    // A value holding ';' ends there: a server may read what follows as parameters of their own (?id=1;token=…).
    const cut = written.includes(';') ? written.slice(0, written.indexOf(';')) : written;
    // Autofill API 7: a parameter the posting's own canonical address names is the posting's, never a secret.
    if (named.has(`${name}=${cut}`)) return cut === written ? undefined : cut;
    const kept = keptOnPage(name, cut);
    if (kept === 'keep') return cut === written ? undefined : cut;
    return kept === 'hash' && hash ? hash(name, cut) : null;
  });
}

/**
 * An address as TailorIT stores it from a page (version 5): linkKey's form (https, no tracking, no trailing slash),
 * without LINK_NOISE, a secret's parameter (keptOnPage) or a matrix parameter, and a fragment that names what the page
 * shows (postingFragment) kept under the same rules (a route's own query, a fragment's parameters; none holding a
 * quote, a space or a line break); serialised as WHATWG URL writes it. An ambiguous or long parameter's value is kept
 * only as its keyed hash with `hash` (an alias: the lookup's identity of the page), and not at all without it (a job's
 * Apply link, which never carries such a value). Autofill API 7: a parameter the posting's own first canonical address
 * names (postingParameters) is kept as written whatever it looks like, as JobDiva's agency key `a`, a long one-letter
 * value, must be. Null for an address that is not one.
 */
export function storedPageAddress(address: string, hash: AliasValueHash = null): string | null {
  const key = linkKey(address);
  if (!key) return null;
  const kept = keptParameters(withoutLinkNoise(key), hash, postingParameters(address));
  const at = kept.indexOf('?');
  const origin = /^https:\/\/[^/?]+/.exec(kept)?.[0] ?? '';
  const path = withoutMatrixParameters(kept.slice(origin.length, at < 0 ? undefined : at)) || '/';
  const search = at < 0 ? '' : kept.slice(at);
  let fragment = '';
  const named = postingFragment(address.trim());
  // A fragment holding a quote, an angle bracket, a backslash, a space or a control character is none kept.
  if (named && !/["'<>`\\\s\p{Cc}]/u.test(named)) {
    if (/^#!?\//.test(named)) {
      // The route's own query loses its secrets as the address's does (#/jobs/101?token=… keeps no token).
      const query = named.indexOf('?');
      const routePath = withoutMatrixParameters(query < 0 ? named : named.slice(0, query));
      const routeQuery = query < 0 ? '' : keptParameters(`x?${named.slice(query + 1)}`, hash).slice(2);
      fragment = routeQuery ? `${routePath}?${routeQuery}` : routePath;
    } else {
      const parameters = keptParameters(`x?${named.slice(1)}`, hash).slice(2);
      fragment = parameters ? `#${parameters}` : '';
    }
  }
  try {
    const url = new URL(`${origin}${path}${search}`);
    url.hash = fragment;
    return url.href;
  } catch {
    return null;
  }
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The job whose link is one of `keys` (linkKey forms, noise dropped), the first key that has one winning: a link stored
 * exactly so, else one that differs from it by LINK_NOISE alone (found among the links of the same address). Only a
 * job `viewer` may see.
 */
async function jobByLinkKey(
  deps: Pick<AppDeps, 'db'>,
  viewer: string,
  keys: readonly string[],
  posting: boolean,
): Promise<JobMatch | null> {
  if (keys.length === 0) return null;
  const rows = await deps.db.all<LinkKeyRow>(linkKeySql(deps.db.dialect, keys.length), [...keys, viewer]);
  const exact = exactLinkKeyMatch(keys, rows, posting);
  if (exact) return exact;
  for (const key of keys) {
    const candidates = await deps.db.all<LinkKeyRow>(sameAddressSql(deps.db.dialect), [...addressRange(key), viewer]);
    const row = candidates.find((candidate) => withoutLinkNoise(candidate.link_key) === key);
    if (row) return { id: row.id, matchedBy: 'link_key', posting };
  }
  return null;
}

export type LinkKeyRow = { id: number; link_key: string };

/** jobByLinkKey's first statement: the keys, then the viewer. */
export function linkKeySql(d: Dialect, keys: number): string {
  return `SELECT j.id, k.key AS link_key FROM job_keys k JOIN jobs j ON j.id = k.job_id
     WHERE k.key_kind = 'link' AND k.key IN (${d.list(keys)}) AND ${jobVisibleTo('j')}`;
}

/**
 * The same address with a query: '?' sorts just below '@' in byte order, so the range holds exactly "<address>?…".
 * The range's bounds, then the viewer.
 */
export function sameAddressSql(d: Dialect): string {
  const key = d.collateC('k.key');
  return `SELECT j.id, k.key AS link_key FROM job_keys k JOIN jobs j ON j.id = k.job_id
     WHERE k.key_kind = 'link' AND ${key} >= ? AND ${key} < ? AND ${jobVisibleTo('j')} ORDER BY j.id LIMIT 50`;
}

/** The range of link keys holding a key's address with a query. */
export function addressRange(key: string): [string, string] {
  const address = key.split('?')[0]!;
  return [`${address}?`, `${address}@`];
}

/** The job of the first key stored exactly so. */
export function exactLinkKeyMatch(keys: readonly string[], rows: readonly LinkKeyRow[], posting: boolean): JobMatch | null {
  for (const key of keys) {
    const row = rows.find((candidate) => candidate.link_key === key);
    if (row) return { id: row.id, matchedBy: 'link_key', posting };
  }
  return null;
}

/**
 * The posting's own addresses, then the page's, as job links are stored (linkKey: no fragment, no tracking) and
 * without LINK_NOISE's parameters.
 */
export function postingKeys(ats: ParsedAtsUrl | null, url: string): string[] {
  return [
    ...new Set(
      [...(ats?.canonical ?? []), url]
        .map(linkKey)
        .filter((key): key is string => key !== null)
        .map(withoutLinkNoise),
    ),
  ];
}

/**
 * The text every stored link of a posting holds, on the platforms whose addresses spell one posting many ways (a
 * locale, a slug, a step, a query): its id where its addresses write it. Version 6: the new ATSs, whose posting, form
 * and steps differ by their path's tail or their query (a JazzHR or Breezy slug, Rippling's form query, Pinpoint's
 * pages, UltiPro's account step, Dayforce's steps, ADP's guest page and steps, a ClearCompany application's own id);
 * jr7 7a: Dayforce's and Dice's posting pages too. A link of any case is compared by what parseAtsUrl reads from it;
 * this text only narrows the links read.
 */
function samePostingNeedle(ats: ParsedAtsUrl): string | null {
  const id = ats.externalId;
  switch (ats.kind) {
    case 'workday':
      return `_${id}`;
    case 'icims':
      return `/jobs/${id}/`;
    case 'taleo':
      return `job=${encodeURIComponent(id)}`;
    case 'successfactors':
      return `career_job_req_id=${id}`;
    case 'oracle':
      return `/job/${id}`;
    case 'jobvite':
      return `/job/${id}`;
    case 'jazzhr':
      return `/apply/${id}/`;
    case 'bamboohr':
      return `/careers/${id}`;
    case 'rippling':
    case 'hibob':
      return `/jobs/${id}`;
    case 'breezy':
      return `/p/${id}-`;
    case 'careerplug':
      return `/jobs/${id}/`;
    case 'dayforce':
      // jr7 7a: its posting's own page too, /jobs/<id> with nothing after it.
      return `/jobs/${id}`;
    case 'pinpoint':
      return `/postings/${id}`;
    case 'paycor':
      return `id=${id}`;
    case 'ultipro':
      return `opportunityId=${id}`;
    case 'paylocity':
      return `/Apply/${id}`;
    case 'dice':
      // jr7 7a: the Easy Apply's /job-applications/<uuid> and the posting's /job-detail/<uuid>.
      return `/${id}`;
    case 'clearcompany':
      return `/jobs/${id}/apply`;
    case 'adp':
      return `jobId=${id}`;
    case 'smartrecruiters':
      // A one-click application by its publication, a posting by its number.
      return ats.canonical[0]?.includes('/oneclick-ui/') ? `/publication/${id}` : `/${id}`;
    // Version 7.
    case 'ukgready':
      return `ShowJob=${id}`;
    case 'paycom':
      return `/jobs/${id}`;
    case 'jobdiva':
    case 'eightfold':
      // JobDiva's job in its link key's id= and its address's #/jobs/<id>; Eightfold's pid= or /job/<id>.
      return id;
    default:
      return null;
  }
}

/** The host name an address names, as the WHATWG URL reader reads it (lower case), or null. */
export function hostOf(address: string | undefined): string | null {
  try {
    return new URL((address ?? '').trim()).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Where a posting's stored links may be: one range of link keys per host (job_keys' primary key), and which hosts count. A
 * posting's canonical host; for Workday every host of its tenant, which spells one posting on each
 * (<tenant>.myworkdayjobs.com, <tenant>.wd<n>.myworkdayjobs.com, wd<n>.myworkdaysite.com/recruiting/<tenant>).
 */
export interface PostingHosts {
  ranges: ReadonlyArray<readonly [string, string]>;
  allows: (host: string) => boolean;
}

const WORKDAY_SHARED_HOST = /^wd\d{1,3}\.myworkdaysite\.com$/;

function postingHosts(ats: ParsedAtsUrl): PostingHosts | null {
  const host = hostOf(ats.canonical[0]);
  if (!host) return null;
  const tenant = ats.kind === 'workday' ? ats.board?.toLowerCase() : undefined;
  if (tenant && /^[a-z0-9-]+$/.test(tenant)) {
    const own = new RegExp(`^${tenant}\\.(?:wd\\d{1,3}\\.)?myworkdayjobs\\.com$`);
    return {
      ranges: [
        [`https://${tenant}.`, `https://${tenant}/`],
        ['https://wd', 'https://we'],
      ],
      allows: (name) => own.test(name) || WORKDAY_SHARED_HOST.test(name),
    };
  }
  return { ranges: [[`https://${host}/`, `https://${host}0`]], allows: (name) => name === host };
}

/**
 * The jobs `viewer` may see whose stored link is in one of `hosts`' ranges (on a host it allows) and holds `needle`,
 * open ones first then the newest, read back with `same`: the first that names the same posting.
 */
async function jobByStoredLink(
  deps: Pick<AppDeps, 'db'>,
  viewer: string,
  hosts: PostingHosts,
  needle: string,
  same: (link: string) => boolean,
  posting: boolean,
): Promise<JobMatch | null> {
  const rows: StoredLinkRow[] = [];
  const sql = storedLinkSql(deps.db.dialect);
  for (const [from, to] of hosts.ranges) rows.push(...(await deps.db.all<StoredLinkRow>(sql, [from, to, needle, viewer])));
  return storedLinkMatch(deps.db.dialect, rows, hosts, same, posting);
}

/** jobByStoredLink's statement: a range of link keys (byte order), the needle, the viewer. */
export function storedLinkSql(d: Dialect): string {
  const key = d.collateC('k.key');
  return `SELECT j.id, j.active, k.key AS link_key FROM job_keys k JOIN jobs j ON j.id = k.job_id
     WHERE k.key_kind = 'link' AND ${key} >= ? AND ${key} < ? AND ${d.contains('k.key', '?')}
       AND ${jobVisibleTo('j')}
     ORDER BY j.active DESC, j.id DESC LIMIT 50`;
}

export type StoredLinkRow = { id: number; active: number | boolean; link_key: string };

/** The first of the ranges' rows (open ones first, then the newest) on a host they allow that names the same posting. */
export function storedLinkMatch(
  d: Dialect,
  rows: StoredLinkRow[],
  hosts: PostingHosts,
  same: (link: string) => boolean,
  posting: boolean,
): JobMatch | null {
  const open = (row: StoredLinkRow) => (d.isTrue(row.active) ? 1 : 0);
  rows.sort((a, b) => open(b) - open(a) || b.id - a.id);
  const row = rows.find((candidate) => hosts.allows(hostOf(candidate.link_key) ?? '') && same(candidate.link_key));
  return row ? { id: row.id, matchedBy: 'link_key', posting } : null;
}

/**
 * The ATSs whose board names a posting on whichever host shows it: Greenhouse's, Lever's, Ashby's and Workable's boards
 * and Workday's tenants. An iCIMS portal, a Taleo or SuccessFactors company and an Oracle site are a host's own (an
 * Oracle site is CX_1 or CX on most tenants): their host is part of the posting's identity. So is every new ATS's of
 * version 6: a tenant that is a host of its own (JazzHR, BambooHR, Breezy, CareerPlug, Pinpoint, HiBob, ClearCompany)
 * is told by its host, and on the one-host platforms the host is that one.
 */
const BOARD_IDENTITY_KINDS: ReadonlySet<AtsKind> = new Set<AtsKind>(['greenhouse', 'lever', 'ashby', 'workable', 'workday']);

/** An ATS posting's identity: its platform, its host where the board is a host's own, its board and id, in lower case. */
function postingIdentity(ats: ParsedAtsUrl): string {
  const host = BOARD_IDENTITY_KINDS.has(ats.kind) ? '' : (hostOf(ats.canonical[0]) ?? '');
  return `${ats.kind}|${host}|${(ats.board ?? '').toLowerCase()}|${ats.externalId.toLowerCase()}`;
}

/** The ATS posting a link names, as postingIdentity writes it; null for a link that names none (or LinkedIn's). */
export function postingIdentityOf(link: string | null | undefined): string | null {
  if (!link || isLinkedInHost(hostOf(link) ?? '')) return null;
  const read = parseAtsUrl(link);
  return read ? postingIdentity(read) : null;
}

/** The job a job id stands for now, for a viewer (jobs/store.ts; re-exported for the autofill routes). */
export { currentJobId };

/**
 * Version 5: the job whose stored link names the same Workday, iCIMS, Taleo, SuccessFactors or Oracle posting (version
 * 6: or a new ATS's) as `ats`, however it is spelt (another locale, location, slug, step, query or, for Workday, another
 * of the tenant's hosts): the same identity by parseAtsUrl (postingIdentity).
 */
async function jobBySamePosting(deps: Pick<AppDeps, 'db'>, viewer: string, ats: ParsedAtsUrl): Promise<JobMatch | null> {
  const search = samePostingSearch(ats);
  if (!search) return null;
  const { hosts, needle, same } = search;
  return (
    (await jobByStoredLink(deps, viewer, hosts, needle, same, true)) ??
    (await jobByOwnApplyLink(deps, viewer, hosts, needle, same))
  );
}

/** What jobBySamePosting looks for: the posting's hosts, the needle its links hold, and the same-identity test. */
export function samePostingSearch(
  ats: ParsedAtsUrl,
): { hosts: PostingHosts; needle: string; same: (link: string) => boolean } | null {
  const needle = samePostingNeedle(ats);
  const hosts = postingHosts(ats);
  if (!needle || !hosts) return null;
  const wanted = postingIdentity(ats);
  const same = (link: string) => {
    const read = parseAtsUrl(link);
    return read !== null && postingIdentity(read) === wanted;
  };
  return { hosts, needle, same };
}

/**
 * The viewer's own job made from a page whose Apply link (the employer's posting it was saved with) names the same
 * posting, on one of the posting's hosts: such a job keeps no link key, so its link is read here, among the viewer's
 * own jobs alone.
 */
async function jobByOwnApplyLink(
  deps: Pick<AppDeps, 'db'>,
  viewer: string,
  hosts: PostingHosts,
  needle: string,
  same: (link: string) => boolean,
): Promise<JobMatch | null> {
  return ownApplyLinkMatch(await deps.db.all<OwnApplyRow>(ownApplyLinkSql(deps.db.dialect), [viewer, needle]), hosts, same);
}

/** jobByOwnApplyLink's statement: the viewer, the needle. */
export function ownApplyLinkSql(d: Dialect): string {
  return `SELECT id, apply_url FROM jobs WHERE owner_user_id = ? AND superseded_by IS NULL AND ${d.contains('apply_url', '?')}
       ORDER BY active DESC, id DESC LIMIT 50`;
}

export type OwnApplyRow = { id: number; apply_url: string };

/** The first of the viewer's own page jobs whose Apply link, on one of the hosts, names the same posting. */
export function ownApplyLinkMatch(rows: readonly OwnApplyRow[], hosts: PostingHosts, same: (link: string) => boolean): JobMatch | null {
  const row = rows.find((candidate) => hosts.allows(hostOf(candidate.apply_url) ?? '') && same(candidate.apply_url));
  return row ? { id: row.id, matchedBy: 'link_key', posting: true } : null;
}

/** LinkedIn's job pages' host, as a LinkedIn job's canonical address names it. */
export const LINKEDIN_JOBS: PostingHosts = {
  ranges: [['https://www.linkedin.com/', 'https://www.linkedin.com0']],
  allows: (name) => name === 'www.linkedin.com',
};

/**
 * Version 5: the job whose stored link is this LinkedIn job's, in any of its spellings (a slug, a search's): a
 * LinkedIn job id names one posting, so the job is found by the posting's identity.
 */
async function jobByLinkedInLink(
  deps: Pick<AppDeps, 'db'>,
  viewer: string,
  linkedIn: ParsedLinkedInJob,
): Promise<JobMatch | null> {
  return jobByStoredLink(deps, viewer, LINKEDIN_JOBS, linkedIn.jobId, sameLinkedInJob(linkedIn), true);
}

/** Whether a link is this LinkedIn job's, in any of its spellings. */
export const sameLinkedInJob = (linkedIn: ParsedLinkedInJob) => (link: string) =>
  parseLinkedInJobUrl(link)?.jobId === linkedIn.jobId;

/**
 * The TailorIT job an address names, among the jobs `viewer` may see: by the ATS's posting id among the ingested
 * sources, else by its link, else (version 5) by a stored link naming the same posting.
 */
export async function findJob(
  deps: Pick<AppDeps, 'db'>,
  viewer: string,
  ats: ParsedAtsUrl | null,
  keys: readonly string[],
): Promise<JobMatch | null> {
  return (
    (ats ? await jobBySourceLink(deps, viewer, ats) : null) ??
    (await jobByLinkKey(deps, viewer, keys, ats !== null)) ??
    (ats ? await jobBySamePosting(deps, viewer, ats) : null)
  );
}

/**
 * Version 5: the job one of `keys` is `viewer`'s alias of (job_link_aliases: the account's own), the first key
 * winning; never another account's alias, never a job the viewer may not see. A LinkedIn job's alias (its canonical
 * address: one LinkedIn job id) names the posting itself; a page's or an employer link's alias names an address.
 */
export async function jobByAlias(deps: Pick<AppDeps, 'db'>, viewer: string, keys: readonly string[]): Promise<JobMatch | null> {
  if (keys.length === 0) return null;
  const rows = await deps.db.all<AliasRow>(aliasSql(deps.db.dialect, keys.length), [viewer, ...keys, viewer]);
  const exact = exactAliasMatch(keys, rows);
  if (exact) return exact;
  // An alias kept with a parameter LINK_NOISE has learned since (a visit's own, a click id): among the person's aliases
  // of the same address, the one that is the key once its noise is dropped.
  for (const key of keys) {
    const candidates = await deps.db.all<AliasRow>(sameAddressAliasSql(deps.db.dialect), [viewer, ...aliasRange(key), viewer]);
    const row = candidates.find((candidate) => aliasWithoutNoise(candidate.alias) === key);
    if (row) return aliasMatch(row);
  }
  return null;
}

export type AliasRow = { alias: string; job_id: number; kind: string };

/** jobByAlias's first statement: the viewer, the keys, the viewer. */
export function aliasSql(d: Dialect, keys: number): string {
  return `SELECT a.alias, a.job_id, a.kind FROM job_link_aliases a JOIN jobs j ON j.id = a.job_id
       WHERE a.user_id = ? AND a.alias IN (${d.list(keys)}) AND ${jobVisibleTo('j')}`;
}

/** jobByAlias's second statement: the viewer, a range of aliases (byte order), the viewer. */
export function sameAddressAliasSql(d: Dialect): string {
  const alias = d.collateC('a.alias');
  return `SELECT a.alias, a.job_id, a.kind FROM job_link_aliases a JOIN jobs j ON j.id = a.job_id
     WHERE a.user_id = ? AND ${alias} >= ? AND ${alias} < ? AND ${jobVisibleTo('j')} LIMIT 50`;
}

/** The range of aliases holding a key's address with a query. */
export function aliasRange(key: string): [string, string] {
  const address = key.split(/[?#]/)[0]!;
  return [`${address}?`, `${address}@`];
}

const aliasMatch = (row: AliasRow): JobMatch => ({ id: row.job_id, matchedBy: 'alias', posting: row.kind === 'linkedin' });

/** The job of the first key that is one of the rows' aliases exactly. */
export function exactAliasMatch(keys: readonly string[], rows: readonly AliasRow[]): JobMatch | null {
  for (const key of keys) {
    const row = rows.find((candidate) => candidate.alias === key);
    if (row) return aliasMatch(row);
  }
  return null;
}

/** A stored alias without the parameters LINK_NOISE drops, its fragment kept. */
export function aliasWithoutNoise(alias: string): string {
  const hash = alias.indexOf('#');
  return hash < 0 ? withoutLinkNoise(alias) : `${withoutLinkNoise(alias.slice(0, hash))}${alias.slice(hash)}`;
}

/** An address as a lookup reads it: its ATS posting, the keys its job is looked for by, and its aliases' form. */
export interface AddressReading {
  url: string;
  ats: ParsedAtsUrl | null;
  /** The posting's addresses and the address itself, as stored links are compared (postingKeys). */
  keys: string[];
  /** The address as an alias of it is kept (storedPageAddress; a LinkedIn job's canonical address). */
  aliasKeys: string[];
}

/** A lookup's page (version 5): the page's reading and LinkedIn job, and the employer's link's reading. */
export interface PageReading extends AddressReading {
  linkedIn: ParsedLinkedInJob | null;
  /**
   * The employer's link when the page showed one. Only one parseAtsUrl reads a posting from is an identity (`ats`,
   * `keys` and `aliasKeys` set); any other (a careers site's home page two jobs may share) is the Apply link alone,
   * never looked for or kept as an alias.
   */
  employer: AddressReading | null;
}

/**
 * How a lookup (or an add from the page) reads the page's address and the employer's link. `hash`: the alias key's
 * hash (alias-key.ts), so an ambiguous or long parameter keeps the page's alias its own (storedPageAddress).
 */
export function readPage(url: string, employerUrl?: string, hash: AliasValueHash = null): PageReading {
  const linkedIn = parseLinkedInJobUrl(url);
  // A LinkedIn page is never an ATS posting's, whatever its query says (a ?gh_jid= on it names nothing of LinkedIn's).
  const ats = isLinkedInHost(hostOf(url) ?? '') ? null : parseAtsUrl(url);
  let keys: string[];
  let aliasKeys: string[];
  if (linkedIn) {
    const canonical = linkKey(linkedIn.canonical)!;
    keys = [...new Set([canonical, ...postingKeys(null, url)])];
    aliasKeys = [canonical];
  } else if (ats) {
    keys = postingKeys(ats, url);
    aliasKeys = [storedPageAddress(ats.canonical[0] ?? url, hash)].filter((key): key is string => key !== null);
  } else {
    const stored = storedPageAddress(url, hash);
    // A page whose fragment names what it shows (#/jobs/101, #jobDetails=111_5) is that fragment's: its bare address
    // names no posting.
    keys = postingFragment(url.trim()) ? [] : postingKeys(null, url);
    aliasKeys = stored ? [stored] : [];
  }
  let employer: AddressReading | null = null;
  if (employerUrl) {
    const read = parseAtsUrl(employerUrl);
    const stored = read ? storedPageAddress(read.canonical[0] ?? employerUrl, hash) : null;
    employer = read
      ? { url: employerUrl, ats: read, keys: postingKeys(read, employerUrl), aliasKeys: stored ? [stored] : [] }
      : { url: employerUrl, ats: null, keys: [], aliasKeys: [] };
  }
  return { url, ats, keys, aliasKeys, linkedIn, employer };
}

/**
 * The job a page names for `viewer`, in the lookup's order (see above): a LinkedIn job through the viewer's alias of
 * it; the employer's posting (its posting id, its addresses, the viewer's alias of it); a page that is an ATS posting
 * by that posting, then the viewer's alias of it; the viewer's alias of any other page (the person's own word that
 * this page is that job, before a link another job merely shares), then the page's link as before version 5; then a
 * job stored with a link of that LinkedIn job. An alias of an ATS posting's address names the posting itself.
 */
export async function findPageJob(deps: Pick<AppDeps, 'db'>, viewer: string, page: PageReading): Promise<JobMatch | null> {
  return (await pageJobCandidates(deps, viewer, page))[0] ?? null;
}

/** An alias of an ATS posting's address (the employer's, or the page's when it is one) names the posting itself. */
export const asPosting = (match: JobMatch | null): JobMatch | null => (match ? { ...match, posting: true } : null);

/** Adds a step's match to the candidates, each job once. */
export function addCandidate(found: JobMatch[], match: JobMatch | null): void {
  if (match && !found.some((other) => other.id === match.id)) found.push(match);
}

/**
 * Every job each step of findPageJob's order finds for the page, in that order, each job once: an add from the page
 * takes the first it trusts (a posting's identity, or a link or alias whose job's title and company are the page's).
 */
export async function pageJobCandidates(deps: Pick<AppDeps, 'db'>, viewer: string, page: PageReading): Promise<JobMatch[]> {
  const employer = page.employer?.ats ? page.employer : null;
  const steps: Array<() => Promise<JobMatch | null>> = [
    async () => (page.linkedIn ? await jobByAlias(deps, viewer, page.aliasKeys) : null),
    async () => (employer ? await findJob(deps, viewer, employer.ats, employer.keys) : null),
    async () => (employer ? asPosting(await jobByAlias(deps, viewer, employer.aliasKeys)) : null),
    // A page that is an ATS posting: its posting as TailorIT has it before the person's alias of the page (which may
    // name their own job made from the page's text while the ATS would not give the posting).
    async () => (page.ats ? await findJob(deps, viewer, page.ats, page.keys) : null),
    async () =>
      page.linkedIn
        ? null
        : page.ats
          ? asPosting(await jobByAlias(deps, viewer, page.aliasKeys))
          : await jobByAlias(deps, viewer, page.aliasKeys),
    async () => (page.ats ? null : await findJob(deps, viewer, null, page.keys)),
    async () => (page.linkedIn ? await jobByLinkedInLink(deps, viewer, page.linkedIn) : null),
  ];
  const found: JobMatch[] = [];
  for (const step of steps) addCandidate(found, await step());
  return found;
}

/** Whether a link names a posting itself (version 5): a LinkedIn job, or an ATS posting parseAtsUrl reads. */
export function namesPosting(link: string): boolean {
  if (parseLinkedInJobUrl(link)) return true;
  return !isLinkedInHost(hostOf(link) ?? '') && parseAtsUrl(link) !== null;
}

/**
 * The keys that name the page's posting itself (version 5): the employer's ATS posting's and its alias, and the page's
 * own when it is an ATS posting or a LinkedIn job. A careers page's own address (which two jobs may share) is not one.
 */
export function identityKeys(page: PageReading): string[] {
  const keys = page.employer?.ats ? [...page.employer.keys, ...page.employer.aliasKeys] : [];
  if (page.ats || page.linkedIn) keys.push(...page.keys, ...page.aliasKeys);
  return [...new Set(keys)];
}

/** Every key a page's posting may be saved under: the employer's posting's, then the page's, then their aliases'. */
export function pageKeys(page: PageReading): string[] {
  return [
    ...new Set([...(page.employer?.keys ?? []), ...page.keys, ...(page.employer?.aliasKeys ?? []), ...page.aliasKeys]),
  ];
}

/**
 * The postings a page names, read (version 5): its LinkedIn job's id, and the ATS postings of the page and of the
 * employer's link. A tracker entry whose saved link reads as one of them is the page's, however its link is spelt.
 */
export interface PostingReadings {
  linkedIn: Set<string>;
  postings: Set<string>;
}

/** What a page's addresses (and, for a job, its own link) read as. */
export function readingsOf(page: PageReading | null, jobLinks: ReadonlyArray<string | null> = []): PostingReadings {
  const linkedIn = new Set<string>();
  const postings = new Set<string>();
  const add = (address: string | null | undefined) => {
    if (!address) return;
    const job = parseLinkedInJobUrl(address);
    if (job) linkedIn.add(job.jobId);
    const read = isLinkedInHost(hostOf(address) ?? '') ? null : parseAtsUrl(address);
    if (read) postings.add(postingIdentity(read));
  };
  if (page) {
    add(page.url);
    if (page.employer?.ats) add(page.employer.url);
  }
  for (const link of jobLinks) add(link);
  return { linkedIn, postings };
}

/** The answer's `page` (version 5): what the page is, its LinkedIn job, the employer's posting and how to add it. */
export function pageOf(page: PageReading): AutofillLookupPage {
  const employer = page.employer?.ats ?? null;
  const host = hostOf(page.url);
  let addWith: AutofillLookupPage['addWith'] = null;
  if (addablePosting(page.ats)) addWith = 'ats';
  else if (/^https:\/\//i.test(page.url.trim()) && host && (!isLinkedInHost(host) || page.linkedIn)) addWith = 'page';
  return {
    kind: page.linkedIn ? 'linkedin' : page.ats ? 'ats' : 'site',
    linkedInUrl: page.linkedIn?.canonical ?? null,
    employer: employer ? { kind: employer.kind, board: employer.board, externalId: employer.externalId } : null,
    addWith,
  };
}

/** v36 IMPORTTIME: the later of two ISO instants (either may be null). */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

interface JobRow {
  id: number;
  title: string;
  company_name: string;
  primary_location: string;
  locations_text: string;
  active: number | boolean;
  link_key: string | null;
  apply_url: string;
  posted_at: string | null;
  first_seen_at: string | null;
  /** v36 IMPORTTIME: when an admin's import last dated the job (jobs.reposted_at), or null. */
  reposted_at: string | null;
  work_arrangement: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  /** The job's industry id, else its company's; null when neither says. */
  industry: string | null;
  /** v30 X1-API: held for review (jobs.held_since: a new job from the extension, not approved yet). */
  held: boolean;
  /** v30 X1-API: this account has a report on the job's pending closed review. */
  reported: boolean;
  /** v30 FIX-B (REQ-1): the job's source's credit line as JSON text (jobs/credit.ts), or null. */
  credit_json: string | null;
}

export interface ApplicationRow {
  id: string;
  current_status: number;
  resume_id: string | null;
  tracked_on: string;
  archived_at: string | null;
}

export type ApplicationMatch = { row: ApplicationRow; matchedBy: 'job' | 'posting_url' };

/** What a tracker entry says of itself, for a caller choosing among the entries a page's addresses find. */
export interface EntryFacts {
  job_id: number | null;
  title: string;
  company_name: string;
}

/**
 * The account's application of the job, else the most recent of the account's own entries whose posting link is one
 * of `keys` (or the job's own link), or (version 5) reads as one of `readings`' postings however it is spelt (a
 * LinkedIn job's slug, ?trk= or ?currentJobId= spelling; a Workday posting's other locale or location). Add job
 * (jobs.ts) links the second kind, an entry added by hand, to the job before it saves it. With `accept`, only an
 * entry it accepts is found by its link.
 */
export async function findApplication(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  job: Pick<JobRow, 'id' | 'link_key'> | null,
  keys: readonly string[],
  readings: PostingReadings = { linkedIn: new Set(), postings: new Set() },
  accept?: (entry: EntryFacts) => boolean,
  hash: AliasValueHash = null,
): Promise<ApplicationMatch | null> {
  if (job) {
    const row = await deps.db.one<ApplicationRow>(APPLICATION_BY_JOB_SQL, [userId, job.id]);
    if (row) return { row, matchedBy: 'job' };
  }
  const wanted = wantedLinks(job, keys);
  if (wanted.size === 0 && readings.linkedIn.size === 0 && readings.postings.size === 0) return null;
  const rows = await deps.db.all<PostingEntryRow>(APPLICATIONS_BY_LINK_SQL, [userId, POSTING_URL_SCAN]);
  return entryByLink(rows, wanted, readings, accept, hash);
}

/** findApplication's statements: by its job (the account, the job), then by posting links. */
export const APPLICATION_BY_JOB_SQL =
  'SELECT id, current_status, resume_id, tracked_on, archived_at FROM applications WHERE user_id = ? AND job_id = ?';
export const APPLICATIONS_BY_LINK_SQL = `SELECT id, posting_url, current_status, resume_id, tracked_on, archived_at, job_id, title, company_name FROM applications
       WHERE user_id = ? AND posting_url <> '' ORDER BY updated_at DESC LIMIT ?`;
export { POSTING_URL_SCAN };

export type PostingEntryRow = ApplicationRow & EntryFacts & { posting_url: string };

/** The links an entry added by hand may keep: the page's keys and the job's own link (it keeps the address, not the job). */
export function wantedLinks(job: Pick<JobRow, 'id' | 'link_key'> | null, keys: readonly string[]): Set<string> {
  return new Set(job?.link_key ? [...keys, withoutLinkNoise(job.link_key)] : keys);
}

/** The most recent entry whose posting link is one wanted, or reads as one of the postings (see findApplication). */
export function entryByLink(
  rows: readonly PostingEntryRow[],
  wanted: ReadonlySet<string>,
  readings: PostingReadings,
  accept: ((entry: EntryFacts) => boolean) | undefined,
  hash: AliasValueHash,
): ApplicationMatch | null {
  const samePosting = (address: string) => {
    if (readings.linkedIn.size > 0) {
      const linkedInJob = parseLinkedInJobUrl(address);
      if (linkedInJob && readings.linkedIn.has(linkedInJob.jobId)) return true;
    }
    if (readings.postings.size === 0 || isLinkedInHost(hostOf(address) ?? '')) return false;
    const read = parseAtsUrl(address);
    return read !== null && readings.postings.has(postingIdentity(read));
  };
  const row = rows.find(
    (candidate) =>
      (wanted.has(withoutLinkNoise(linkKey(candidate.posting_url) ?? '')) ||
        wanted.has(storedPageAddress(candidate.posting_url, hash) ?? '') ||
        samePosting(candidate.posting_url)) &&
      (!accept || accept(candidate)),
  );
  if (!row) return null;
  const { posting_url: _url, job_id: _job, title: _title, company_name: _company, ...entry } = row;
  return { row: entry, matchedBy: 'posting_url' };
}

function choiceOf(item: AutofillResumeItem | null, reason: ResumeChoiceReason): AutofillResumeChoice | null {
  if (!item) return null;
  return { id: item.id, label: item.label, kind: item.kind, fileKind: item.fileKind, fileName: item.fileName, reason };
}

/**
 * The resume to attach, the first that applies: the one the person chose in the extension, the application's, the
 * profile's choice, TailorIT's best match for the job, the default, the latest. Each is one of the account's resumes
 * the extension may attach, or it is passed.
 */
async function suggestResume(
  deps: AppDeps,
  userId: string,
  chosenId: string | null,
  application: ApplicationRow | null,
  jobId: number | null,
): Promise<AutofillResumeChoice | null> {
  const chosen = choiceOf(await findAttachableResume(deps, userId, chosenId), 'chosen');
  if (chosen) return chosen;
  const fromApplication = choiceOf(await findAttachableResume(deps, userId, application?.resume_id ?? null), 'application');
  if (fromApplication) return fromApplication;
  const inProfile = (await readAutofillProfile(deps, userId)).value.documents.resumeId;
  const fromProfile = choiceOf(await findAttachableResume(deps, userId, inProfile), 'profile');
  if (fromProfile) return fromProfile;
  if (jobId !== null) {
    const best = (await bestResumes(deps, userId, [jobId], BEST_MATCH_BUDGET_MS, { quiet: true })).choices.get(jobId);
    const reason = best?.reason === 'only' ? 'only_resume' : 'best_match';
    const matched = choiceOf(await findAttachableResume(deps, userId, best?.resumeId ?? null), reason);
    if (matched) return matched;
  }
  return (
    choiceOf(await findAttachableResume(deps, userId, await defaultResumeId(deps, userId)), 'default') ??
    choiceOf(await latestAttachableResume(deps, userId), 'latest')
  );
}

/**
 * The suggested resume's keyword match to the job, read-only (matchResumeForJob), or null: no job, no resume, or it
 * could not be computed. Checked against the contract before it is answered, so a number the extension would refuse
 * drops only the match, never the lookup. Its warnings name neither the job nor the resume: either leads back to the
 * page.
 */
async function lookupMatch(
  deps: AppDeps,
  userId: string,
  jobId: number | null,
  resume: AutofillResumeChoice | null,
): Promise<AutofillLookupMatch | null> {
  if (jobId === null || resume === null) return null;
  try {
    const scored = await matchResumeForJob(deps, userId, jobId, resume.id);
    if (scored === null) return null;
    const { matchedCount, total, percentage } = scored.result;
    const match: AutofillLookupMatch =
      total === 0
        ? { state: 'no_keywords', resumeId: resume.id }
        : !scored.readable
          ? { state: 'unreadable', resumeId: resume.id }
          : { state: 'ok', resumeId: resume.id, matchedCount, total, percentage };
    if (AutofillLookupMatchSchema.safeParse(match).success) return match;
    deps.log.warn('[autofill] match: the keyword match does not fit the contract; answered without it');
    return null;
  } catch (error) {
    deps.log.warn(
      '[autofill] match: the keyword match failed; answered without it',
      error instanceof Error ? error.name : 'unknown',
    );
    return null;
  }
}

/** A stored arrangement as the contract names it, else null. */
function arrangementOf(value: string | null): WorkArrangement | null {
  return (WORK_ARRANGEMENTS as readonly string[]).includes(value ?? '') ? (value as WorkArrangement) : null;
}

/** An industry as the Jobs page names it ("Finance"); null for none, "not specified", "other" or an id TailorIT no longer
 *  knows, none of which says anything on the side panel's job card. */
function industryTextOf(value: string | null): string | null {
  if (value === null || value === NOT_SPECIFIED_INDUSTRY || value === 'other') return null;
  return industryLabel(value) || null;
}

/** The pay as the Jobs page writes it ("$120k - $150k/yr"), else null. */
function salaryTextOf(job: JobRow): string | null {
  const salary = salaryOf(job);
  return (salary && formatSalaryRange(salary.min, salary.max, salary.currency, salary.period)) || null;
}

/** The job a request names (`jobId`), or 404 `not_found` when TailorIT has no such job. */
async function chosenJob(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number): Promise<JobMatch> {
  // Another account's job made from a page is as good as none.
  const id = await currentJobId(deps, userId, jobId);
  if (id === null) throw notFound('That job');
  return { id, matchedBy: 'chosen' };
}

/**
 * POST /lookup's answer for one page address: `ats` null when parseAtsUrl does not read it (or the page is LinkedIn's),
 * `job` and `application` null when TailorIT has neither; the suggested resume is the one the person chose when it can
 * be attached, and still falls back to the profile's choice, the default or the latest (null only when the account has
 * no resume to attach); `match` scores it against the job; `page` (version 5) says how the page and the employer's
 * link were read. With `jobId` the job is that one (404 when there is none), and its application is found by the job
 * and its own link only, never by the page's address. With `employerUrl` the job is looked for by it first (see above).
 */
export async function lookupPosting(
  deps: AppDeps,
  userId: string,
  request: AutofillLookupRequest,
): Promise<AutofillLookupResponse> {
  const page = readPage(request.url, request.employerUrl, aliasValueHash(deps));
  const ats = page.ats;
  const chosen = request.jobId !== undefined;
  const keys = chosen ? [] : pageKeys(page);
  const found = request.jobId !== undefined ? await chosenJob(deps, userId, request.jobId) : await findPageJob(deps, userId, page);
  const job = found
    ? ((await deps.db.one<JobRow>(
        `SELECT j.id, j.title, c.name AS company_name, j.primary_location, j.locations_text, j.active,
           (SELECT k.key FROM job_keys k WHERE k.job_id = j.id AND k.key_kind = 'link' ORDER BY k.key LIMIT 1) AS link_key,
           j.apply_url, j.posted_at, j.first_seen_at, j.reposted_at, j.work_arrangement, j.salary_min, j.salary_max, j.salary_currency,
           j.salary_period, COALESCE(NULLIF(j.industry, ''), (SELECT NULLIF(cp.industry, '') FROM company_profiles cp WHERE cp.company_id = c.id)) AS industry,
           j.held_since IS NOT NULL AS held,
           EXISTS (SELECT 1 FROM job_reviews rv JOIN job_review_reports rr ON rr.review_id = rv.id
                   WHERE rv.job_id = j.id AND rv.kind = 'closed' AND rv.state = 'pending' AND rr.user_id = ?) AS reported,
           ${jobCreditSql('j')} AS credit_json
         FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`,
        [userId, found.id],
      )) ?? null)
    : null;
  // v3.0 PG-A: the posting's text lives in job_texts, read through the accessor (its plain text, as ingest derived it).
  const postingText = job && request.includePostingText ? ((await readJobText(deps.db, job.id))?.text ?? '') : '';
  // With `jobId`, the job's own link alone; else the page's postings, however a hand-added entry spells them.
  const readings = chosen ? readingsOf(null, [job?.apply_url ?? null]) : readingsOf(page, [job?.apply_url ?? null]);
  const application = await findApplication(deps, userId, job, keys, readings, undefined, aliasValueHash(deps));
  const suggestedResume = await suggestResume(
    deps,
    userId,
    request.resumeId ?? null,
    application?.row ?? null,
    job?.id ?? null,
  );
  return {
    ats: ats ? { kind: ats.kind, board: ats.board, externalId: ats.externalId } : null,
    job:
      job && found
        ? {
            id: job.id,
            title: job.title,
            companyName: job.company_name,
            location: job.primary_location || job.locations_text,
            active: deps.db.dialect.isTrue(job.active),
            matchedBy: found.matchedBy,
            ...(request.includePostingText
              ? { postingText: capUtf16(postingText, AUTOFILL_POSTING_TEXT_MAX) }
              : {}),
            // As the Jobs page's card dates it: when it was posted, else when TailorIT first saw it. v36 IMPORTTIME (SP v36
            // PLAN.md I1): a job an admin's import dated later (jobs.reposted_at) reads from then, as the Jobs page's row.
            postedAt: laterOf(isoTimestamp(job.posted_at) ?? isoTimestamp(job.first_seen_at), isoTimestamp(job.reposted_at)),
            salary: salaryTextOf(job),
            workArrangement: arrangementOf(job.work_arrangement),
            // The Jobs page's industry label (the side panel's job card shows it under the company); null when unknown.
            industry: industryTextOf(job.industry),
            // v30 X1-API (autofill API 9): held for review, and this account's pending closed report; absent when not.
            ...(job.held === true ? { held: true } : {}),
            ...(job.reported === true ? { reported: true } : {}),
            // v30 FIX-B (REQ-1): the source's credit line the card shows (absent: none asked).
            ...creditFieldOf(job.credit_json),
          }
        : null,
    application: application
      ? {
          id: application.row.id,
          status: application.row.current_status,
          trackedOn: application.row.tracked_on,
          archived: application.row.archived_at !== null,
          resumeId: application.row.resume_id,
          matchedBy: application.matchedBy,
        }
      : null,
    suggestedResume,
    match: await lookupMatch(deps, userId, job?.id ?? null, suggestedResume),
    page: pageOf(page),
  };
}
