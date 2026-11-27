import { JobCreditSchema } from '../jobs/dto';
import { BOARD_DESCRIPTORS, BOARD_SOURCE_KINDS, type BoardSourceKind } from './boards/index'; // v38 FRAME

// v30 CT: the kinds of job source (docs/design/part2/11-database.md §5.2, 12 §12.1, 14 §9). Migration 0904 makes
// job_source_kinds a table of these rows (its CHECK becomes a reference, so a later kind is an INSERT) and 0908 adds
// `ext_page`; this list names every row, so the admin API may answer any source. A kind's precedence, attribution and
// raw retention live in its row; the words and the board alias's platform live here.
//
// v38 FRAME (SP v38 PLAN A1): a board kind's words and platform are its descriptor's (./boards: the registry); the lists
// below keep v3.7's kinds in their pinned order (the migrations' rows, the MCP tool's source filter, Admin's lists) and
// take every later board kind after them, in the registry's order: a new platform's descriptor is all it needs here.

/** A kind's name (the table's check). */
export const JOB_SOURCE_KIND_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** The board kinds after v3.7's (a v3.8 platform's), in the registry's order. */
function laterBoardKinds<T extends string>(known: readonly T[]): BoardSourceKind[] {
  return BOARD_SOURCE_KINDS.filter((kind) => !(known as readonly string[]).includes(kind));
}

/** v3.7's kinds of job source, in 0904's order, then 0908's, then (v37 BOARDS) 0063's: never reordered. */
const V37_JOB_SOURCE_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'workday',
  'workday_site',
  'personio',
  'recruitee',
  'breezy',
  'bamboohr',
  'career_site',
  'usajobs',
  'jobtech',
  'nav',
  'tyomarkkinatori',
  'himalayas',
  'jobicy',
  'vendor_feed',
  'page',
  'csv',
  'json',
  'ft_lake',
  'seed',
  'ext_page',
  // v37 BOARDS (SP v37 PLAN I1): an employer's iCIMS site, <board>.icims.com, read by its sitemap (migration 0063's row).
  'icims',
] as const;
export type JobSourceKind = (typeof V37_JOB_SOURCE_KINDS)[number] | BoardSourceKind;

/**
 * v38 FRAME: the board kinds v3.7 did not have (each v3.8 platform's), in the registry's order: the lists whose v3.7
 * members stay hand-written (their order or their SQL pinned) take these after them.
 */
export const LATER_BOARD_SOURCE_KINDS: readonly BoardSourceKind[] = laterBoardKinds(V37_JOB_SOURCE_KINDS);

/** Every kind of job source: v3.7's (V37_JOB_SOURCE_KINDS), then each later board kind (v38 FRAME). */
export const JOB_SOURCE_KINDS: readonly [JobSourceKind, ...JobSourceKind[]] = [...V37_JOB_SOURCE_KINDS, ...LATER_BOARD_SOURCE_KINDS];

/** The kinds that are no board (feeds of many employers, imports, pages, the lake, the demo jobs): their words. */
const OTHER_KIND_LABEL: Record<Exclude<JobSourceKind, BoardSourceKind>, string> = {
  usajobs: 'USAJOBS',
  jobtech: 'JobTech (Arbetsförmedlingen)',
  nav: 'NAV',
  tyomarkkinatori: 'Työmarkkinatori',
  himalayas: 'Himalayas',
  jobicy: 'Jobicy',
  vendor_feed: 'Licensed feed',
  page: 'A page a person saved',
  csv: 'CSV import',
  json: 'JSON import',
  ft_lake: 'free_tailor lake',
  seed: 'Demo seed',
  ext_page: 'A page job an admin published',
};

/** A board kind's descriptor by its kind. */
const BOARD_BY_KIND: ReadonlyMap<string, (typeof BOARD_DESCRIPTORS)[number]> = new Map(BOARD_DESCRIPTORS.map((board) => [board.kind, board]));

