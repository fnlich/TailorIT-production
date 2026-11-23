import { JobCreditSchema } from '../jobs/dto';

// v30 CT: the kinds of job source (docs/design/part2/11-database.md §5.2, 12 §12.1, 14 §9). Migration 0904 makes
// job_source_kinds a table of these rows (its CHECK becomes a reference, so a later kind is an INSERT) and 0908 adds
// `ext_page`; this list names every row, so the admin API may answer any source. A kind's precedence, attribution and
// raw retention live in its row; the words and the board alias's platform live here.

/** A kind's name (the table's check). */
export const JOB_SOURCE_KIND_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** Every kind of job source, in 0904's order, then 0908's. */
export const JOB_SOURCE_KINDS = [
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
] as const;
export type JobSourceKind = (typeof JOB_SOURCE_KINDS)[number];

/** Each kind's label, as its row names it. */
export const JOB_SOURCE_KIND_LABEL: Record<JobSourceKind, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  workday: 'Workday (one posting)',
  workday_site: 'Workday career site',
  personio: 'Personio',
  recruitee: 'Recruitee',
  breezy: 'Breezy HR',
  bamboohr: 'BambooHR',
  career_site: 'Career site',
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
/** The kinds Admin › Sources lists (and filters by): every kind but an import's (sourcing.test.ts checks the list). */
export const ADMIN_SOURCE_LIST_KINDS = [
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
] as const satisfies readonly Exclude<JobSourceKind, (typeof JOB_SOURCE_IMPORT_KINDS)[number]>[];
export type AdminSourceListKind = (typeof ADMIN_SOURCE_LIST_KINDS)[number];
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
 * the lake, pages) give none.
 */
export const JOB_SOURCE_KIND_PLATFORM: Partial<Record<JobSourceKind, string>> = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  ashby: 'ashby',
  workable: 'workable',
  workday: 'workday',
  workday_site: 'workday',
  personio: 'personio',
  recruitee: 'recruitee',
  breezy: 'breezy',
  bamboohr: 'bamboohr',
  career_site: 'site',
};

/** A kind's credit line on its jobs' cards (job_source_kinds.attribution; 12 §3.6-3.7): the job card's credit. */
export const JobSourceAttributionSchema = JobCreditSchema;
