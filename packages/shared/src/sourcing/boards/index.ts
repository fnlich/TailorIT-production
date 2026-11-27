import { ADP_BOARD } from './adp'; // v38 ATS-B
import { ASHBY_BOARD } from './ashby';
import { AVATURE_BOARD } from './avature'; // v38 ATS-C
import { BAMBOOHR_BOARD } from './bamboohr';
import { BREEZY_BOARD } from './breezy';
import { CAREER_SITE_BOARD } from './career-site';
import { DAYFORCE_BOARD } from './dayforce'; // v38 ATS-B
import { GEM_BOARD } from './gem'; // v38 ATS-A
import { GREENHOUSE_BOARD } from './greenhouse';
import { ICIMS_BOARD } from './icims';
import { JOBDIVA_BOARD } from './jobdiva'; // v38 ATS-D
import { JOBVITE_BOARD } from './jobvite'; // v38 ATS-C
import { JOIN_BOARD } from './join'; // v38 ATS-B
import { LEVER_BOARD } from './lever';
import { ORACLE_BOARD } from './oracle'; // v38 ATS-B
import { PAYCOM_BOARD } from './paycom'; // v38 ATS-C
import { PAYLOCITY_BOARD } from './paylocity'; // v38 ATS-C
import { PERSONIO_BOARD } from './personio';
import { PHENOM_BOARD } from './phenom'; // v38 ATS-D
import { PINPOINT_BOARD } from './pinpoint'; // v38 ATS-A
import { RECRUITEE_BOARD } from './recruitee';
import { RECRUITERFLOW_BOARD } from './recruiterflow'; // v38 ATS-B
import { RIPPLING_BOARD } from './rippling'; // v38 ATS-A
import { SMARTRECRUITERS_BOARD } from './smartrecruiters'; // v38 ATS-C
import { SUCCESSFACTORS_BOARD } from './successfactors'; // v38 ATS-D
import { TALEO_BOARD } from './taleo'; // v38 ATS-C
import { TEAMTAILOR_BOARD } from './teamtailor'; // v38 ATS-A
import type { BoardDescriptor, BoardLane, BoardUrl } from './types';
import { UKG_BOARD } from './ukg'; // v38 ATS-D
import { boardHostOf, boardSegmentsOf, boardUrlOf } from './url';
import { WORKABLE_BOARD } from './workable';
import { WORKDAY_BOARD } from './workday';
import { WORKDAY_SITE_BOARD } from './workday-site';
import { ZOHO_RECRUIT_BOARD } from './zoho-recruit'; // v38 ATS-B

// v38 FRAME (SP v38 PLAN A1): the board registry's shared part. One line per board kind, in this order (the order every
// list derived from it keeps: Admin's kind filters and Add source, the API's lists). A new platform adds its file and
// its line here (and its API part's line: apps/api/src/features/ingest/boards/index.ts). See docs/DEVELOPMENT.md "How to
// add a board kind".

export const BOARD_DESCRIPTORS = [
  GREENHOUSE_BOARD,
  LEVER_BOARD,
  ASHBY_BOARD,
  WORKABLE_BOARD,
  WORKDAY_BOARD,
  WORKDAY_SITE_BOARD,
  PERSONIO_BOARD,
  RECRUITEE_BOARD,
  BREEZY_BOARD,
  BAMBOOHR_BOARD,
  ICIMS_BOARD,
  CAREER_SITE_BOARD,
  // v38 <ID>: a wave-2 platform's line goes here.
  GEM_BOARD, // v38 ATS-A
  PINPOINT_BOARD, // v38 ATS-A
  RIPPLING_BOARD, // v38 ATS-A
  TEAMTAILOR_BOARD, // v38 ATS-A
  ORACLE_BOARD, // v38 ATS-B
  ADP_BOARD, // v38 ATS-B
  ZOHO_RECRUIT_BOARD, // v38 ATS-B
  JOIN_BOARD, // v38 ATS-B
  RECRUITERFLOW_BOARD, // v38 ATS-B
  DAYFORCE_BOARD, // v38 ATS-B
  SMARTRECRUITERS_BOARD, // v38 ATS-C
  JOBVITE_BOARD, // v38 ATS-C
  TALEO_BOARD, // v38 ATS-C
  AVATURE_BOARD, // v38 ATS-C
  PAYLOCITY_BOARD, // v38 ATS-C
  PAYCOM_BOARD, // v38 ATS-C
  UKG_BOARD, // v38 ATS-D
  SUCCESSFACTORS_BOARD, // v38 ATS-D
  PHENOM_BOARD, // v38 ATS-D
  JOBDIVA_BOARD, // v38 ATS-D
] as const;

