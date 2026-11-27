import type { z } from 'zod';
import type { AtsKind } from '../../autofill/lookup';
import type { JobSourceAccess } from '../kinds';

// v38 FRAME (SP v38 PLAN A1): one board-kind descriptor per platform, the shared part. A board kind is a source kind that
// reads ONE employer's job board on a platform (Greenhouse's board, a BambooHR company, an iCIMS site...). Its shared
// part says what the web and every layer of the API read alike, as pure data and pure functions (browser-safe, no API
// import): the kind, its words, its job_source_kinds row, its platform key, the hosts it lives on (a pattern that reads
// the same in JavaScript and PostgreSQL), the config key that names its board (one key migration 0028's index reads),
// its config's zod schema, the board a typed name or an address names, the board a link names, the posting a link names
// (`parseLink`), the clean form of its links (`cleanLink`), its lane (one request at a time to the whole platform), Add
// source's field and the few words Admin › Sources says about a source. Its API part (apps/api/src/features/ingest/
// boards/<kind>.ts) adds the reads (the listing, one posting's read), the terms and the flags.
//
// Every central list derives from the registry (./index.ts BOARD_DESCRIPTORS): see docs/DEVELOPMENT.md "How to add a
// board kind". Hand-written stay: the migrations' rows (job_source_kinds, platforms, tailorit_url_platform), the
// constants, the v3.7 kinds' pinned order (kinds.ts), the fence test and @tailorit/shared/autofill's parseAtsUrl.

/**
 * The config keys a board's source may name its board by: exactly the keys migration 0028's idx_job_sources_board reads
 * (discovery/offer.ts SOURCE_BOARD_SQL), so "does a source read this board already?" stays an index lookup. A new kind
 * takes one of these; a key of its own would need a new index (a migration), never a scan.
 */
export const BOARD_CONFIG_KEYS = ['token', 'site', 'board', 'account', 'careerSite', 'company', 'tenant', 'host'] as const;
export type BoardConfigKey = (typeof BOARD_CONFIG_KEYS)[number];

/** A parsed address, as the WHATWG URL gives it (this package's lib types declare no URL: ./url.ts). */
export interface BoardUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: Iterable<[string, string]> & { get(name: string): string | null };
}

/** The posting a link names (parseLink): its board (null when the link names none), its id and its own addresses. */
export interface BoardLinkParts {
  board: string | null;
  externalId: string;
  /** The posting's own addresses, the clean link first (cleanLink's form). */
  canonical: string[];
}

/** One example link of the platform (made-up companies), for the conformance test. */
export interface BoardExample {
  /** A link as people paste it (its tracking marks, an apply step...). */
  link: string;
  /** Its clean form: canonicalJobUrl(link), with cleanLink's rules (REQUEST.md's "Clean job link"). */
  clean: string;
  /** The board and the posting id the link names (as the API's link reader reads them), or null when it names none. */
  board: string | null;
  externalId: string | null;
  /** The board discovery reads from the link (boardOfUrl, normalised), or null when the link names none. */
  found?: string | null;
}

/**
 * A platform lane (v37 FIX-LANE, ingest/hosts.ts): one crawl_hosts row every one of its hosts takes its turns on, so a
 * platform that answers all its employers from one limit is asked one request at a time. The kinds that declare the
 * same key share it (Workday's two kinds). Its least gap and its discovery cap are the API's (ingest/hosts.ts
 * LANE_CONSTANTS: a lane's own constants when it has some, else LANE_DEFAULT_MIN_INTERVAL_MS and
 * LANE_DEFAULT_DISCOVERY_PER_HOUR; SP v38 PLAN A4). Never a constant's name here: the web's bundle holds no server-only
 * constant (constants.bundle.test.ts).
 */
export interface BoardLane {
  /** Its crawl_hosts row (it passes HostIdSchema): `<platform>.lane`. */
  readonly key: string;
  /** The lane in words as a row (Admin › Hosts, the lane's HostHeldError): "BambooHR (all companies)". */
  readonly label: string;
  /** The platform in a sentence (people's pause words, a run waiting for it, Admin › Hosts): "BambooHR". */
  readonly name: string;
  /** Its hosts when they are more than the descriptor's (Workday's tenants' myworkday.com); default: `hosts`. */
  readonly hosts?: string;
}

/**
 * Admin › Sources › Add source's one field for a board kind added by its name or any address of it (the generic form:
 * BambooHR's company, iCIMS's site and every v3.8 platform). The API reads the board from what was typed (the
 * descriptor's boardOf) and says so under the field when it names none.
 */
export interface BoardAddSource {
  /** The config key the form sends what was typed in (its board key, or `url` for a page of the board). */
  readonly field: string;
  readonly label: string;
  /** Under the field: what to type. */
  readonly hint: string;
  readonly placeholder: string;
  /** The dialog's "?": what a source of the kind reads, and what keeps it off. */
  readonly help: string;
  /** Under the field while what was typed names no board (the web's check). */
  readonly invalid: string;
  /** The API's refusal of an empty field (zod's). */
  readonly required: string;
  /** The API's refusal of what names no board, and its field's words. */
  readonly refusal: string;
  readonly refusalField: string;
  /** The conflict's words "TailorIT has this {what} already" (default: "<label> site"). */
  readonly what?: string;
  readonly inputMode?: 'url' | 'text';
  /** Company name's tip (default: "Shown when the board doesn't name the company."). */
  readonly companyHint?: string;
  /**
   * v38 FIX-APP (SP v38 FIXES-38 D1): the platform names no employer anywhere (ADP), so Company name is required: the
   * words when it is empty (the web's, and the API's refusal). TailorIT never makes a name up from the board's id.
   */
  readonly companyRequired?: string;
  /**
   * v38 FIX-APP (REVIEW38-ux L18): a kind whose posting links name no board (Paylocity's job pages): a job's own link is
   * taken too, read once (its page names its board, as Add job reads it); the words say so under the field.
   */
  readonly postingLink?: string;
  /**
   * The web's check of what was typed: the board it names, or null (default: boardOf). The API checks again with
   * boardOf.
   */
  readonly boardOfInput?: (input: string) => string | null;
}

