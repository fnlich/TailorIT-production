import type {
  AiJobSearchResult,
  CustomFilterState,
  FilterVerdict,
  JobSourceDiscoveredVia,
  JobSourceKind,
  JobSourcePurgeRequest,
  PrepareFilters,
  PrepareFiltersExtra,
  PrepareJob,
  PrepareJobState,
  PrepareMode,
  PrepareStartRequest,
  PrepareStartResponse,
} from '@tailorit/shared';
import type { PersonPayer } from './accounts/payer'; // v33 SHARE-3, SHARE-5 (INT-1: a person's)
import type { NormalizedCompany } from '../features/ingest/normalize';
import type { AppDeps } from './context';
import type { DbTx } from './db/types';

// v2.0: the seams wave 1 codes against (docs/design/v2.0, PLAN.md W0-B). Each service is an interface here, built by
// the package named on it and put on deps.services by that package's feature (services hook). A package that calls
// another's service fakes it in its tests until INT wires the real one. The two function seams are re-exported from
// their stub files: the AI gate (ai/gate.ts, P1) and the queue insert (features/autofill/agent/prepared.ts, P3).

export { assertServerAi, serverAiRefusal, type AiRefusal } from '../ai/gate';
export { insertPreparedRow, type PreparedRowInput, type PreparedRowResult } from '../features/autofill/agent/prepared';

// v33 SHARE-5 (the SHARE-5 review's decision 4): who starts a Prepare, required at every start, so a caller that forgets
// it is a compile error rather than the owner paying for (and skipping the OK of) someone else's work.
/** Who starts a Prepare and pays, and what its answer may show. */
export interface PrepareStartOptions {
  /**
   * Who pays: the request's payer (payerOf: B under the grant on a profile shared with them; else the signed-in
   * person), or MCP's caller (SHARE-8: payerOfGrant(grant, 'mcp') on a shared profile).
   */
  payer: PersonPayer;
  /** What the answer's filter reasons may show (`sensitive` false: an eligibility reason as one word); absent: all. */
  viewer?: { sensitive: boolean };
}

/**
 * P2 (05-prepare-flow.md): Prepare. `deps.services.prepare`, set by features/prepare.
 * (v1.5's run-based runner stays at deps.services.prepareRunner until P2 replaces it.)
 */
export interface PrepareService {
  /**
   * POST /api/prepare (mode 'server') and MCP prepare_start (mode 'mcp'): the entries, the filters (verdicts recorded
   * even when a later check refuses), the AI check (server only), the resume limit, the queue room, then the
   * prepare_jobs rows and the reusable kits queued, in one transaction. Throws one AppError for the whole
   * request (ai_unavailable, ai_usage_exhausted, resume_limit_reached, conflict for a full queue). v33 SHARE-5:
   * `options.payer` required (PrepareStartOptions).
   */
  startPrepare(userId: string, request: PrepareStartRequest, mode: PrepareMode, options: PrepareStartOptions): Promise<PrepareStartResponse>;
  /**
   * POST /api/prepare/:id/cancel: a waiting Prepare at once, an active one when the runner sees it. 404: not theirs.
   * v33 INT-D (SHARE-8's seam edit): `options.actorId`, who asks (someone other than the owner may cancel only the
   * Prepares they started); `options.viewer`, what the answer may show.
   */
  cancel(userId: string, prepareId: string, options?: { actorId?: string; viewer?: { sensitive: boolean; readerId?: string } }): Promise<PrepareJob>;
  /**
   * After an MCP save: when the application's active `mcp` Prepare has its required parts ready (the resume, and the
   * letter when wanted), queues it (insertPreparedRow) in the same transaction. Null when there is nothing to finish.
   * v33 INT-D (SHARE-8's seam edit): `options.startedBy`, only a Prepare that person's AI started.
   */
  finishIfComplete(
    userId: string,
    applicationId: string,
    options?: { startedBy?: string },
  ): Promise<{ prepareId: string; state: PrepareJobState; queueId: string | null; queueFull: boolean } | null>;
  /** Wakes the server runner (after a start, a cancel, or a constant change). */
  kick(): void;
}