/** A board kind (a source kind with a descriptor). */
export type BoardSourceKind = (typeof BOARD_DESCRIPTORS)[number]['kind'];

/** Every board kind, in the registry's order. */
export const BOARD_SOURCE_KINDS: readonly BoardSourceKind[] = BOARD_DESCRIPTORS.map((board) => board.kind);

const BY_KIND: ReadonlyMap<string, BoardDescriptor> = new Map(BOARD_DESCRIPTORS.map((board) => [board.kind, board as BoardDescriptor]));

/**
 * Boards a test registered (registerBoardForTest): a test-only platform proves the plumbing a new platform plugs into (the
 * link reader, the clean link, the board an address names). Product boards are BOARD_DESCRIPTORS' lines, only.
 */
const TEST_BOARDS: BoardDescriptor[] = [];

/** Every board the lookups read: the registry's, then a test's. */
const lookupBoards = (): readonly BoardDescriptor[] =>
  TEST_BOARDS.length === 0 ? (BOARD_DESCRIPTORS as readonly BoardDescriptor[]) : [...(BOARD_DESCRIPTORS as readonly BoardDescriptor[]), ...TEST_BOARDS];

/**
 * Registers one more board until the answer is called. For tests only (as ingest/hosts.ts registerLaneForTest): the lists
 * derived at load (the kinds, labels, lanes) never hold it; the lookups below do.
 */
export function registerBoardForTest(board: BoardDescriptor): () => void {
  if (BY_KIND.has(board.kind) || TEST_BOARDS.some((known) => known.kind === board.kind)) throw new Error(`The board ${board.kind} is registered already.`);
  TEST_BOARDS.push(board);
  return () => {
    const at = TEST_BOARDS.indexOf(board);
    if (at >= 0) TEST_BOARDS.splice(at, 1);
  };
}

/** The descriptor of a board kind, or null for any other kind (a feed, an import, a page...). */
export function boardDescriptorOf(kind: string): BoardDescriptor | null {
  return BY_KIND.get(kind) ?? TEST_BOARDS.find((board) => board.kind === kind) ?? null;
}

/** Whether a kind is a board kind. */
export const isBoardSourceKind = (kind: string): kind is BoardSourceKind => BY_KIND.has(kind);

const HOST_PATTERNS = new Map<string, RegExp>();
/** A host pattern, compiled once. */
export function boardHostPattern(pattern: string): RegExp {
  let compiled = HOST_PATTERNS.get(pattern);
  if (!compiled) {
    compiled = new RegExp(pattern);
    HOST_PATTERNS.set(pattern, compiled);
  }
  return compiled;
}

/**
 * The board kind whose hosts a host is (lower case, a trailing dot allowed), the first in the registry's order: the link
 * reader's (`parseLink`), the clean link's and discovery's career-site check's. Null for a host no platform claims.
 */
export function boardDescriptorOfHost(host: string): BoardDescriptor | null {
  const name = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!name) return null;
  for (const board of lookupBoards()) {
    if (board.hosts !== null && boardHostPattern(board.hosts).test(name)) return board;
  }
  return null;
}

/**
 * A board's name as candidates and sources keep it (discovery's candidateName for a board kind): normalised by its kind,
 * at most 300 characters, lower case unless its kind keeps the case; null for none.
 */
export function boardNameFor(board: BoardDescriptor, raw: string): string | null {
  const normalized = board.boardOf(raw);
  if (!normalized || normalized.length > 300) return null;
  return board.keepsCase ? normalized : normalized.toLowerCase();
}

/** The board an address names (a posting's or a board's page on a board kind's host), as kept; null for none. */
export function boardOfAddress(address: string): { kind: BoardSourceKind; name: string } | null {
  const url = boardUrlOf(address);
  if (!url) return null;
  const parts = boardSegmentsOf(url);
  for (const board of lookupBoards()) {
    const raw = board.boardOfUrl?.(url, parts);
    if (!raw) continue;
    const name = boardNameFor(board, raw);
    return name ? { kind: board.kind as BoardSourceKind, name } : null;
  }
  return null;
}

// v38 FIX-APP (REVIEW38-ux L3, L13, L12)
/**
 * The platforms TailorIT recognises but never reads (the API's descriptors' `posting.unreadable`: SAP SuccessFactors'
 * robots.txt, Phenom's and JobDiva's bot checks): a job of theirs is its adder's for good (no Retry read), and no source
 * of theirs is ever listed. The API's conformance test (v38-fixapp-names) pins this list against its descriptors.
 */
export const NEVER_READ_BOARD_KINDS: readonly BoardSourceKind[] = ['successfactors', 'phenom', 'jobdiva'];

