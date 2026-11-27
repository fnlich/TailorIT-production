import type {
  CompanySizeId,
  EmploymentType,
  ExperienceLevel,
  JobKeyKind,
  JobKeywords,
  JobVerifyReason,
  Leadership,
  ParsedLocation,
  SalaryPeriod,
  WorkArrangement,
} from '@tailorit/shared';
import { boardDescriptorOf, BOARD_SOURCE_KINDS, type BoardSourceKind } from '@tailorit/shared/sourcing'; // v38 FRAME
import type { AppDeps } from '../../core/context';
import type { IngestHttp } from './http';

// The ingestion pipeline's shapes (docs/ARCHITECTURE.md §8): every adapter turns its source into RawPosting-s; the
// pipeline normalises them with the shared parsers and upserts companies, jobs, locations, links, FTS and analyses.

// v38 FRAME (SP v38 PLAN A1): a board kind's words, row (precedence, runs) and place in these lists are its descriptor's
// (@tailorit/shared/sourcing BOARD_DESCRIPTORS); the lists keep v3.7's kinds in their pinned order (SOURCE_KINDS is the
// MCP tool search_jobs' source filter) and take each later board kind after them, in the registry's order.

/** The board kinds after v3.7's (a v3.8 platform's), in the registry's order. */
const laterBoardKinds = (known: readonly string[]): BoardSourceKind[] => BOARD_SOURCE_KINDS.filter((kind) => !known.includes(kind));

/**
 * v3.7's kinds of source. 'workday' (autofill API version 5) holds the Workday postings Add job read, one at a time (the
 * read a posting's own page makes): never run as a board. 'page' (version 5) holds the jobs added from the text a
 * person saw on a page no ATS API reads (POST /api/autofill/jobs/from-page): never run, checked or closed.
 */
const V37_SOURCE_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'workday',
  'page',
  // v30 X1-API: the shared copies of page jobs an admin published (14 §5.3): one source, never run, checked or closed
  // by a run (job_source_kinds' ext_page row, precedence 0).
  'ext_page',
  'csv',
  'json',
  'ft_lake',
  'seed',
  // v30 S3: Workday career sites listed by their sitemaps (each posting read on its own), and the feeds of Personio,
  // Recruitee, Breezy and BambooHR (12 §3.2-3.3): new kinds of read (scheduler.ts NEW_READ_KIND_OF).
  'workday_site',
  'personio',
  'recruitee',
  'breezy',
  'bamboohr',
  // v30 S4: the US federal government's feed and the two remote-job APIs (12 §3.6-3.7): new kinds of read, run by the
  // worker once BOT_USER_AGENT is set (scheduler.ts NEW_READ_KIND_OF), USAJOBS and Himalayas only with their keys.
  'usajobs',
  'himalayas',
  'jobicy',
  // v30 S5: employers' career sites, read through the shared reader (adapters/careerSite.ts; off by default).
  'career_site',
  // v37 BOARDS (SP v37 PLAN I1): an employer's iCIMS site (<board>.icims.com), read by its sitemap through the ingest
  // client (adapters/icims.ts): a new kind of read (scheduler.ts NEW_READ_KIND_OF).
  'icims',
] as const;
export type SourceKind = (typeof V37_SOURCE_KINDS)[number] | BoardSourceKind;

/** Every kind of source: v3.7's (V37_SOURCE_KINDS), then each later board kind (v38 FRAME). */
export const SOURCE_KINDS: readonly [SourceKind, ...SourceKind[]] = [...V37_SOURCE_KINDS, ...laterBoardKinds(V37_SOURCE_KINDS)];

/** Public ATS boards: fetched over HTTP on the daily schedule. */
export const ATS_KINDS = ['greenhouse', 'lever', 'ashby', 'workable'] as const;
export type AtsKind = (typeof ATS_KINDS)[number];