/** One saved job's filter result, for P2 (the check), P3 (stale verdicts of the Saved list) and P5 (filter_jobs). */
export interface FilterCheck {
  applicationId: string;
  jobId: number;
  verdict: FilterVerdict;
  /** The Custom filter's state for this job: its stored verdict, `pending` (not judged), or `off`. */
  custom: CustomFilterState;
}

/** P4 (06-filters-analysis.md): the prepare filters. `deps.services.prepareFilters`, set by features/prepare-filters. */
export interface PrepareFilterService {
  /** The person's saved filters (user_settings.prepare_filters, `{}` = nothing filtered) and their revision. */
  filtersOf(userId: string): Promise<{ filters: PrepareFilters; revision: number }>;
  /**
   * Ensures the jobs' facts (no AI) and runs the saved filters over the person's applications, `extra` narrowing on top
   * (MCP's filter_jobs; never loosening). With `record`, each verdict is written to prepare_filter_results in its own
   * transaction. Applications that are not the person's, or have no job, are left out.
   */
  evaluate(
    userId: string,
    applicationIds: readonly string[],
    options?: { extra?: PrepareFiltersExtra; record?: boolean },
  ): Promise<FilterCheck[]>;
  /** The Custom filter's prompt and its hash (the first 16 hex characters of its SHA-256) when it is on; else null. */
  customPrompt(userId: string): Promise<{ prompt: string; hash: string } | null>;
  /** Stores verdicts under the person's current prompt hash and each job's content hash; others are ignored. */
  saveCustomVerdicts(
    userId: string,
    verdicts: ReadonlyArray<{ jobId: number; pass: boolean; reason?: string }>,
    decidedBy: 'server' | 'mcp',
  ): Promise<{ saved: number; ignored: number[] }>;
  /**
   * The server path: judges the jobs with no fresh verdict in `custom_filter` tasks (charged), and stores them.
   * `prepareId` (v2.0 INT, P4): the Prepare it is for, named in each task's input (`prepare: {id}`), so its cost adds up
   * on that Prepare. v33 SHARE-5: `payer`, the Prepare's payer (B on a profile shared with them; the owner for their own: v33 INT-1, required).
   */
  judgeOnServer(userId: string, jobIds: readonly number[], prepareId: string | undefined, payer: PersonPayer): Promise<Map<number, 'pass' | 'fail'>>; // v33 SHARE-3, SHARE-5: payer (INT-1: required)
}

/** P6a (04-accounts-limits.md §4): AI job search, Paid only. `deps.services.aiSearch`, set by features/jobs. */
export interface AiSearchService {
  /**
   * assertFeature('ai_job_search'), then the AI gate; queues a `job_search` task charged to the person. v33 SHARE-3:
   * `payer` (core/accounts/payer.ts) pays and its plan decides (B on A's profile; v33 INT-1: required).
   */
  start(userId: string, text: string, payer: PersonPayer): Promise<{ taskId: string }>; // v33 INT-1: payer required
  /** Waits for the person's task (the MCP tool: up to 60 s) and answers its result, parsed with JobsQuerySchema. */
  result(userId: string, taskId: string, waitMs: number): Promise<AiJobSearchResult>;
}

declare module './context' {
  interface AppServices {
    /** v2.0, P2: Prepare. */
    prepare?: PrepareService;
    /** v2.0, P4: the prepare filters. */
    prepareFilters?: PrepareFilterService;
    /** v2.0, P6a: AI job search. */
    aiSearch?: AiSearchService;
  }
}

// ── v3.0 wave 3 (v30 SCH): the seams waves 3 and 4 code against ───────────────────────────────────────────────────────
// docs/design/part2 (11, 12, 13, 14) and the build plan's §9. Each seam is a function (or an object of functions)
// taking `deps` first, exported from a stub file in its builder's own folder and re-exported below: callers import it
// from core/seams. Until its package builds it, the stub throws SeamNotBuiltError (core/seam-stub.ts). A package that
// calls another's seam fakes it in its own tests, by the stub file's path (the re-export follows the mock):
//
//   vi.mock('../src/features/ingest/close', () => ({
//     closeLink: vi.fn(async () => ({ linksClosed: 1, liveLinks: 0, jobClosed: true })),
//   }));
//
// v30 INT-3 wired every seam wave 3 built (closeLink, purgeSource, recheckPosting, resolveCompany, offerToDiscovery,
// jobReviews); v30 INT-4: E2 built siteReader (core/http/reader), so no seam is a stub any more (`grep -rn "v30 stub"`
// finds only the notes and tests that name the mark). A seam taking `t: DbTx` runs in the
// caller's transaction and does no outside I/O; recheckPosting and siteReader read outside hosts and refuse to run
// inside a transaction (deps.db.assertNoTx). An implementation imports core/seams for its types only (`import type`),
// so the re-exports below never make an import cycle.