/** Whether a link is on a platform TailorIT never reads (NEVER_READ_BOARD_KINDS); false for anything else. */
export function isNeverReadLink(address: string | null | undefined): boolean {
  const url = address ? boardUrlOf(address) : null;
  const kind = url ? boardDescriptorOfHost(boardHostOf(url))?.kind : undefined;
  return kind !== undefined && (NEVER_READ_BOARD_KINDS as readonly string[]).includes(kind);
}

/** The longest source name (job_sources.name, Add source's). */
const SOURCE_NAME_MAX = 100;

/**
 * A new source's name (Add source's default, a link read's, discovery's, an import's): the board, as before; for a kind
 * whose board is an id (`sourceName`: ADP, Paycom) its company when one is known, else the kind's words.
 */
export function sourceNameOf(kind: string, board: string, companyName?: string | null): string {
  const named = boardDescriptorOf(kind)?.sourceName;
  if (!named) return board;
  const company = typeof companyName === 'string' ? companyName.replace(/\s+/g, ' ').trim().slice(0, SOURCE_NAME_MAX).trim() : '';
  return company || named(board).slice(0, SOURCE_NAME_MAX);
}
// end v38 FIX-APP

/** The board kinds with a clean link of their own (none: every link keeps the generic canonical form). */
const CLEANING_BOARDS = (BOARD_DESCRIPTORS as readonly BoardDescriptor[]).filter((board) => board.cleanLink && board.hosts);

/**
 * The clean form of a canonical link (SP v38 PLAN A2): its platform's cleanLink, or the link as it is. jobs/canonical.ts
 * canonicalJobUrl and identity.ts linkKey read it, so a platform's clean link is what jobs store and dedupe on.
 */
export function cleanBoardLink(canonical: string): string {
  if (CLEANING_BOARDS.length === 0 && TEST_BOARDS.length === 0) return canonical;
  const url = boardUrlOf(canonical);
  if (!url) return canonical;
  const board = boardDescriptorOfHost(boardHostOf(url));
  return board?.cleanLink?.(url) ?? canonical;
}

/** Whether the board kind of this host cleans its links (a cheap test before the clean link is worked out). */
export function hostHasCleanLinks(host: string): boolean {
  if (CLEANING_BOARDS.length === 0 && TEST_BOARDS.length === 0) return false;
  return Boolean(boardDescriptorOfHost(host)?.cleanLink);
}

/** A lane as the registry gives it: its hosts and the kinds that declare it. */
export interface RegisteredBoardLane extends BoardLane {
  readonly hosts: string;
  readonly kinds: readonly BoardSourceKind[];
}

/** Every platform lane, once per key, in the registry's order (the first kind to declare it gives its words). */
export const BOARD_LANES: readonly RegisteredBoardLane[] = (() => {
  const lanes = new Map<string, { lane: BoardLane; hosts: string; kinds: BoardSourceKind[] }>();
  for (const board of BOARD_DESCRIPTORS as readonly BoardDescriptor[]) {
    if (!board.lane) continue;
    const known = lanes.get(board.lane.key);
    if (known) known.kinds.push(board.kind as BoardSourceKind);
    else lanes.set(board.lane.key, { lane: board.lane, hosts: board.lane.hosts ?? board.hosts!, kinds: [board.kind as BoardSourceKind] });
  }
  return [...lanes.values()].map(({ lane, hosts, kinds }) => Object.freeze({ ...lane, hosts, kinds: Object.freeze(kinds) }));
})();

/** The registrable domains of every board kind's hosts (a page there is no career site). */
export const BOARD_DOMAINS: readonly string[] = [...new Set((BOARD_DESCRIPTORS as readonly BoardDescriptor[]).flatMap((board) => board.domains))];