/** Each kind's label, as its row names it (a board kind's: its descriptor's), in JOB_SOURCE_KINDS' order. */
export const JOB_SOURCE_KIND_LABEL: Readonly<Record<JobSourceKind, string>> = Object.fromEntries(
  JOB_SOURCE_KINDS.map((kind) => [kind, BOARD_BY_KIND.get(kind)?.label ?? OTHER_KIND_LABEL[kind as Exclude<JobSourceKind, BoardSourceKind>]]),
) as Record<JobSourceKind, string>;

/**
 * The kinds v3.0 does not build (SP\p2\DECISIONS.md P1): the Nordic feeds (question 9: US users) and a licensed feed
 * (question 19). Their rows exist (0904 is written word for word); no source of theirs is made or run.
 */
export const JOB_SOURCE_KINDS_NOT_BUILT = ['jobtech', 'nav', 'tyomarkkinatori', 'vendor_feed'] as const satisfies readonly JobSourceKind[];

// v35 ADMIN (PLAN H6): an import is not a source. Its records (the `csv` and `json` rows behind every admin import:
// files, Google Sheets, pasted links) stay in job_sources for its runs, but Admin › Sources never lists, counts or acts
// on them, and its Kind filter offers neither; Admin › Import's Recent imports and Admin › Runs show them.
/** The kinds of an import's records. */
export const JOB_SOURCE_IMPORT_KINDS = ['csv', 'json'] as const satisfies readonly JobSourceKind[];
/** v3.7's kinds Admin › Sources lists, in their order (v38 FRAME: every later board kind follows them). */
const V37_ADMIN_SOURCE_LIST_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'workday',
  'workday_site',
  'personio',
  'recruitee',
  'breezy',
  'bamboohr',
  'career_site',
  'usajobs',
  'jobtech',
  'nav',
  'tyomarkkinatori',
  'himalayas',
  'jobicy',
  'vendor_feed',
  'page',
  'ft_lake',
  'seed',
  'ext_page',
  'icims', // v37 BOARDS
] as const satisfies readonly Exclude<JobSourceKind, (typeof JOB_SOURCE_IMPORT_KINDS)[number]>[];
export type AdminSourceListKind = (typeof V37_ADMIN_SOURCE_LIST_KINDS)[number] | BoardSourceKind;
/** The kinds Admin › Sources lists (and filters by): every kind but an import's (sourcing.test.ts checks the list). */
export const ADMIN_SOURCE_LIST_KINDS: readonly [AdminSourceListKind, ...AdminSourceListKind[]] = [
  ...V37_ADMIN_SOURCE_LIST_KINDS,
  ...laterBoardKinds(V37_ADMIN_SOURCE_LIST_KINDS),
];
// end v35 ADMIN

/** How a kind reads its postings (the table's check). */
export const JOB_SOURCE_ACCESS = [
  'public_api',
  'licensed_api',
  'sitemap',
  'structured_data',
  'user_added',
  'admin_import',
  'internal',
] as const;
export type JobSourceAccess = (typeof JOB_SOURCE_ACCESS)[number];

/**
 * The platforms key a board kind's sources take in their board alias, '<platform>:<board>' (companies/aliases): every
 * Workday kind is 'workday', a career site is 'site' ('site:<host>'). Kinds of many employers (the feeds, the imports,
 * the lake, pages) give none. v38 FRAME: each board kind's descriptor's `platform` (iCIMS: 'icims:<board>', careers-acme).
 */
export const JOB_SOURCE_KIND_PLATFORM: Readonly<Partial<Record<JobSourceKind, string>>> = Object.fromEntries(
  BOARD_DESCRIPTORS.map((board) => [board.kind, board.platform]),
);

/** A kind's credit line on its jobs' cards (job_source_kinds.attribution; 12 §3.6-3.7): the job card's credit. */
export const JobSourceAttributionSchema = JobCreditSchema;
