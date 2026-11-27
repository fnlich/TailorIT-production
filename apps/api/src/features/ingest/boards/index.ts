import { BOARD_DESCRIPTORS, registerBoardForTest, type BoardDescriptor, type BoardSourceKind } from '@tailorit/shared/sourcing';
import type { NewReadKind } from '../../../core/http/identity';
import type { DefinedAdapter } from '../adapters/define';
import { ADP } from './adp'; // v38 ATS-B
import { ASHBY } from './ashby';
import { AVATURE } from './avature'; // v38 ATS-C
import { BAMBOOHR } from './bamboohr';
import { BREEZY } from './breezy';
import { CAREER_SITE } from './career-site';
import { DAYFORCE } from './dayforce'; // v38 ATS-B
import { GEM } from './gem'; // v38 ATS-A
import { GREENHOUSE } from './greenhouse';
import { ICIMS } from './icims';
import { JOBDIVA } from './jobdiva'; // v38 ATS-D
import { JOBVITE } from './jobvite'; // v38 ATS-C
import { JOIN } from './join'; // v38 ATS-B
import { LEVER } from './lever';
import { ORACLE } from './oracle'; // v38 ATS-B
import { PAYCOM } from './paycom'; // v38 ATS-C
import { PAYLOCITY } from './paylocity'; // v38 ATS-C
import { PERSONIO } from './personio';
import { PHENOM } from './phenom'; // v38 ATS-D
import { PINPOINT } from './pinpoint'; // v38 ATS-A
import { RECRUITEE } from './recruitee';
import { RECRUITERFLOW } from './recruiterflow'; // v38 ATS-B
import { RIPPLING } from './rippling'; // v38 ATS-A
import { SMARTRECRUITERS } from './smartrecruiters'; // v38 ATS-C
import { SUCCESSFACTORS } from './successfactors'; // v38 ATS-D
import { TALEO } from './taleo'; // v38 ATS-C
import { TEAMTAILOR } from './teamtailor'; // v38 ATS-A
import type { ApiBoardDescriptor, KindTerms } from './types';
import { UKG } from './ukg'; // v38 ATS-D
import { WORKABLE } from './workable';
import { WORKDAY } from './workday';
import { WORKDAY_SITE } from './workday-site';
import { ZOHO_RECRUIT } from './zoho-recruit'; // v38 ATS-B

// v38 FRAME (SP v38 PLAN A1): the board registry's API part. One line per board kind, in the shared registry's order
// (@tailorit/shared/sourcing BOARD_DESCRIPTORS: this file throws at load when the two differ). The ingest feature's
// central lists derive from it (sources.ts KIND_TERMS, NO_ROBOTS_KINDS and hostOf; scheduler.ts NEW_READ_KIND_OF;
// adapters/index.ts ADAPTERS; postings.ts fetchPosting; liveness.ts READABLE_KINDS and postingRefOf; discovery's board
// kinds; import-sources.ts IMPORT_BOARD_KINDS; source-transfer.ts TRANSFER_CONFIG_KEYS; router.ts Add source). A new
// platform adds its file (./<kind>.ts) and its line here, after its shared part's. See docs/DEVELOPMENT.md "How to add a
// board kind".

export const API_BOARDS = [
  GREENHOUSE,
  LEVER,
  ASHBY,
  WORKABLE,
  WORKDAY,
  WORKDAY_SITE,
  PERSONIO,
  RECRUITEE,
  BREEZY,
  BAMBOOHR,
  ICIMS,
  CAREER_SITE,
  // v38 <ID>: a wave-2 platform's line goes here.
  GEM, // v38 ATS-A
  PINPOINT, // v38 ATS-A
  RIPPLING, // v38 ATS-A
  TEAMTAILOR, // v38 ATS-A
  ORACLE, // v38 ATS-B
  ADP, // v38 ATS-B
  ZOHO_RECRUIT, // v38 ATS-B
  JOIN, // v38 ATS-B
  RECRUITERFLOW, // v38 ATS-B
  DAYFORCE, // v38 ATS-B
  SMARTRECRUITERS, // v38 ATS-C
  JOBVITE, // v38 ATS-C
  TALEO, // v38 ATS-C
  AVATURE, // v38 ATS-C
  PAYLOCITY, // v38 ATS-C
  PAYCOM, // v38 ATS-C
  UKG, // v38 ATS-D
  SUCCESSFACTORS, // v38 ATS-D
  PHENOM, // v38 ATS-D
  JOBDIVA, // v38 ATS-D
] as const satisfies readonly ApiBoardDescriptor[];

/** Every board kind's API part, as the base type. */
const BOARDS: readonly ApiBoardDescriptor[] = API_BOARDS;

/** The registry's problems (empty when it is sound): its two parts in step, each adapter its kind's. */
export function boardRegistryProblems(boards: readonly ApiBoardDescriptor[] = BOARDS): string[] {
  const problems: string[] = [];
  const shared = (BOARD_DESCRIPTORS as readonly BoardDescriptor[]).map((board) => board.kind);
  const api = boards.map((board) => board.board.kind);
  if (shared.join(',') !== api.join(',')) problems.push(`the API registry (${api.join(', ')}) is not the shared one (${shared.join(', ')})`);
  for (const board of boards) {
    if (board.adapter.kind !== board.board.kind) problems.push(`${board.board.kind}'s adapter is ${board.adapter.kind}'s`);
    if (board.terms?.note && board.terms.note.length > 1000) problems.push(`${board.board.kind}'s terms note is over 1,000 characters`);
    if (board.posting?.refOfLink && !board.posting.read) problems.push(`${board.board.kind} reads links but has no readPosting`);
    // v38 INT (v3.7 TRANSFER: a kind never run stays out of a sources file): a links-only kind carries no transfer keys.
    if (board.transferKeys && !board.board.row.runs) problems.push(`${board.board.kind} never runs but a sources file would carry it (transferKeys)`);
    if (board.posting?.refOfLink && !board.board.atsKind && !board.board.parseLink) {
      problems.push(`${board.board.kind} reads links but no link reader names its postings (atsKind or parseLink)`);
    }
  }
  return problems;
}