/** The job_source_kinds row the kind's migration writes (the conformance test compares them). */
export interface BoardKindRow {
  readonly access: JobSourceAccess;
  /** Whether its sources run (on the due queue): false for Workday's one-posting kind. */
  readonly runs: boolean;
  /** Which source's fields win when two describe one job (an ATS's own data: 4). */
  readonly precedence: number;
  readonly rawKeepDays: number;
}

/** The shared part of one board kind (see the top). */
export interface BoardDescriptor<K extends string = string> {
  /** job_source_kinds.kind. */
  readonly kind: K;
  /** job_source_kinds.label: the kind in Admin's words. */
  readonly label: string;
  /** The API's own words for it when they differ (types.ts SOURCE_KIND_LABEL: Workday's one-posting kind is "Workday"). */
  readonly runLabel?: string;
  readonly row: BoardKindRow;
  /** The platforms key of its board alias ('<platform>:<board>', companies/aliases): Workday's two kinds share one. */
  readonly platform: string;
  /**
   * Its hosts: a pattern over a URL's host name (lower case, no port, no trailing dot) that reads the same in JavaScript
   * and in PostgreSQL (non-capturing groups, `\.`, no quote, no lookbehind). Null for a kind of any host (a career site).
   */
  readonly hosts: string | null;
  /** The registrable domains of its hosts: a page there is no career site (discovery/boards.ts careerSiteOfUrl). */
  readonly domains: readonly string[];
  /**
   * The kind @tailorit/shared/autofill parseAtsUrl reads its links as (SP v38 PLAN A2: its board and posting id are the
   * extension's, one identity), when it knows the platform.
   */
  readonly atsKind?: AtsKind;
  /** The config key naming its board (see BOARD_CONFIG_KEYS). */
  readonly configKey: BoardConfigKey;
  /** Its board in words, in a sentence ("The import named no Lever site."); default "<label> board". */
  readonly boardWords?: string;
  /** The stored config's keys and values (a strict object: never `enabled`, which only an admin's switch writes). */
  readonly configSchema: z.ZodType<Record<string, unknown>>;
  /** Its board names keep their case (Ashby's boards, Workday's sites); else they are lower case. */
  readonly keepsCase?: boolean;
  /** The board a typed name or an address names, normalised; '' when it names none (discovery's normaliser). */
  readonly boardOf: (input: string) => string;
  /** A board's source config, from the board as candidates keep it (a validated candidate's, an import's). */
  readonly configOfBoard: (board: string) => Record<string, unknown>;
  /** The board a source's config names, before its normaliser (default: the config's `configKey`). */
  readonly boardOfConfig?: (config: Record<string, unknown>) => string | null;
  /** The host a source's reads go to (job_sources.host: crawl_hosts' and site_robots' key), or null. */
  readonly hostOf: (config: Record<string, unknown>) => string | null;
  /**
   * The board an address on its hosts names (a posting's or the board's own page), before its normaliser; null for
   * none. `parts` are the path's segments, decoded.
   */
  readonly boardOfUrl?: (url: BoardUrl, parts: readonly string[]) => string | null;
  /**
   * The posting a link names, for a platform parseAtsUrl does not know (or a link form it does not read). The API's
   * link reader is parseAtsUrl(url) ?? descriptorOfHost(host)?.parseLink(url) (SP v38 PLAN A2).
   */
  readonly parseLink?: (url: BoardUrl) => BoardLinkParts | null;
  /**
   * The platform's clean link (SP v38 PLAN A2, REQUEST.md's "Clean job link"), from the link's canonical form
   * (canonicalJobUrl's generic rules applied): the address to keep instead, or null to keep it as it is. Idempotent, and
   * never drops the posting's id (the conformance test checks both on every example).
   */
  readonly cleanLink?: (url: BoardUrl) => string | null;
  /** Its lane (SP v38 PLAN A4): every platform that answers all its employers from one limit has one. */
  readonly lane?: BoardLane;
  /**
   * A career site an admin turned on, on the board's own host, is the board's source (one source per host: migration
   * 0063 left iCIMS's as they were).
   */
  readonly adoptsCareerSites?: boolean;
  /** Add source's one field (absent: the kind is not added by hand, or has a form of its own). */
  readonly addSource?: BoardAddSource;
  /** What a source of the kind reads, in a few words (Admin › Sources); null when its config says nothing more. */
  readonly detail?: (config: Record<string, unknown>) => string | null;
  /**
   * v38 FIX-APP (REVIEW38-ux L12): a kind whose board is an id (ADP's client id, Paycom's client key): a new source is
   * named by its company when one is known, else by these words ("ADP career center 0b5e8a4c"); the id stays its board
   * key (sourceNameOf). Absent: a new source is named by its board, as before.
   */
  readonly sourceName?: (board: string) => string;
  /** Example links (made-up companies) for the conformance test. */
  readonly examples: readonly BoardExample[];
}