/** The kinds that are no board the worker's due queue runs: the lake (v30 S4: and the feeds of many employers). */
const SCHEDULED_OTHER_KINDS: readonly SourceKind[] = ['ft_lake', 'usajobs', 'himalayas', 'jobicy'];

/**
 * Kinds the ingest worker's due queue runs (uploads and the demo seed run by hand). v30 S1-API: a new source of these
 * kinds is due at once (job_sources.next_run_at), then at its tier's cadence (scheduler.ts). v30 S3: the feeds are due
 * at once when made, like the boards (they still run only once the identity allows a new kind of read); v30 S5: a career
 * site runs on the due queue too, once SITE_READER_CAREER_PAGES and BOT_USER_AGENT allow it (scheduler.ts runnableKinds).
 * v38 FRAME: every board kind whose row runs (its descriptor's), in SOURCE_KINDS' order.
 */
export const SCHEDULED_KINDS: readonly SourceKind[] = SOURCE_KINDS.filter(
  (kind) => boardDescriptorOf(kind)?.row.runs ?? SCHEDULED_OTHER_KINDS.includes(kind),
);

/**
 * Kinds whose sources are never run, by the schedule or by hand: a Workday source's postings are read one at a time
 * (Add job, the daily check), and a job page's text is never read again. v38 FRAME: a board kind whose row runs not.
 */
export const UNRUN_KINDS: readonly SourceKind[] = SOURCE_KINDS.filter(
  (kind) => (boardDescriptorOf(kind) ? !boardDescriptorOf(kind)!.row.runs : kind === 'page' || kind === 'ext_page'),
);

/** v38 FRAME: the precedence of the kinds that are no board (a board kind's is its descriptor's row's). */
const OTHER_PRECEDENCE: Record<Exclude<SourceKind, BoardSourceKind>, number> = {
  csv: 3,
  json: 3,
  ft_lake: 2,
  seed: 1,
  page: 0,
  ext_page: 0,
  // v30 S4: job_source_kinds' precedence (12 §12.1): a government feed's fields under an ATS's, a remote API's under both.
  usajobs: 3,
  himalayas: 2,
  jobicy: 2,
};

/**
 * Which source's fields win when two describe one job: ATS > CSV/JSON > lake > seed > a page's text (what a person
 * saw, kept only until a source TailorIT reads describes the job). v38 FRAME: a board kind's is its job_source_kinds row's
 * (its descriptor's: 4 for an ATS's own data, a career site 3).
 */
export const SOURCE_PRECEDENCE: Readonly<Record<SourceKind, number>> = Object.fromEntries(
  SOURCE_KINDS.map((kind) => [kind, boardDescriptorOf(kind)?.row.precedence ?? OTHER_PRECEDENCE[kind as Exclude<SourceKind, BoardSourceKind>]]),
) as Record<SourceKind, number>;

/** What a source Add job made carries in its config (`addedBy`; liveness.ts names it ADDED_BY_AUTOFILL too). */
export const ADDED_BY_AUTOFILL = 'autofill';

/**
 * v31 FIX-LINK (SEC-1, SEC-3): Add job's source of one host's pages (a `career_site` made disabled and marked as Add
 * job's, jobs/add/page.ts): what a page read under it says (its JSON-LD) is whatever the page's owner wrote, so the store
 * never lets it rewrite a job another source made, never finds its job by text, and names its company only as the page
 * may (store.ts). A career site an admin made (enabled or not) is the admin's word for the host.
 */
export function isAddedPageSource(source: Pick<SourceRecord, 'kind' | 'enabled' | 'config'>): boolean {
  return source.kind === 'career_site' && !source.enabled && source.config?.addedBy === ADDED_BY_AUTOFILL;
}

/**
 * v31 FIX-LINK: the kinds whose jobs were stored from what a row or a browser said, never from TailorIT's own read (an
 * import's rows, the lake's, v3.0's published page copies): the legacy pass's (jobs/add/legacy.ts), and the only jobs a
 * page an add read may rewrite (store.ts).
 */