/** Why a link closes (closeLink): its listings, its own read, an approved report, a purge, an admin. */
export const CLOSE_LINK_REASONS = ['missing', 'gone', 'report', 'purge', 'admin'] as const;
export type CloseLinkReason = (typeof CLOSE_LINK_REASONS)[number];

/** A link of a job: job_source_links' key (the source and the posting's id there). */
export interface JobLinkRef {
  sourceId: number;
  sourceJobId: string;
}

export interface CloseLinkInput {
  jobId: number;
  /** The link to close; omitted: every live link of the job (a report about the job as a whole, an admin's close). */
  link?: JobLinkRef;
  /**
   * `missing`: absent from INGEST_CLOSE_AFTER_MISSES complete listings in a row (12 §8.2); `gone`: its own read answered
   * 404/410, an errorCode, `posted: false` or a past validThrough (12 §8.1); `report`: an approved closed report (14
   * §5.1 step 5); `purge`: purgeSource's batch (11 §8.5); `admin`: an admin's close of a flagged job (14 §5.4).
   */
  reason: CloseLinkReason;
  /** The time it closes at (ISO): the link's missing_since, the job's closed_at. */
  at: string;
  /**
   * v37 FIX-REV (SP v37 FIXES-361.md D1): TailorIT's own read confirmed it (an approved report its re-check found gone):
   * what else waits on the job in Admin › Review is settled as `gone` and `missing` settle it ("Closed: confirmed by
   * TailorIT"), not as any other report's ("The job closed").
   */
  confirmed?: boolean;
}

export interface CloseLinkResult {
  /** Links this call marked missing (a link already missing is not counted). */
  linksClosed: number;
  /** The job's live links after it. */
  liveLinks: number;
  /** The job was open and closed now (no live link left). */
  jobClosed: boolean;
}

/**
 * closeLink, the one close function (DB-INGEST, features/ingest/close.ts; 12 §8, 11 §8.3, 14 §5.1 step 5). In the
 * caller's transaction: the link gets missing_since = at and miss_count at INGEST_CLOSE_AFTER_MISSES, as its own
 * read's 404 would; when no live link is left (or the job has none, as an own page job) the job closes (active false,
 * closed_at = at) and leaves job_search through projectJob in the same transaction. Queue rows of a closed job fail
 * `posting_closed` as today. A link seen again later reopens the job (DB-INGEST's store, which then calls
 * jobReviews.reopenedBySource). Callers: X1-API (approved closed reports, an admin's close of a flag), S1-API (the
 * purge's batches, the own reads of liveness), DB-INGEST's store (two misses).
 */
export type CloseLink = (deps: AppDeps, t: DbTx, input: CloseLinkInput) => Promise<CloseLinkResult>;

/** A purge to queue (11 §8.5, 12 §8.5): CT's request (a source xor a company), and who asked. */
export type PurgeSourceInput = JobSourcePurgeRequest & {
  /** The admin's account id; null for a company opt-out's own purge (E0-API). */
  requestedBy: string | null;
  at: string;
};

export interface PurgeSourceResult {
  /** The job_source_purges row: the one queued now, or the open purge of the same source or company. */
  purgeId: number;
  /** False when an open purge (queued or running) of the same source or company already covered it. */
  queued: boolean;
}

/**
 * purgeSource (S1-API, features/ingest/purge.ts; 11 §8.5, 12 §8.5). In the caller's transaction: queues a
 * job_source_purges row (state `queued`). S1-API's housekeeping step then works it in batches of 1,000 jobs from
 * cursor_job_id: the source (or every source of the company) disabled with a terms note and its candidates
 * `forbidden`; its live links closed through closeLink (reason `purge`); raw payloads deleted; with deleteTexts the
 * texts, analyses and facts of jobs no other source lists deleted, keeping an applied job's text unless
 * deleteAppliedTexts; the jobs' pending reviews superseded (jobReviews.supersede, reason `purged`); the counts on the
 * row, `done`. Callers: S1-API's admin sources API, E0-API's company opt-out (with crawl_opt_outs).
 */