{
  const problems = boardRegistryProblems();
  if (problems.length > 0) throw new Error(`The board registry is not sound: ${problems.join('; ')}.`);
}

const BY_KIND: ReadonlyMap<string, ApiBoardDescriptor> = new Map(BOARDS.map((board) => [board.board.kind, board]));

/** API parts a test registered (registerApiBoardForTest, with its shared part's registerBoardForTest). */
const TEST_BOARDS = new Map<string, ApiBoardDescriptor>();

/**
 * Registers one more board's API part until the answer is called, its shared part too. For tests only (a test-only
 * platform proves a link's read, its verdicts and its company facts end to end): the lists derived at load never hold
 * it; apiBoardOf and the shared lookups do. Its kind needs its job_source_kinds row in the test's database.
 */
export function registerApiBoardForTest(board: ApiBoardDescriptor): () => void {
  if (BY_KIND.has(board.board.kind) || TEST_BOARDS.has(board.board.kind)) throw new Error(`The board ${board.board.kind} is registered already.`);
  const unregisterShared = registerBoardForTest(board.board);
  TEST_BOARDS.set(board.board.kind, board);
  return () => {
    TEST_BOARDS.delete(board.board.kind);
    unregisterShared();
  };
}

/** A board kind's API part, or null for any other kind. */
export function apiBoardOf(kind: string): ApiBoardDescriptor | null {
  return BY_KIND.get(kind) ?? TEST_BOARDS.get(kind) ?? null;
}

/** The board a name or an address names, by its kind's rules (the API's where it has its own), normalised; '' for none. */
export function boardOfInput(board: ApiBoardDescriptor, input: string): string {
  return (board.boardOf ?? board.board.boardOf)(input);
}

/** A board's source config, by its kind's rules. */
export function boardSourceConfig(board: ApiBoardDescriptor, name: string): Record<string, unknown> {
  return (board.configOfBoard ?? board.board.configOfBoard)(name);
}

/** The host a source of a board kind reads, by its kind's rules. */
export function boardSourceHost(board: ApiBoardDescriptor, config: Record<string, unknown>): string | null {
  return (board.hostOf ?? board.board.hostOf)(config);
}

/** Each board kind's adapter (adapters/index.ts ADAPTERS). */
export const BOARD_ADAPTERS = Object.fromEntries(BOARDS.map((board) => [board.board.kind, board.adapter])) as Readonly<
  Record<BoardSourceKind, DefinedAdapter>
>;

/** The terms each board kind's new source records (sources.ts KIND_TERMS); a kind with none starts unchecked. */
export const BOARD_KIND_TERMS: Readonly<Partial<Record<string, KindTerms>>> = Object.fromEntries(
  BOARDS.filter((board) => board.terms).map((board) => [board.board.kind, board.terms!]),
);

/** Each board kind's new kind of outside read (scheduler.ts NEW_READ_KIND_OF). */
export const BOARD_NEW_READ_KIND_OF: Readonly<Partial<Record<string, NewReadKind>>> = Object.fromEntries(
  BOARDS.filter((board) => board.readKind).map((board) => [board.board.kind, board.readKind!]),
);

/** The board kinds that read no outside host of their own (sources.ts NO_ROBOTS_KINDS). */
export const BOARD_NO_ROBOTS_KINDS: readonly BoardSourceKind[] = BOARDS.filter((board) => board.noRobots).map((board) => board.board.kind as BoardSourceKind);

/** The settings a sources file carries of each board kind (source-transfer.ts TRANSFER_CONFIG_KEYS). */
export const BOARD_TRANSFER_KEYS: Readonly<Partial<Record<string, readonly string[]>>> = Object.fromEntries(
  BOARDS.filter((board) => board.transferKeys).map((board) => [board.board.kind, board.transferKeys!]),
);

/** The board kinds an admin import's link finds (import-sources.ts IMPORT_BOARD_KINDS), in the registry's order. */
export const BOARD_IMPORT_KINDS: readonly BoardSourceKind[] = BOARDS.filter((board) => board.importable).map((board) => board.board.kind as BoardSourceKind);

/** The board kinds whose stored links TailorIT reads one posting at a time (liveness.ts READABLE_KINDS). */
export const BOARD_READABLE_KINDS: readonly BoardSourceKind[] = BOARDS.filter((board) => board.posting?.refOf).map(
  (board) => board.board.kind as BoardSourceKind,
);

/** The board kinds discovery validates (a candidate becomes a source): every kind whose sources run. */
export const BOARD_VALIDATED_KINDS: readonly BoardSourceKind[] = BOARDS.filter((board) => board.board.row.runs).map(
  (board) => board.board.kind as BoardSourceKind,
);

export type { ApiBoardDescriptor, KindTerms } from './types';