export const ROW_SOURCE_KINDS = ['csv', 'json', 'ft_lake', 'ext_page'] as const satisfies readonly SourceKind[];

/** The words of the kinds that are no board (a board kind's are its descriptor's runLabel, else its label). */
const OTHER_KIND_LABEL: Record<Exclude<SourceKind, BoardSourceKind>, string> = {
  page: 'Job pages',
  ext_page: 'Published page jobs',
  csv: 'CSV import',
  json: 'JSON import',
  ft_lake: 'free_tailor lake',
  seed: 'Demo seed',
  usajobs: 'USAJOBS', // v30 S4
  himalayas: 'Himalayas', // v30 S4
  jobicy: 'Jobicy', // v30 S4
};

/** Each kind in the API's words ("Workday" for Workday's one-posting kind). */
export const SOURCE_KIND_LABEL: Readonly<Record<SourceKind, string>> = Object.fromEntries(
  SOURCE_KINDS.map((kind) => {
    const board = boardDescriptorOf(kind);
    return [kind, board ? (board.runLabel ?? board.label) : OTHER_KIND_LABEL[kind as Exclude<SourceKind, BoardSourceKind>]];
  }),
) as Record<SourceKind, string>;

export const RUN_TRIGGERS = ['schedule', 'manual', 'upload', 'startup'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * v30 S1-API: `not_modified` is a conditional GET's 304 (12 §9.4): the listing is complete and unchanged. v31 RUNS:
 * `paused`, an admin paused it and it stopped at its next safe point (pause.ts).
 */
export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'partial', 'not_modified', 'paused'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The validators of a source's last complete listing: sent as a conditional GET (If-None-Match, If-Modified-Since). */
export interface ListingValidators {
  etag: string | null;
  lastModified: string | null;
}

/**
 * A job_sources row, its config parsed. v30 S1-API: v2.0's `schedule` is gone (migration 0013); the due queue reads
 * the Part 2 columns below (optional here, so a test's or the Test button's source needs only v2.0's fields).
 */
export interface SourceRecord {
  id: number;
  kind: SourceKind;
  name: string;
  config: Record<string, unknown>;
  companyId: number | null;
  enabled: boolean;
  deactivateMissing: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The host its reads go to (crawl_hosts', site_robots' key); null for a kind that reads no outside host. */
  host?: string | null;
  tier?: string;
  nextRunAt?: string | null;
  priority?: number;
  termsStatus?: string;
  robotsStatus?: string;
  /** The last complete listing's validators (a conditional GET's). */
  etag?: string | null;
  lastModified?: string | null;
  lastCompleteAt?: string | null;
  lastChangeAt?: string | null;
  consecutiveFailures?: number;
  openJobs?: number;
  /** A run holds the source until then (one run at a time, across processes). */
  leaseUntil?: string | null;
  aiInput?: boolean;
  discoveredVia?: string | null;
  /** v31 RUNS: an admin paused it (no run starts until Continue); null while it is not paused. */
  pausedAt?: string | null;
  /** v36 SOURCES: when an admin last turned it on (job_sources.enabled_at); null when no admin ever did. */
  enabledAt?: string | null;
}

export interface RawCompany {
  name: string;
  tagline?: string | null;
  about?: string | null;
  website?: string | null;
  sizeBucket?: CompanySizeId | null;
  /** A head count, bucketed with companySizeBucket when no bucket is given. */
  employees?: number | null;
  industry?: string | null;
  headquarters?: string | null;
  foundedYear?: number | null;
  stage?: string | null;
  funding?: string | null;
  links?: Array<{ label: string; url: string }>;
  sponsorsH1b?: boolean | null;
  logoPath?: string | null;
  /**
   * v38 FRAME (SP v38 PLAN A6): the company's logo on the platform (https): kept in its company source row for the logo
   * pipeline to copy (companies/site/step.ts), never hot-linked.
   */
  logoSourceUrl?: string | null;
}

export interface RawSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
  raw?: string | null;
}