export type PurgeSource = (deps: AppDeps, t: DbTx, input: PurgeSourceInput) => Promise<PurgeSourceResult>;

/** How resolveCompany found the company (13 §5.3). */
export const RESOLVE_COMPANY_MATCHES = ['board', 'domain', 'name', 'new', 'own'] as const;
export type ResolveCompanyMatch = (typeof RESOLVE_COMPANY_MATCHES)[number];

export interface ResolveCompanyInput {
  /** The posting's company as ingest normalises it (its name and name key, and what the posting says about it). */
  company: NormalizedCompany;
  /**
   * The board alias of the posting's board ('<platform>:<board>' or 'site:<host>': @tailorit/shared boardAlias,
   * siteAlias); null for feeds of many employers, imports and pages.
   */
  boardAlias: string | null;
  /** Domain hints, strongest first (13 §5.2): the posting's hiringOrganization sameAs/url, a careers page's host. */
  domains?: readonly string[];
  /** A page job's owner: the company is that account's own row (never enriched, 13 §5.6) unless a shared row fits. */
  ownerUserId: string | null;
  /** The source the posting was read from (job_sources.id), when one was: its company_id is set when empty. */
  sourceId: number | null;
  at: string;
}

export interface ResolveCompanyResult {
  companyId: number;
  matchedBy: ResolveCompanyMatch;
  /** A company row was made now. */
  created: boolean;
  /** companies.do_not_fetch: its boards never become candidates, its held jobs are never approved automatically. */
  doNotFetch: boolean;
  /** Jobs filed under another row before (an account's own row merged into it): the caller re-projects them. */
  touchedJobIds: readonly number[];
}

/**
 * resolveCompany (E0-API, features/companies/resolve.ts; 13 §5.3), replacing ingest's name-key upsert. In the
 * caller's transaction: a known board alias, then a known strong domain (the board added as an alias), then one shared
 * company of the name key with nothing contradicting (confidence 70; a "second board joined by name" review when it
 * has a board on the same platform), else a new company (a `homonym` review when several share the name key), queued
 * for enrichment. Two calls for one board at once make one company (the strong-alias unique index, ON CONFLICT).
 * Callers: DB-INGEST's store (every posting), X1-API (publishing a page job; the company check of a held job), S2 (a
 * candidate of an opted-out company is `forbidden`).
 */
export type ResolveCompany = (deps: AppDeps, t: DbTx, input: ResolveCompanyInput) => Promise<ResolveCompanyResult>;

/** What offering a board to discovery did. */
export const DISCOVERY_OFFER_OUTCOMES = ['added', 'bumped', 'known_source', 'forbidden', 'refused'] as const;
export type DiscoveryOfferOutcome = (typeof DISCOVERY_OFFER_OUTCOMES)[number];

export interface DiscoveryOfferInput {
  /** The board's source kind (`career_site` for a page's host). */
  kind: JobSourceKind;
  /** The board as its adapter's normaliser writes it (greenhouseToken, leverSite, ...; the host for career_site). */
  name: string;
  via: JobSourceDiscoveredVia;
  at: string;
}

export interface DiscoveryOfferResult {
  outcome: DiscoveryOfferOutcome;
  /** The job_source_candidates row added, bumped or marked forbidden; null for known_source and refused. */
  candidateId: number | null;
  /** The source that already reads the board (known_source). */
  sourceId: number | null;
}

/**
 * offerToDiscovery (X1-API in wave 3, then S2's; features/ingest/discovery/offer.ts; 12 §4.1, 14 §5.2 step 3, §5.3
 * step 2). In the caller's transaction: adds the board to job_source_candidates or bumps its seen_count and
 * last_seen_at (UNIQUE (kind, name)); never a user id. A board an enabled or disabled source already reads answers
 * `known_source`; a board whose company is opted out (do_not_fetch) is kept `forbidden`; a kind that is no board
 * (JOB_SOURCE_KIND_PLATFORM has none: pages, imports, feeds of many employers) or a name its normaliser rejects is
 * `refused`. Validation is S2's (wave 4, behind assertNewReadAllowed). Callers: X1-API (an approved new job's board, an
 * approved page job's host), S2's signals.
 */