export type { BoardUrl };
export * from './types';
export { BOARD_CONFIG_COMMON, defineBoard, isPortableHostPattern } from './define';
export { boardHostOf, boardSegmentsOf, boardUrlOf, configWords, hostOfTyped, tenantLabelOf, tenantLabelOfHost } from './url';
export { feedCompanyOf } from './feeds';
export { ASHBY_BOARD, ashbyBoard } from './ashby';
export { BAMBOOHR_BOARD, BAMBOOHR_OWN_LABELS, bamboohrCompany, bamboohrCompanyOfTyped } from './bamboohr';
export { BREEZY_BOARD, breezyCompany, breezyCompanyOfTyped } from './breezy'; // v38 ATS-A: breezyCompanyOfTyped
export { CAREER_SITE_BOARD } from './career-site';
export { GEM_API_HOST, GEM_BOARD, GEM_JOBS_HOST, gemBoard, gemPostLink } from './gem'; // v38 ATS-A
export { GREENHOUSE_BOARD, greenhouseToken } from './greenhouse';
export { ICIMS_BOARD, ICIMS_BOARD_HOST, ICIMS_SERVICE_HOST, icimsBoardOf, icimsBoardOfTyped, icimsHostOf, isIcimsBoardHost } from './icims';
export { LEVER_BOARD, leverRegionOf, leverSite } from './lever';
export { PERSONIO_BOARD, personioBoardName, personioCompany } from './personio';
export { PINPOINT_BOARD, pinpointCompany, pinpointCompanyOfTyped } from './pinpoint'; // v38 ATS-A
export { RECRUITEE_BOARD, recruiteeCompany, recruiteeCompanyOfTyped, recruiteeOfferOf } from './recruitee'; // v38 ATS-A: the last two
export { RIPPLING_API_HOST, RIPPLING_ATS_HOST, RIPPLING_BOARD, ripplingBoard, ripplingPostingLink } from './rippling'; // v38 ATS-A
export { TEAMTAILOR_BOARD, teamtailorCompany, teamtailorCompanyOfTyped } from './teamtailor'; // v38 ATS-A
export { WORKABLE_BOARD, workableAccount } from './workable';
export { isWorkdayHost, WORKDAY_BOARD, WORKDAY_HOSTS, WORKDAY_LANE, workdayTenant } from './workday';
export { WORKDAY_SITE_BOARD, workdaySiteConfig, workdaySiteName, workdaySiteOfAddress } from './workday-site';
// v38 ATS-B: Oracle Recruiting Cloud, ADP Workforce Now, Zoho Recruit, Join.com, Recruiterflow, Dayforce.
export { ADP_BOARD, ADP_DEFAULT_CC_ID, ADP_GUEST_PAGE, ADP_HOST, ADP_JOB_ID, adpBoardName, adpBoardOf, adpCenterOf, adpCenterOfConfig, adpPostingOf, adpPostingUrl, type AdpCenter } from './adp';
export { DAYFORCE_BOARD, DAYFORCE_HOST, DAYFORCE_POSTING_ID, dayforcePostingOf, dayforcePostingUrl, type DayforcePosting } from './dayforce';
export { JOIN_BOARD, JOIN_HOST, joinCompanyOf, joinJobOf, joinJobUrl } from './join';
export { isOracleHost, ORACLE_BOARD, ORACLE_HOSTS, ORACLE_POSTING_ID, oracleBoardOf, oraclePostingOf, oraclePostingUrl, oracleSiteOf, oracleSiteOfConfig, type OracleSite } from './oracle';
export { RECRUITERFLOW_BOARD, RECRUITERFLOW_HOST, RECRUITERFLOW_JOB_ID, recruiterflowCompanyOf, recruiterflowJobOf, recruiterflowJobUrl } from './recruiterflow';
export { isZohoRecruitHost, ZOHO_JOB_ID, ZOHO_RECRUIT_BOARD, ZOHO_RECRUIT_HOSTS, ZOHO_RECRUIT_PORTAL, zohoRecruitHostOf, zohoRecruitJobOf, zohoRecruitJobUrl } from './zoho-recruit';
// v38 ATS-C
export { SMARTRECRUITERS_BOARD, SMARTRECRUITERS_HOST, smartRecruitersCompany, smartRecruitersLinkOf, type SmartRecruitersLink } from './smartrecruiters';
export { JOBVITE_BOARD, JOBVITE_HOST, jobviteCompany, jobviteLinkOf } from './jobvite';
export { TALEO_BOARD, TALEO_HOSTS, taleoLinkOf, taleoTenant } from './taleo';
export { AVATURE_BOARD, AVATURE_HOSTS, avatureHostOf, avatureLinkOf, avatureSite } from './avature';
export { PAYLOCITY_BOARD, PAYLOCITY_HOST, paylocityBoard, paylocityBoardUrl, paylocityDetailsUrl, paylocityLinkOf } from './paylocity';
export { PAYCOM_BOARD, PAYCOM_HOST, paycomClientKey, paycomJobUrl, paycomLinkOf } from './paycom';
// v38 ATS-D
export { UKG_BOARD, ukgPostingOf, ukgPostingUrl, ukgTenant } from './ukg';
export { SUCCESSFACTORS_BOARD, successFactorsCompany, successFactorsPostingOf } from './successfactors';
export { PHENOM_BOARD, phenomPostingOf, phenomTenant } from './phenom';
export { JOBDIVA_BOARD, jobDivaPortalKey, jobDivaPostingOf } from './jobdiva';