export interface RawSections {
  requirements?: string[];
  responsibilities?: string[];
  desired?: string[];
}

/** An analysis that comes with the posting (free_tailor's lake), stored as `source = 'ft_lake'`. */
export interface ProvidedAnalysis {
  source: 'ft_lake';
  version: number;
  model?: string | null;
  keywords: JobKeywords;
  requirements?: string[];
  responsibilities?: string[];
  desired?: string[];
  experienceLevels?: ExperienceLevel[];
  leadership?: Leadership | null;
  minYears?: number | null;
  categoryId?: string | null;
  subcategoryIds?: string[];
  extras?: Record<string, unknown>;
}

/** One posting as an adapter read it. Only `sourceJobId`, `title`, `company.name` and `url` are required. */
export interface RawPosting {
  /** Unique within the source (the board's job id, the lake row id, a CSV row's link). */
  sourceJobId: string;
  title: string;
  company: RawCompany;
  /** HTML, entity-decoded but not yet sanitized. */
  descriptionHtml?: string | null;
  /** Plain text, for sources without HTML. */
  descriptionText?: string | null;
  /** Sections the source states itself (Lever lists, seed data). */
  sections?: RawSections | null;
  /** The original posting: Apply always opens it. */
  url: string;
  locations?: string[];
  /** Places the source knows precisely (the lake's region/state), used when `locations` names none. */
  places?: ParsedLocation[];
  /** An ISO country code for places that name none (Lever's `country`). */
  countryHint?: string | null;
  workArrangement?: WorkArrangement | null;
  /** Free text that may say the arrangement (Greenhouse metadata, a CSV column). */
  arrangementText?: string | null;
  employmentType?: EmploymentType | null;
  /** Free text that may say the employment type (Lever's commitment, a CSV column). */
  employmentText?: string | null;
  experienceLevels?: ExperienceLevel[];
  leadership?: Leadership | null;
  categoryId?: string | null;
  subcategoryIds?: string[];
  department?: string | null;
  salary?: RawSalary | null;
  /** A salary as text ("$120k - $150k"), read when `salary` is not given. */
  salaryText?: string | null;
  sponsorsH1b?: boolean | null;
  requiresClearance?: boolean | null;
  degree?: string | null;
  industry?: string | null;
  postedAt?: string | null;
  updatedAt?: string | null;
  /** False when a successful fetch does not prove the posting is live (the lake): last_verified_at stays NULL. */
  verified?: boolean;
  /** False for a posting the source lists as stale (the lake's old rows): the job is kept inactive. */
  active?: boolean;
  analysis?: ProvidedAnalysis | null;
  /** Data fetched for some postings only (Greenhouse pay ranges); not part of the change hash. */
  supplement?: { salary?: RawSalary | null } | null;
  /** True when a supplement may fill the salary later: a posting without one keeps the stored salary. */
  salaryPending?: boolean;
  /**
   * The account a job made from the text of a page it had open belongs to (autofill API version 5, set by POST
   * /api/autofill/jobs/from-page alone): its job is that account's (jobs.owner_user_id), is never merged with another
   * job and keeps no link key, so no other posting, account or source ever finds it by its link or its text.
   */
  ownerUserId?: string | null;
  /**
   * v30 S5: identity keys the adapter read beside the posting's address (a career page's JSON-LD identifier `ld`, a
   * company page's ?gh_jid= `ghjid` and the board posting it resolves to): the store matches and writes them with the
   * address's own keys (12 §7.1-7.2; career/keys.ts).
   */
  keys?: Array<{ kind: JobKeyKind; key: string }>;
  /**
   * v30 S5: a career page's JobPosting hiringOrganization: the store hands it to the posting's company's sources
   * (12 §3.4 step 5; career/handoff.ts, companies/hiring-org.ts).
   */
  hiringOrganization?: { name: string | null; sameAs: string[]; url: string | null; logo: string | null } | null;
}