export type OfferToDiscovery = (deps: AppDeps, t: DbTx, input: DiscoveryOfferInput) => Promise<DiscoveryOfferResult>;

/** A re-check's answer (JOB_REVIEW_CHECK_STATES without `none` and `queued`). */
export const RECHECK_STATES = ['gone', 'live', 'unreadable', 'not_possible'] as const;
export type RecheckState = (typeof RECHECK_STATES)[number];

export interface RecheckPostingInput {
  jobId: number;
  /** The link the reports named (X1-API mapped the reported address to it); omitted: the job's own readable link. */
  link?: JobLinkRef;
}

export interface RecheckPostingResult {
  state: RecheckState;
  /** When it was read or judged (ISO): job_reviews.checked_at. */
  checkedAt: string;
  /** The link read, when one was. */
  link: JobLinkRef | null;
  /** An enabled listing source lists the job: it was made due now (job_sources.next_run_at), so its listing settles it. */
  sourceMadeDue: boolean;
  /**
   * v37 INT-A (SP v37 PLAN W4): the read waits (try later): its host, or every Workday site (the Workday lane), is held
   * or paused, or its request sent nothing; read again after this time (ISO). The answer is then no answer about the
   * posting: the caller records nothing and moves no check time (`state` stays `unreadable` for older readers).
   */
  retryAt?: string;
}

/**
 * recheckPosting (S1-API, features/ingest/recheck.ts; 14 §5.1 step 3, §2.5). Outside any transaction: one per-posting
 * read through ingest/postings.ts, under the host's pace (crawl_hosts) and today's identity (the read today's liveness
 * check makes: no assertNewReadAllowed). A failed read answers `unreadable`; v37 INT-A: a held host or the Workday
 * lane's pause (Retry-After, the breaker, a bot check, an admin's hold), or a read that sent nothing, answers
 * `unreadable` with `retryAt` (try later: wait for it); a platform with no per-posting read (SmartRecruiters, Taleo, a page job, a career site while S5
 * is off; v37 INT-B: a BambooHR or iCIMS link whose source's terms an admin set to not allowed) `not_possible`, with no
 * request. v37 BOARDS: BambooHR openings and iCIMS postings are read (their detail JSON, their ?in_iframe=1 page), once
 * BOT_USER_AGENT is set and with it. `live` may refresh the posting as a liveness read does; `gone` closes
 * nothing (the caller closes through closeLink when the review is approved). The budget (EXT_RECHECKS_PER_DAY), one
 * check per review at a time and the 6-hour floor are the caller's. Caller: X1-API's re-check queue.
 */
export type RecheckPosting = (deps: AppDeps, input: RecheckPostingInput) => Promise<RecheckPostingResult>;

/** What the shared reader reads for (each behind its admin switch, owner question 8). */
export const SITE_READ_PURPOSES = [
  'company_site',
  'career_page',
  // v31 LINK (D3): an added job's own page, read once for its schema.org JobPosting (ADD_JOB_PAGE_READ, and the
  // identity guard's `add_page` kind).
  'add_page',
] as const;
export type SiteReadPurpose = (typeof SITE_READ_PURPOSES)[number];

/** Why the shared reader read nothing (nothing was sent for the first four). */
export const SITE_READ_REFUSALS = [
  /** SITE_READER_COMPANY_SITES / SITE_READER_CAREER_PAGES is off (both are, by default); v31 LINK: ADD_JOB_PAGE_READ. */
  'switch_off',
  /** BOT_USER_AGENT is a placeholder (assertNewReadAllowed). */
  'identity_placeholder',
  /** The domain is on crawl_opt_outs (or its company's do_not_fetch). */
  'opted_out',
  /** robots.txt disallows it, or answered 5xx, 429 or nothing (everything disallowed for this pass). */
  'robots',
  /** The host is on hold (crawl_hosts.hold_until), or not https, or no public address at connect time. */
  'held',
  /** 401, 403, 429, a bot check, a CAPTCHA or a login form: the host is held (blocked). */
  'blocked',
  /** Larger than SITE_READER_MAX_BYTES, slower than SITE_READER_TIMEOUT_MS, not the type asked for, or another failure. */
  'failed',
] as const;
export type SiteReadRefusal = (typeof SITE_READ_REFUSALS)[number];

