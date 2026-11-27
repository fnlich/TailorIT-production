import type { BoardDescriptor, BoardSourceKind } from '@tailorit/shared/sourcing';
import type { ParsedAtsUrl, WorkdayPostingRef } from '@tailorit/shared/autofill';
import type { JobVerifyReason } from '@tailorit/shared';
import type { NewReadKind } from '../../../core/http/identity';
import type { DefinedAdapter } from '../adapters/define';
import type { HttpAnswer, IngestHttp } from '../http';
import type { RawPosting, SourceRecord } from '../types';

// v38 FRAME (SP v38 PLAN A1): the API part of a board-kind descriptor (its shared part: @tailorit/shared/sourcing
// boards). Each board kind's file (./<kind>.ts) names its listing (a defineAdapter adapter: what a run reads), its reads
// of one posting (A3: the re-checks', every link's), its terms, its new kind of read, the settings a sources file carries,
// and whether an import finds it; ./index.ts is the registry every central list of the ingest feature derives from.
//
// Load order: a descriptor imports its adapter and the leaf modules it reads with (http, robots, sitemap, normalize, its
// adapter's helpers), never ingest/sources.ts, postings.ts, discovery/boards.ts or the registry itself (those read the
// registry: test/v38-board-registry.test.ts walks the imports and fails a descriptor that reaches them).

/** The terms recorded on a new source of a kind (sources.ts KIND_TERMS; job_sources.terms_*). */
export interface KindTerms {
  status: 'allowed' | 'allowed_with_conditions';
  url: string | null;
  /** The dated note of the decision (at most 1,000 characters: job_sources.terms_note's CHECK). */
  note?: string;
}

/**
 * A posting on a board TailorIT can ask about one posting at a time (postings.ts fetchPosting; v37 BOARDS: a BambooHR
 * opening's detail, an iCIMS posting's page; v38: every platform's readPosting).
 */
export interface PostingRef {
  kind: BoardSourceKind;
  /**
   * The board as its kind's reads name it: the Greenhouse board token, the Lever site, the Ashby job board's name, the
   * Workable account, the Workday tenant (in lower case), the BambooHR company, the iCIMS board...
   */
  board: string;
  externalId: string;
  /**
   * Lever's EU sites live on their own host; TailorIT reads Greenhouse's global boards only; the other platforms have no
   * regions.
   */
  region: 'global' | 'eu';
  /** A Workday posting's host, site, location and name (its read needs them; its board is the tenant). */
  workday?: WorkdayPostingRef;
  /** v37 BOARDS: the posting's own page when its read needs it (an iCIMS posting's: its board is the host's label). */
  page?: string;
}

/**
 * v38 FRAME (SP v38 PLAN A6): what a platform says about the company a posting is of. The name names the job's company
 * (a source's companyName comes first, then this, then the board's slug made readable); the about text, the logo's
 * address and the website feed the company's record through its `ats_board` source row, only where the record has none
 * of a better source's (companies/profile.ts: an admin's, the company's own site's, an AI summary's rank above; a logo is
 * never hot-linked: companies/site/step.ts copies it).
 */
export interface CompanyFacts {
  name: string | null;
  /** The platform's text about the company (HTML or plain): kept as plain text, at most COMPANY_SUMMARY_MAX. */
  about?: string | null;
  /** The company's logo on the platform (https only). */
  logoUrl?: string | null;
  /** The company's own website (https only). */
  website?: string | null;
}

/**
 * A posting read: found, or not (`unlisted`: the board's listing names it but hides it from its public list, as an
 * Ashby posting reached by its own link can be; a run skips those). `listedCompany`: the company name the board's
 * own list gave, read because the source names none (Workable's account name): Add job keeps it on a source it makes.
 * v38 FRAME (A6): `company`, what the platform said about the posting's company (fetchPosting applies it).
 */
export type PostingAnswer =
  // v38 ATS-C: `board`, the board the posting's own page names, for a link that names none (Paylocity's): its source.
  | { found: true; raw: RawPosting; listedCompany?: string; company?: CompanyFacts; board?: string }
  // v38 FIX-C (SP v38 FIXES-38 D2): `confirmTwice`, a gone sign that closes a stored job only when seen twice a day apart
  // (Paycom's empty portal page: boards/sightings.ts); a new link's read closes at once.
  | { found: false; unlisted?: true; confirmTwice?: true };

/**
 * v38 FRAME (SP v38 PLAN A3): what a descriptor's readPosting answers: a PostingAnswer (found; or gone: closed), or the
 * platform's own word that the posting can't be read now or at all (`unreadable`: a JobVerifyReason; `unavailable` and
 * `blocked` are try later, any other can't read), which fetchPosting throws as a PostingUnreadableError.
 */
export type PostingReadAnswer = PostingAnswer | { found: false; unreadable: JobVerifyReason };

/**
 * Ashby boards' listings read, by board name in lower case, for callers that ask about several postings of one board:
 * the daily check keeps each for the whole check (each board read once); Add job shares a read while it is under way
 * (`shareWhileReading`), so two adds from one board at once read it once, and a later add reads it afresh.
 */
export type AshbyBoardReads = Map<string, Promise<HttpAnswer>>;

/** Workable accounts' names (readWorkableAccountName), by account, read once for every posting of a daily check. */
export type WorkableNames = Map<string, Promise<string | null>>;

