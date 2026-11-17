import type {
  CompanySizeId,
  EmploymentType,
  ExperienceLevel,
  JobKeyKind,
  JobKeywords,
  Leadership,
  ParsedLocation,
  SalaryPeriod,
  WorkArrangement,
} from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { IngestHttp } from './http';

// The ingestion pipeline's shapes (docs/ARCHITECTURE.md §8): every adapter turns its source into RawPosting-s; the
// pipeline normalises them with the shared parsers and upserts companies, jobs, locations, links, FTS and analyses.

/**
 * Every kind of source. 'workday' (autofill API version 5) holds the Workday postings Add job read, one at a time (the
 * read a posting's own page makes): never run as a board. 'page' (version 5) holds the jobs added from the text a
 * person saw on a page no ATS API reads (POST /api/autofill/jobs/from-page): never run, checked or closed.
 */
export const SOURCE_KINDS = [
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
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Public ATS boards: fetched over HTTP on the daily schedule. */
export const ATS_KINDS = ['greenhouse', 'lever', 'ashby', 'workable'] as const;
export type AtsKind = (typeof ATS_KINDS)[number];

/**
 * Kinds the ingest worker's due queue runs (uploads and the demo seed run by hand). v30 S1-API: a new source of these
 * kinds is due at once (job_sources.next_run_at), then at its tier's cadence (scheduler.ts).
 */
export const SCHEDULED_KINDS: readonly SourceKind[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'ft_lake',
  // v30 S3: due at once when made, like the boards (they still run only once the identity allows a new kind of read).
  'workday_site',
  'personio',
  'recruitee',
  'breezy',
  'bamboohr',
  'usajobs', // v30 S4
  'himalayas', // v30 S4
  'jobicy', // v30 S4
  // v30 S5: a career site runs on the due queue too, once SITE_READER_CAREER_PAGES and BOT_USER_AGENT allow it
  // (scheduler.ts runnableKinds).
  'career_site',
];

/**
 * Kinds whose sources are never run, by the schedule or by hand: a Workday source's postings are read one at a time
 * (Add job, the daily check), and a job page's text is never read again.
 */
export const UNRUN_KINDS: readonly SourceKind[] = ['workday', 'page', 'ext_page'];

/**
 * Which source's fields win when two describe one job: ATS > CSV/JSON > lake > seed > a page's text (what a person
 * saw, kept only until a source TailorIT reads describes the job).
 */
export const SOURCE_PRECEDENCE: Record<SourceKind, number> = {
  greenhouse: 4,
  lever: 4,
  ashby: 4,
  workable: 4,
  workday: 4,
  csv: 3,
  json: 3,
  ft_lake: 2,
  seed: 1,
  page: 0,
  ext_page: 0,
  // v30 S3: job_source_kinds' precedence (4: an ATS's own data).
  workday_site: 4,
  personio: 4,
  recruitee: 4,
  breezy: 4,
  bamboohr: 4,
  // v30 S4: job_source_kinds' precedence (12 §12.1): a government feed's fields under an ATS's, a remote API's under both.
  usajobs: 3,
  himalayas: 2,
  jobicy: 2,
  career_site: 3, // v30 S5 (job_source_kinds' precedence: below the ATS APIs)
};

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  workday: 'Workday',
  page: 'Job pages',
  ext_page: 'Published page jobs',
  csv: 'CSV import',
  json: 'JSON import',
  ft_lake: 'free_tailor lake',
  seed: 'Demo seed',
  // v30 S3
  workday_site: 'Workday career site',
  personio: 'Personio',
  recruitee: 'Recruitee',
  breezy: 'Breezy HR',
  bamboohr: 'BambooHR',
  usajobs: 'USAJOBS', // v30 S4
  himalayas: 'Himalayas', // v30 S4
  jobicy: 'Jobicy', // v30 S4
  career_site: 'Career site', // v30 S5
};

export const RUN_TRIGGERS = ['schedule', 'manual', 'upload', 'startup'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** v30 S1-API: `not_modified` is a conditional GET's 304 (12 §9.4): the listing is complete and unchanged. */
export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'partial', 'not_modified'] as const;
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