export interface SiteReadRequest {
  url: string;
  purpose: SiteReadPurpose;
  /** HTML (the default) or an image (a logo). v30 S5: or XML (a career site's sitemap: XML, text or gzip). */
  accept?: 'html' | 'image' | 'xml';
  /** The last read's validators, for a conditional GET. */
  etag?: string | null;
  lastModified?: string | null;
}

export type SiteReadResult =
  | {
      ok: true;
      status: number;
      /** After at most 3 redirects, on the same registrable domain. */
      finalUrl: string;
      contentType: string;
      /** Empty on a 304. */
      body: Buffer;
      notModified: boolean;
      etag: string | null;
      lastModified: string | null;
    }
  | {
      ok: false;
      refusal: SiteReadRefusal;
      status?: number;
      retryAt?: string;
      /** v37 INT-A: why a `held` host is held (crawl_hosts.hold_reason, or `backoff`), so a 429's hold reads as one. */
      holdReason?: 'retry_after' | 'breaker' | 'bot_check' | 'admin' | 'backoff';
    };

/**
 * siteReader, the shared polite reader (E2 in wave 4, core/http/reader/index.ts; 13 §4, 12 §3.4, 11 §5.3a). Outside
 * any transaction. In order: its purpose's switch, assertNewReadAllowed (`site_reader`), crawl_opt_outs, the host's
 * hold, robots.txt for TailorIT (site_robots, 24 hours), the host's pace (crawl_hosts, SITE_READER_HOST_GAP_SECONDS),
 * https only, a public address checked at connect time (undici), at most 3 redirects on the same registrable domain,
 * SITE_READER_MAX_BYTES and SITE_READER_TIMEOUT_MS; a refusal holds the host and is never retried with another
 * identity. Callers: E2 (company homepages, logos), S5 (career pages).
 */
export interface SiteReader {
  read(deps: AppDeps, request: SiteReadRequest): Promise<SiteReadResult>;
}

/** Why a review is superseded: its source listed the job (14 §5.2 step 5), or a purge closed it (14 §11). */
export const JOB_REVIEW_SUPERSEDE_REASONS = ['listed', 'purged'] as const;
export type JobReviewSupersedeReason = (typeof JOB_REVIEW_SUPERSEDE_REASONS)[number];

/**
 * jobReviews (X1-API, features/job-reviews/seam.ts; 14 §5): what the other packages tell the extension's reviews. Both
 * run in the caller's transaction.
 */
export interface JobReviewsSeam {
  /**
   * The jobs' pending reviews close as `superseded` (decided_by `source`, decided_at = at; "Listed by its source" or
   * the purge in their history). Answers how many closed. Callers: DB-INGEST's store (a run lists a held job: it
   * clears held_since and projects the job itself), S1-API's purge.
   */
  supersede(deps: AppDeps, t: DbTx, input: { jobIds: readonly number[]; reason: JobReviewSupersedeReason; at: string }): Promise<number>;
  /**
   * A source's listing or own read reopened a job that an approved closed review had closed (14 §5.1 step 6): the
   * review's history says "Reopened by its source", and it counts against its reporters' trust
   * (EXT_REPORTER_REJECTS_TO_IGNORE). Nothing when no approved closed review names the job. Caller: DB-INGEST's store.
   */
  reopenedBySource(deps: AppDeps, t: DbTx, input: { jobId: number; at: string }): Promise<void>;
}

export { SeamNotBuiltError } from './seam-stub';
export { closeLink } from '../features/ingest/close';
export { purgeSource } from '../features/ingest/purge';
export { recheckPosting } from '../features/ingest/recheck';
export { offerToDiscovery } from '../features/ingest/discovery/offer';
export { resolveCompany } from '../features/companies/resolve';
export { jobReviews } from '../features/job-reviews/seam';
export { siteReader } from './http/reader/index';
/** PG-SEARCH's projection (built): call it in the transaction of every change that moves a job's search row. */
export { projectJob, projectJobs } from '../features/jobs/search-projection/index';
/** The identity guard of every new kind of outside read (built: core/http/identity.ts). */
export { assertNewReadAllowed, newReadsAllowed, NewReadRefusedError, NEW_READ_KINDS, type NewReadKind } from './http/identity';