export interface FetchFailure {
  sourceJobId?: string;
  message: string;
}

export interface FetchResult {
  postings: RawPosting[];
  /**
   * True when `postings` is the source's whole current listing, so a stored posting that is not in it has closed.
   * False for a listing that stopped part-way (a page failed): nothing is deactivated then.
   */
  complete: boolean;
  /** Postings the adapter could not read; counted as failed, never deactivated. */
  failures: FetchFailure[];
  /** Ids the listing named but the adapter skipped on purpose (unlisted): they count as seen. */
  skippedIds?: string[];
  /**
   * v30 S1-API: the listing answered 304 to a conditional GET: it is complete and unchanged, `postings` is empty, and
   * nothing is upserted or marked missing (12 §9.4).
   */
  notModified?: boolean;
  /** v30 S1-API: the listing's validators, kept for the next run's conditional GET (only for a listing read whole). */
  validators?: ListingValidators | null;
  /**
   * v30 INT-4 (S3's edit D): jobs the adapter closed by reading their own postings (a Workday site's or a career site's
   * gone page: closeLink, outside the store's batches); the run's `deactivated` count includes them.
   */
  closedByRead?: number;
  /**
   * v37 LANE (SP v37 PLAN W4): the run stopped early at a held host or a paused lane (Workday's), keeping what it read:
   * the hold's end (ISO). The source's next run is due after it, as for a run a hold stopped at its start.
   */
  heldUntil?: string | null;
  /**
   * v37 FIX-37A (SP v37 FIXES-37 E9, REVIEW37-ux L14): a run of a board whose listing is never complete (an iCIMS site,
   * a Workday career site: `complete` stays false, so nothing closes by absence) that read every posting it planned,
   * none failed and none due left for later: it succeeded, not partial.
   */
  readAll?: boolean;
}

export interface AdapterContext {
  deps: AppDeps;
  http: IngestHttp;
  signal: AbortSignal;
  log(line: string): void;
  /** Postings of this source whose pay range has never been checked (Greenhouse's per-job pay request). */
  needsPayCheck(sourceJobId: string): boolean | Promise<boolean>;
  /**
   * A test of the source's settings (Admin › Sources › Test), which stores nothing: an adapter that reads each posting
   * on its own (Workable) answers its listing alone, titles and places, so the test does not wait for every posting.
   */
  listingOnly?: boolean;
  /**
   * v30 S1-API: the last complete listing's validators: an adapter sends them with its listing's request
   * (conditionalOf) and answers `notModified` on a 304.
   */
  validators?: ListingValidators | null;
}

export interface SourceAdapter {
  kind: SourceKind;
  fetch(source: SourceRecord, ctx: AdapterContext): Promise<FetchResult>;
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}

/** v30 S1-API: the board itself answered 404 (no such board): the source's tier becomes `not_found` (12 §9.3). */
export class SourceNotFoundError extends IngestError {
  constructor(message: string) {
    super(message);
    this.name = 'SourceNotFoundError';
  }
}

/**
 * v38 FRAME (SP v38 PLAN A3): a platform's own word that one posting can't be read, now (`unavailable`, `blocked`: try
 * later) or at all (any other reason: can't read, e.g. a job site behind its employer's own login): a board descriptor's
 * readPosting answers it, and postings.ts fetchPosting throws it, so every link read gives it as its verdict
 * (jobs/add/verdict.ts atsFailure, jobs/add/board-link.ts boardLinkFailure) and a re-check leaves the link as it is.
 */
export class PostingUnreadableError extends IngestError {
  constructor(readonly reason: JobVerifyReason) {
    super(`The posting can't be read (${reason}).`);
    this.name = 'PostingUnreadableError';
  }
}