/** How one posting is read (postings.ts fetchPosting's options). */
export interface PostingReadOptions {
  /** The config of the source the posting is stored under (its companyName). */
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Ashby listings shared between calls (see AshbyBoardReads). */
  boards?: AshbyBoardReads;
  /** Share a listing only while it is being read (Add job), not for good (the daily check). */
  shareWhileReading?: boolean;
  /** Workable accounts' names shared between calls (the daily check: each account's list read once). */
  names?: WorkableNames;
  /** v37 BOARDS: the time an iCIMS posting's validThrough is judged at (default: the clock's now). */
  now?: () => Date;
  /**
   * v38 FRAME (SP v38 PLAN A3): whole board feeds already read (a run's, or the process's for links' reads: ./feed-cache.ts),
   * for a feed-based platform's readPosting (readFeed).
   */
  feeds?: { read(key: string, load: () => Promise<unknown>): Promise<unknown> };
}

/** A stored link to read again: its source (kind and config) and posting id, and its job's own link (liveness.ts). */
export interface LinkToRead {
  source: SourceRecord;
  sourceJobId: string;
  jobUrl: string;
}

/** What the API's link reader read from a link (./links.ts readBoardLink, SP v38 PLAN A2). */
export interface BoardLinkRead {
  /** The board kind whose posting the link names. */
  kind: BoardSourceKind;
  /** Its board as the link names it (null when it names none: a Paylocity link), and the posting's id. */
  board: string | null;
  externalId: string;
  /** The posting's own addresses, the clean link first. */
  canonical: string[];
  /** The link as read. */
  url: string;
  /** parseAtsUrl's reading, when it knows the platform (the extension's identity). */
  ats: ParsedAtsUrl | null;
}

/** A board kind's reads of one posting (SP v38 PLAN A3). */
export interface BoardPostingReads {
  /**
   * The posting a stored link of a source of this kind names (the re-checks, recheck.ts; liveness.ts postingRefOf), from
   * the source's config, the link's id and its job's own link; null when it names none.
   */
  refOf?(link: LinkToRead): PostingRef | null;
  /**
   * The posting a link to it names, from the API's link reader (jobs/add/board-link.ts: Add job, Add by link, the
   * extension, MCP, imports, the link queue, Retry read): every link of such a kind is read through `read` and kept
   * under its board's source. Absent for the five the extension's contract adds (autofill/jobs.ts reads those).
   */
  refOfLink?(read: BoardLinkRead): PostingRef | null;
  /** readPosting: one posting's read (a run's own reader), or the platform's verdict signal. */
  read?(http: IngestHttp, ref: PostingRef, options: PostingReadOptions): Promise<PostingReadAnswer>;
  /** The posting's API address (an Ashby posting's: its board's listing). */
  apiUrl?(ref: PostingRef): string;
  /**
   * The board's company name, for a platform whose posting names none (BambooHR: its careers page), read once a link's
   * posting was read, best effort; the board's source keeps it (board-link.ts).
   */
  companyName?(http: IngestHttp, board: string, signal: AbortSignal): Promise<string | null>;
  /**
   * v38 ATS-D (SP v38 PLAN "Final coverage"): a platform TailorIT never reads, and why (`robots`: its robots.txt disallows
   * every page; `bot_check`: a bot check guards every page; `needs_login`: its job site needs the employer's own login).
   * Every link of it is answered can't read with this reason at once (an admin's rejection of the link still comes
   * first), with no request and no source made (jobs/add/board-link.ts); its `read` answers the same for any other caller.
   */
  unreadable?: Exclude<JobVerifyReason, 'unavailable' | 'blocked'>;
}

/** The API part of one board kind (see the top). */
export interface ApiBoardDescriptor<K extends BoardSourceKind = BoardSourceKind> {
  /** Its shared part. */
  readonly board: BoardDescriptor<K>;
  /** Its listing: what a run (and discovery's validation, and Add source's Test) reads; made with defineAdapter. */
  readonly adapter: DefinedAdapter;
  /**
   * Its new kind of outside read (core/http/identity.ts; scheduler.ts NEW_READ_KIND_OF): it runs and is read only once
   * BOT_USER_AGENT names TailorIT's bot, and with it (the ingest service's botHttp). Absent: v2.0's reads.
   */
  readonly readKind?: NewReadKind;
  /** The terms a new source records (sources.ts KIND_TERMS); absent: unchecked, never run until an admin records them. */
  readonly terms?: KindTerms;
  /** It reads no outside host: robots.txt does not apply (sources.ts NO_ROBOTS_KINDS). */
  readonly noRobots?: boolean;
  /** The settings a sources file carries (source-transfer.ts TRANSFER_CONFIG_KEYS); absent: never exported. */
  readonly transferKeys?: readonly string[];
  /** An admin import's link finds its board (import-sources.ts IMPORT_BOARD_KINDS: made a source, off). */
  readonly importable?: boolean;
  /**
   * The config an import gives its board's source, where it is more than its config key (./configs.ts
   * importBoardConfig: Lever's region, a Workday career site's host, tenant and site); throws IngestError for none.
   */
  readonly importConfig?: (given: Record<string, unknown>, name: string) => Record<string, unknown>;
  /** The board a name or an address names, by the API's rules, where the shared part's cannot (a career site's host). */
  readonly boardOf?: (input: string) => string;
  /** A board's source config, by the API's rules, where the shared part's cannot. */
  readonly configOfBoard?: (board: string) => Record<string, unknown>;
  /** The host a source's reads go to, by the API's rules, where the shared part's cannot. */
  readonly hostOf?: (config: Record<string, unknown>) => string | null;
  /** Its reads of one posting. */
  readonly posting?: BoardPostingReads;
}
