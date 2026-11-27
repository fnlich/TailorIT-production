import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { IsoDate, IsoDateTime } from '../core/list';
import {
  adminBulkIds,
  adminBulkResultSchema,
  AdminCursorSchema,
  AdminPageSizeSchema,
  AdminQueryFlagSchema,
  adminQueryList,
} from '../reviews/bulk';
import { JOB_IMPORT_WAYS, JobImportCountsSchema } from '../ingest/rows'; // v35 INT-A
import { ADMIN_SOURCE_LIST_KINDS, JOB_SOURCE_KINDS } from './kinds';
import {
  CRAWL_HOST_HOLD_REASONS,
  JOB_SOURCE_CANDIDATE_STATUSES,
  JOB_SOURCE_DISCOVERED_VIA,
  JOB_SOURCE_FOUND_VIA,
  JOB_SOURCE_WAITING_REASONS,
  JOB_SOURCE_PURGE_REASONS,
  JOB_SOURCE_PURGE_STATES,
  JOB_SOURCE_ROBOTS_STATUSES,
  JOB_SOURCE_RUN_STATUSES,
  JOB_SOURCE_RUN_TRIGGERS,
  JOB_SOURCE_TERMS_STATUSES,
  JOB_SOURCE_TIERS,
  SITE_ROBOTS_STATUSES,
} from './states';

// v30 CT: the admin pages of job sourcing at scale (docs/design/part2/12-job-sourcing.md §9.8, SP\p2\PLAN.md S1-API
// and S1-WEB): Sources at 80,000 rows (filters, paging, bulk), the per-host page (hold, failures, robots file, content
// signals), run history, the candidate funnel, purges by source, and the daily report with its alarms. S1-API names the
// routes; these are their bodies and answers.

const Id = z.number().int().positive();
/** A host name as the reader keeps it: lower case, no scheme, port or path. */
const HostSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/);
const SearchText = z.string().trim().max(200, messageError('MSG_TEXT_TOO_LONG', { max: 200 }));

// Sources ------------------------------------------------------------------------------------------------------------

/** The orders of Admin › Sources. */
export const ADMIN_SOURCE_SORTS = ['next_run', 'last_run', 'name', 'open_jobs', 'failures'] as const;
export type AdminSourceSort = (typeof ADMIN_SOURCE_SORTS)[number];

// v36 SOURCES (PLAN S1, S7, S8) ------------------------------------------------------------------------------------
/**
 * Admin › Sources' on/off filter: every source, those on, those off, or those waiting for an admin (off, found by
 * discovery or an admin's import, and never turned on by an admin: AdminSourceRow `waitingForAdmin`).
 */
export const ADMIN_SOURCE_ENABLED_FILTERS = ['all', 'enabled', 'disabled', 'waiting'] as const;
export type AdminSourceEnabledFilter = (typeof ADMIN_SOURCE_ENABLED_FILTERS)[number];
/**
 * The parts of v3.6's one-time notice (migration 0060 turned off the sources discovery had switched on): all of them,
 * those untouched since found, or those changed since (maybe by an admin). v36 FIX-SRC (coordinator decision D6): or
 * those an admin added from Admin › Candidates › Add boards (discovered_via `admin`), which the other two parts leave out.
 */
export const ADMIN_SOURCE_TURNED_OFF_PARTS = ['all', 'untouched', 'changed', 'candidates'] as const;
export type AdminSourceTurnedOffPart = (typeof ADMIN_SOURCE_TURNED_OFF_PARTS)[number];
/**
 * GET /api/admin/sources/turned-off: the notice, while no admin dismissed it (null otherwise, and on a server 0060 turned
 * nothing off). Counts of the sources it names, and of those still off.
 */
export const AdminSourcesTurnedOffSchema = z.object({
  notice: z
    .object({
      /** When 0060 turned them off. */
      at: IsoDateTime,
      untouched: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative(),
      /** Of each part, how many are still off (an admin may have turned some on since). */
      untouchedOff: z.number().int().nonnegative(),
      changedOff: z.number().int().nonnegative(),
      /** v36 FIX-SRC (D6): the boards an admin added from Admin › Candidates (not counted in `untouched` or `changed`). */
      candidates: z.number().int().nonnegative(),
      candidatesOff: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type AdminSourcesTurnedOff = z.infer<typeof AdminSourcesTurnedOffSchema>;
// end v36 SOURCES

/**
 * Admin › Sources' filters (a query string, or the body of Enable all / Disable all): search (name or host) and lists
 * ([] is any). v35 ADMIN (PLAN H6): an import's records are no source (ADMIN_SOURCE_LIST_KINDS: no csv or json kind),
 * and "Found by import" is a way a source was found (`discoveredVia` import).
 */
export const AdminSourcesFilterSchema = z.object({
  q: SearchText.optional(),
  kind: adminQueryList(z.enum(ADMIN_SOURCE_LIST_KINDS), ADMIN_SOURCE_LIST_KINDS.length),
  tier: adminQueryList(z.enum(JOB_SOURCE_TIERS), JOB_SOURCE_TIERS.length),
  terms: adminQueryList(z.enum(JOB_SOURCE_TERMS_STATUSES), JOB_SOURCE_TERMS_STATUSES.length),
  robots: adminQueryList(z.enum(JOB_SOURCE_ROBOTS_STATUSES), JOB_SOURCE_ROBOTS_STATUSES.length),
  discoveredVia: adminQueryList(z.enum(JOB_SOURCE_FOUND_VIA), JOB_SOURCE_FOUND_VIA.length),
  /** v36 SOURCES (PLAN S8): `waiting`, found and never turned on by an admin (ADMIN_SOURCE_ENABLED_FILTERS). */
  enabled: z.enum(ADMIN_SOURCE_ENABLED_FILTERS).default('all'),
  /** Only sources failing now (a failure in their last run, or the failing tier). */
  failing: AdminQueryFlagSchema,
  host: HostSchema.optional(),
  companyId: z.coerce.number().int().positive().optional(),
  /** v36 SOURCES (PLAN S7): only the sources v3.6 turned off (the notice's), all of them or one part; absent: any. */
  turnedOff: z.enum(ADMIN_SOURCE_TURNED_OFF_PARTS).optional(),
});
export type AdminSourcesFilter = z.infer<typeof AdminSourcesFilterSchema>;

/** Admin › Sources' query string: its filters (AdminSourcesFilterSchema), order and page. */
export const AdminSourcesQuerySchema = AdminSourcesFilterSchema.extend({
  sort: z.enum(ADMIN_SOURCE_SORTS).default('next_run'),
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
});
export type AdminSourcesQuery = z.infer<typeof AdminSourcesQuerySchema>;

// v35 ADMIN (PLAN H7)
/**
 * Why a switched-on source does not run now (JOB_SOURCE_WAITING_LABEL words it), and until when, when that is known (a
 * held host). It starts by itself once it can.
 */
export const JobSourceWaitingSchema = z.object({
  reason: z.enum(JOB_SOURCE_WAITING_REASONS),
  until: IsoDateTime.nullable().optional(),
});
export type JobSourceWaiting = z.infer<typeof JobSourceWaitingSchema>;
// end v35 ADMIN

/** One row of Admin › Sources (job_sources with 12 §12.1's columns). */
export const AdminSourceRowSchema = z.object({
  id: z.number().int(),
  kind: z.enum(JOB_SOURCE_KINDS),
  kindLabel: z.string(),
  name: z.string(),
  host: z.string().nullable(),
  companyId: z.number().int().nullable(),
  companyName: z.string().nullable(),
  enabled: z.boolean(),
  tier: z.enum(JOB_SOURCE_TIERS),
  termsStatus: z.enum(JOB_SOURCE_TERMS_STATUSES),
  robotsStatus: z.enum(JOB_SOURCE_ROBOTS_STATUSES),
  /** How it was found (v35 ADMIN: `import`, "Found by import": made switched off by an admin's import). */
  discoveredVia: z.enum(JOB_SOURCE_FOUND_VIA).nullable(),
  nextRunAt: IsoDateTime.nullable(),
  lastRunAt: IsoDateTime.nullable(),
  lastSuccessAt: IsoDateTime.nullable(),
  /** The last complete listing (or 304): when its live links were verified. */
  lastCompleteAt: IsoDateTime.nullable(),
  lastStatus: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** Open jobs as of the last complete run. */
  openJobs: z.number().int().nonnegative(),
  /** False when its kind, its contract or its host's content signal forbids sending its postings to AI. */
  aiInput: z.boolean(),
  /** A worker holds its run now (lease_until in the future). */
  running: z.boolean(),
  // v31 RUNS: an admin paused the source (job_sources.paused_at): no run of it starts until Continue. Not the same as
  // `enabled` (off, or turned off after failures): Continue gives the source back its schedule.
  /** When an admin paused it; null or absent while it is not paused. */
  pausedAt: IsoDateTime.nullable().optional(),
  /** Who paused it (the admin's email; null once that account is gone). */
  pausedBy: z.string().nullable().optional(),
  // end v31 RUNS
  /** v35 ADMIN (PLAN H7): switched on, but it cannot run now, and why; null (or absent) when it is off or can run. */
  waiting: JobSourceWaitingSchema.nullable().optional(),
  // v36 SOURCES (PLAN S1, S8): who last turned it on and when (job_sources.enabled_at, enabled_by), and whether it waits
  // for an admin (off, found by discovery or an import, never turned on). Absent from a server before v3.6.
  /** When an admin last turned it on; null when no admin ever did. */
  enabledAt: IsoDateTime.nullable().optional(),
  /** That admin's email; null when it is not known (an account deleted since, or a source on before v3.6). */
  enabledBy: z.string().nullable().optional(),
  /** Off, found by discovery or an admin's import, and never turned on: "Waiting for an admin". */
  waitingForAdmin: z.boolean().optional(),
  // end v36 SOURCES
});
export type AdminSourceRow = z.infer<typeof AdminSourceRowSchema>;

/** Admin › Sources' page: the rows, every match counted, and the next page's cursor while more follow. */
export const AdminSourcesListSchema = z.object({
  items: z.array(AdminSourceRowSchema),
  total: z.number().int().nonnegative(),
  nextCursor: AdminCursorSchema.optional(),
});
export type AdminSourcesList = z.infer<typeof AdminSourcesListSchema>;

/** What a bulk action does to the chosen sources: enable, disable, or make them due now. */
export const ADMIN_SOURCE_BULK_ACTIONS = ['enable', 'disable', 'run_now'] as const;
export type AdminSourceBulkAction = (typeof ADMIN_SOURCE_BULK_ACTIONS)[number];
export const AdminSourcesBulkBodySchema = z.object({ action: z.enum(ADMIN_SOURCE_BULK_ACTIONS), ids: adminBulkIds(Id) });
export type AdminSourcesBulkBody = z.infer<typeof AdminSourcesBulkBodySchema>;
/** Each source's outcome: done, or skipped (already so, forbidden by its terms or robots, gone) with why. */
export const ADMIN_SOURCE_BULK_OUTCOMES = ['done', 'skipped', 'failed'] as const;
export const AdminSourcesBulkResultSchema = adminBulkResultSchema(ADMIN_SOURCE_BULK_OUTCOMES);
export type AdminSourcesBulkResult = z.infer<typeof AdminSourcesBulkResultSchema>;

// v35 ADMIN (PLAN H6): Enable all / Disable all for every source the filter matches, beside the selection's bulk. The
// count comes first (GET /api/admin/sources/all/count?<filter>: the confirm's "Enable 1,240 sources?"); the change runs
// on the server in batches of ADMIN_BULK_MAX (POST /api/admin/sources/all) and answers one result.
/** Turn every matching source on, or off. */
export const ADMIN_SOURCE_ALL_ACTIONS = ['enable', 'disable'] as const;
export type AdminSourceAllAction = (typeof ADMIN_SOURCE_ALL_ACTIONS)[number];
/** What the filter matches now: every source, and how many each action would change. */
export const AdminSourcesAllCountSchema = z.object({
  total: z.number().int().nonnegative(),
  /** Off now and able to run (not a kind that never runs, not of a company that opted out): Enable all turns these on. */
  canEnable: z.number().int().nonnegative(),
  /** On now: Disable all turns these off. */
  canDisable: z.number().int().nonnegative(),
});
export type AdminSourcesAllCount = z.infer<typeof AdminSourcesAllCountSchema>;
export const AdminSourcesAllBodySchema = z.object({
  action: z.enum(ADMIN_SOURCE_ALL_ACTIONS),
  /** The filter shown (Admin › Sources' own, its order and page left out); absent: every source. */
  filter: AdminSourcesFilterSchema.optional(),
});
export type AdminSourcesAllBody = z.infer<typeof AdminSourcesAllBodySchema>;
/** One result for the whole change: the sources it matched and each outcome's count (done, skipped, failed). */
export const AdminSourcesAllResultSchema = z.object({
  action: z.enum(ADMIN_SOURCE_ALL_ACTIONS),
  matched: z.number().int().nonnegative(),
  counts: z.partialRecord(z.enum(ADMIN_SOURCE_BULK_OUTCOMES), z.number().int().nonnegative()),
});
export type AdminSourcesAllResult = z.infer<typeof AdminSourcesAllResultSchema>;
// end v35 ADMIN

// v37 TRANSFER (PLAN T1, T2, T4) -----------------------------------------------------------------------------------
// Admin › Sources › Export writes the sources the filter shows into a sources file (GET /api/admin/sources/export?<filter>:
// tailorit-sources-YYYY-MM-DD.json); Admin › Sources › Import reads one (POST /api/admin/sources/import/preview, then
// POST /api/admin/sources/import: a multipart `file`, or JSON {fileName?, content}). The file names each source's kind,
// name, board settings (an allow-list per kind), company name, priority, close-missing and terms: never an id, on or off,
// runs, counts, an admin's email, a path on a server or an internal mark. Every source an import makes is off and waits
// for an admin (found via `file`); a source already there is left exactly as it is.

/** The sources file's `format` and `version`. */
export const SOURCES_FILE_FORMAT = 'tailorit-sources';
export const SOURCES_FILE_VERSION = 1;

/**
 * v37 FIX-37B (the beh review's F5): whether a text holds a character TailorIT can't store (PostgreSQL's text and jsonb
 * refuse U+0000 and a lone surrogate) or that has no place in it: a control character (U+0000-U+001F, U+007F). `breaks`
 * lets a note keep its tabs and line breaks.
 */
export function hasUnstorableText(text: string, breaks = false): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (breaks && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** v37 FIX-37B (F5): a sources file entry's words when a text in it can't be stored. */
export const SOURCES_FILE_UNSTORABLE = "It contains characters that can't be stored.";

/** A source's recorded terms in a sources file: as Admin › Sources' terms are written (PATCH /api/admin/sources/:id). */
export const SourcesFileTermsSchema = z.object({
  status: z.enum(JOB_SOURCE_TERMS_STATUSES),
  url: z
    .string()
    .trim()
    .max(2000, 'Its terms link must be under 2,000 characters.')
    .regex(/^https:\/\/\S+$/, 'Its terms link must be an https address.')
    .refine((text) => !hasUnstorableText(text), SOURCES_FILE_UNSTORABLE) // v37 FIX-37B (F5)
    .nullable()
    .optional(),
  note: z
    .string()
    .trim()
    .max(1000, 'Its terms note must be under 1,000 characters.')
    .refine((text) => !hasUnstorableText(text, true), SOURCES_FILE_UNSTORABLE) // v37 FIX-37B (F5): its line breaks kept
    .nullable()
    .optional(),
});
export type SourcesFileTerms = z.infer<typeof SourcesFileTermsSchema>;

/**
 * One source in a sources file, as an import reads it: the kind and config are checked per kind on the server (the board
 * settings Add source and discovery take); the rest here. Absent fields take Add source's defaults.
 */
export const SourcesFileEntrySchema = z.object({
  kind: z.string().trim().min(1, 'It names no kind of source.').max(40, 'It names no kind of source TailorIT knows.'),
  /** Absent or empty: the board's name, as Add source names a source. */
  name: z
    .string()
    .trim()
    .max(100, 'Its name must be under 100 characters.')
    .refine((text) => !hasUnstorableText(text), SOURCES_FILE_UNSTORABLE) // v37 FIX-37B (F5)
    .optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  companyName: z
    .string()
    .trim()
    .max(200, 'Its company name must be under 200 characters.')
    .refine((text) => !hasUnstorableText(text), SOURCES_FILE_UNSTORABLE) // v37 FIX-37B (F5)
    .nullable()
    .optional(),
  priority: z.number().int().min(-100).max(100).default(0),
  /** Close the jobs a complete run no longer lists (job_sources.deactivate_missing). */
  deactivateMissing: z.boolean().default(true),
  terms: SourcesFileTermsSchema.nullable().optional(),
});
export type SourcesFileEntry = z.infer<typeof SourcesFileEntrySchema>;

/** A sources file as Export writes it. Import reads `sources` entry by entry (a bad entry is one invalid row). */
export const SourcesFileSchema = z.object({
  format: z.literal(SOURCES_FILE_FORMAT),
  version: z.literal(SOURCES_FILE_VERSION),
  exportedAt: IsoDateTime,
  sources: z.array(
    z.object({
      kind: z.enum(JOB_SOURCE_KINDS),
      name: z.string(),
      config: z.record(z.string(), z.unknown()),
      companyName: z.string().nullable(),
      priority: z.number().int(),
      deactivateMissing: z.boolean(),
      terms: z.object({ status: z.enum(JOB_SOURCE_TERMS_STATUSES), url: z.string().nullable(), note: z.string().nullable() }),
    }),
  ),
});
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

/**
 * What an import does with one entry: `new` (made, off, waiting for an admin), `exists` (a source already reads that
 * board: left as it is), `renamed` (made under another name, " (2)", as another source holds the name), `invalid`
 * (skipped, with why).
 */
export const ADMIN_SOURCES_IMPORT_OUTCOMES = ['new', 'exists', 'renamed', 'invalid'] as const;
export type AdminSourcesImportOutcome = (typeof ADMIN_SOURCES_IMPORT_OUTCOMES)[number];

/** One entry of a sources file, as the preview and the import answer it (the same words both times). */
export const AdminSourcesImportEntrySchema = z.object({
  /** Its place in the file, from 1. */
  index: z.number().int().positive(),
  /** As the file names it (an unknown kind too). */
  kind: z.string(),
  kindLabel: z.string(),
  /** The name in the file (the board's name when the file gives none). */
  name: z.string(),
  outcome: z.enum(ADMIN_SOURCES_IMPORT_OUTCOMES),
  /** new, renamed: the name it gets; exists: the name of the source that reads the board; invalid: null. */
  sourceName: z.string().nullable(),
  /** exists: that source's id (null when an earlier entry of this file adds the board). */
  sourceId: z.number().int().nullable(),
  /** invalid: why; exists: what holds the board, when it is this file. */
  reason: z.string().nullable(),
  /**
   * v37 FIX-37B (SP v37 FIXES-37 E3): new, renamed: the terms the source gets: the file's, kept as written (`fromFile`),
   * else its kind's record (the owner's decided BambooHR and iCIMS terms among them). exists, invalid: null (a source
   * already there keeps its own).
   */
  terms: z.object({ status: z.enum(JOB_SOURCE_TERMS_STATUSES), fromFile: z.boolean() }).nullable().optional(),
});
export type AdminSourcesImportEntry = z.infer<typeof AdminSourcesImportEntrySchema>;

/** The preview of a sources file, or what its import did: the same answer, `imported` aside. */
export const AdminSourcesImportResultSchema = z.object({
  fileName: z.string(),
  total: z.number().int().nonnegative(),
  counts: z.object({
    new: z.number().int().nonnegative(),
    exists: z.number().int().nonnegative(),
    renamed: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
  entries: z.array(AdminSourcesImportEntrySchema),
  /** False for the preview; true once the import made its sources. */
  imported: z.boolean(),
});
export type AdminSourcesImportResult = z.infer<typeof AdminSourcesImportResultSchema>;

/** POST /api/admin/sources/import[/preview] as JSON (scripts, tests): the file's text and name. */
export const AdminSourcesImportJsonBodySchema = z.object({
  fileName: z.string().trim().min(1).max(200).default('sources.json'),
  content: z.string().min(1, 'The file is empty.'),
});
export type AdminSourcesImportJsonBody = z.infer<typeof AdminSourcesImportJsonBodySchema>;
// end v37 TRANSFER

// Runs ---------------------------------------------------------------------------------------------------------------

/** One run of a source (job_source_runs). */
export const JobSourceRunSchema = z.object({
  id: z.number().int(),
  sourceId: z.number().int(),
  sourceKind: z.enum(JOB_SOURCE_KINDS),
  sourceName: z.string(),
  trigger: z.enum(JOB_SOURCE_RUN_TRIGGERS),
  status: z.enum(JOB_SOURCE_RUN_STATUSES),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  httpStatus: z.number().int().nullable(),
  bytesFetched: z.number().int().nonnegative().nullable(),
  /** The HTTP requests the run made. */
  requests: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  deactivated: z.number().int().nonnegative(),
  reopened: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  /**
   * v30 INT-3 (S1-WEB's edit B): the source's kind in words as the API names it ("Google Sheet" for a sheet's CSV
   * source, else the kind's label). Absent: read JOB_SOURCE_KIND_LABEL.
   */
  sourceKindLabel: z.string().optional(),
  /**
   * v31 RUNS: when an admin asked this run to pause (job_source_runs.stop_requested_at): while it is still `running`,
   * it is stopping at its next safe point (within about RUN_STOP_POLL_MS). Null or absent: never asked.
   */
  stopRequestedAt: IsoDateTime.nullable().optional(),
  /**
   * v35 ADMIN (PLAN H6): an import's run (its source a `csv` or `json` record): how it came (a file, a Google Sheet, or
   * pasted links: one link or many), the file's name and the sheet's titles, for its label on Admin › Runs ("jobs.csv",
   * "Job sheet, tab Open roles", "24 pasted links"). Null or absent for a source's run.
   */
  importOf: z
    .object({
      way: z.enum(['file', 'sheet', 'pasted']),
      fileName: z.string().nullable(),
      sheet: z.object({ spreadsheetTitle: z.string(), tabTitle: z.string() }).nullable(),
      /**
       * v35 INT-A: the import of this run (IMPORT's job_imports; GET /api/admin/imports/:runId has its rows), for "Import
       * · <name> · <counts>": how it came (one link, pasted links, a file, a sheet), its name ("1 link", "24 pasted
       * links", the file, the tab), who started it (their name or address; null when unknown: a v3.4 route's import), its
       * rows, and its counts once every row is read (null while TailorIT reads them). Null or absent: no import record.
       */
      import: z
        .object({
          id: z.number().int(),
          way: z.enum(JOB_IMPORT_WAYS),
          name: z.string(),
          startedBy: z.string().nullable(),
          rows: z.number().int().nonnegative(),
          finishedAt: IsoDateTime.nullable(),
          counts: JobImportCountsSchema.nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
export type JobSourceRun = z.infer<typeof JobSourceRunSchema>;

/** The run history's query string. */
export const AdminRunsQuerySchema = z.object({
  sourceId: z.coerce.number().int().positive().optional(),
  kind: adminQueryList(z.enum(JOB_SOURCE_KINDS), JOB_SOURCE_KINDS.length),
  status: adminQueryList(z.enum(JOB_SOURCE_RUN_STATUSES), JOB_SOURCE_RUN_STATUSES.length),
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
});
export type AdminRunsQuery = z.infer<typeof AdminRunsQuerySchema>;

// v31 RUNS: Pause / Continue (docs/design/v3.1/22-runs-pause.md). Every run is paused (app_settings `ingest:paused`), or
// one run, or one source; Continue starts the paused work again from the top.
/** Every run is paused: since when, and by whom (the admin's email; null once that account is gone). */
export const RunsPausedSchema = z.object({ at: IsoDateTime, by: z.string().nullable() });
export type RunsPaused = z.infer<typeof RunsPausedSchema>;
/** POST /api/admin/runs/pause: every run paused; `stopping` runs were asked to stop at their next safe point. */
export const RunsPauseResultSchema = z.object({ paused: RunsPausedSchema, stopping: z.number().int().nonnegative() });
export type RunsPauseResult = z.infer<typeof RunsPauseResultSchema>;
/** POST /api/admin/runs/continue: runs go on; `resumed` sources whose last run was paused are due now. */
export const RunsContinueResultSchema = z.object({ paused: z.null(), resumed: z.number().int().nonnegative() });
export type RunsContinueResult = z.infer<typeof RunsContinueResultSchema>;
/** POST /api/admin/runs/:id/continue: the source's new run, started now. */
export const RunContinueResultSchema = z.object({ runId: z.number().int().positive(), sourceId: z.number().int().positive() });
export type RunContinueResult = z.infer<typeof RunContinueResultSchema>;
// end v31 RUNS

// v35 ADMIN (PLAN H6): an import run's Sources found (GET /api/admin/runs/:id/sources): each board source the import
// named (job_source_import_finds), made by it (`created`: switched off, Found by import) or there already, as it is now;
// Enable all / Disable all of the ones it made (POST /api/admin/runs/:id/sources); one at a time through
// PATCH /api/admin/sources/:id.
/** One source an import found. */
export const AdminRunSourceSchema = z.object({
  id: z.number().int(),
  kind: z.enum(JOB_SOURCE_KINDS),
  kindLabel: z.string(),
  name: z.string(),
  host: z.string().nullable(),
  companyName: z.string().nullable(),
  enabled: z.boolean(),
  /** This import made it (switched off, Found by import); false: a source that was there already, left as it was. */
  created: z.boolean(),
  discoveredVia: z.enum(JOB_SOURCE_FOUND_VIA).nullable(),
  openJobs: z.number().int().nonnegative(),
  lastRunAt: IsoDateTime.nullable(),
  pausedAt: IsoDateTime.nullable().optional(),
  waiting: JobSourceWaitingSchema.nullable().optional(),
  /** v36 INT-A: off, found (by this import or discovery) and never turned on by an admin: "Waiting for an admin". */
  waitingForAdmin: z.boolean().optional(),
  /** v381 EMBED (SP v381 PLAN E5): the company sites whose job pages show its board ("found via acme.com"). */
  embeddedSites: z.array(z.string()).optional(),
});
export type AdminRunSource = z.infer<typeof AdminRunSourceSchema>;
export const AdminRunSourcesSchema = z.object({
  items: z.array(AdminRunSourceSchema),
  /** Every source the run found, the ones it made, and how many of those are on now. */
  total: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  createdEnabled: z.number().int().nonnegative(),
});
export type AdminRunSources = z.infer<typeof AdminRunSourcesSchema>;
/** Enable all / Disable all of the sources an import made. */
export const AdminRunSourcesBodySchema = z.object({ action: z.enum(ADMIN_SOURCE_ALL_ACTIONS) });
export type AdminRunSourcesBody = z.infer<typeof AdminRunSourcesBodySchema>;
// end v35 ADMIN

// v381 EMBED (SP v381 PLAN E2, E5): the company sites whose job pages show a Greenhouse or Ashby source's board
// (embedded_boards): GET /api/admin/sources/:id/embedded-sites, the most recently confirmed first; an admin forgets one
// with POST /api/admin/sources/:id/embedded-sites/forget {site} (its next job link reads the page again).
export const EMBEDDED_BOARD_CONFIRMED_VIA = ['page', 'posting_url', 'admin'] as const;
export type EmbeddedBoardConfirmedVia = (typeof EMBEDDED_BOARD_CONFIRMED_VIA)[number];
/** One site whose job pages show the source's board. */
export const AdminEmbeddedSiteSchema = z.object({
  /** The site's registrable domain ("acme.com"). */
  site: z.string(),
  /** How TailorIT learned it: a job link's page named the board (`page`), or the board's posting links are there. */
  confirmedVia: z.enum(EMBEDDED_BOARD_CONFIRMED_VIA),
  /** The link that first confirmed it (its shared form), or null. */
  firstLink: z.string().nullable(),
  firstSeenAt: IsoDateTime,
  lastConfirmedAt: IsoDateTime,
  /**
   * v381 FIX (SP v381 FIXES-381 G6): when an admin forgot it (kept: neither its links nor the board's runs remember it
   * again until Remember again), or null.
   */
  forgottenAt: IsoDateTime.nullable().optional(),
});
export type AdminEmbeddedSite = z.infer<typeof AdminEmbeddedSiteSchema>;
export const AdminEmbeddedSitesSchema = z.object({ items: z.array(AdminEmbeddedSiteSchema) });
export type AdminEmbeddedSites = z.infer<typeof AdminEmbeddedSitesSchema>;
export const AdminEmbeddedSiteForgetBodySchema = z.object({ site: z.string().trim().min(1).max(253) });
export type AdminEmbeddedSiteForgetBody = z.infer<typeof AdminEmbeddedSiteForgetBodySchema>;
export const AdminEmbeddedSiteForgetResultSchema = z.object({ forgotten: z.boolean() });
export type AdminEmbeddedSiteForgetResult = z.infer<typeof AdminEmbeddedSiteForgetResultSchema>;
// v381 FIX (G6): POST /api/admin/sources/:id/embedded-sites/remember {site}: an admin's Remember again of a forgotten site.
export const AdminEmbeddedSiteRememberBodySchema = AdminEmbeddedSiteForgetBodySchema;
export type AdminEmbeddedSiteRememberBody = z.infer<typeof AdminEmbeddedSiteRememberBodySchema>;
export const AdminEmbeddedSiteRememberResultSchema = z.object({ remembered: z.boolean() });
export type AdminEmbeddedSiteRememberResult = z.infer<typeof AdminEmbeddedSiteRememberResultSchema>;
// end v381 EMBED

export const AdminRunsListSchema = z.object({
  items: z.array(JobSourceRunSchema),
  nextCursor: AdminCursorSchema.optional(),
  /** v31 RUNS: every run is paused (since when, by whom), or null. Absent from a server before v3.1. */
  paused: RunsPausedSchema.nullable().optional(),
});

// Hosts --------------------------------------------------------------------------------------------------------------

/** A host's robots.txt as the reader keeps it (site_robots), used at most a day. */
export const SiteRobotsSchema = z.object({
  host: z.string(),
  fetchedAt: IsoDateTime,
  status: z.enum(SITE_ROBOTS_STATUSES),
  httpStatus: z.number().int().nullable(),
  crawlDelaySeconds: z.number().int().nonnegative().nullable(),
  /** The Content-Signal lines as written. */
  contentSignals: z.string().nullable(),
  /** False when they say ai-input=no; null when they say nothing. */
  aiInput: z.boolean().nullable(),
  sitemaps: z.array(z.string()),
  /** The file itself, for the host page. */
  rules: z.string().nullable(),
});
export type SiteRobots = z.infer<typeof SiteRobotsSchema>;

/** One host the readers pace (crawl_hosts), with its sources. */
export const AdminHostRowSchema = z.object({
  host: z.string(),
  minIntervalMs: z.number().int().nonnegative(),
  nextSlotAt: IsoDateTime,
  holdUntil: IsoDateTime.nullable(),
  holdReason: z.enum(CRAWL_HOST_HOLD_REASONS).nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** The last answer's HTTP status. */
  lastStatus: z.number().int().nullable(),
  updatedAt: IsoDateTime,
  sources: z.number().int().nonnegative(),
  failingSources: z.number().int().nonnegative(),
  /** Its registrable domain is on the opt-out list: neither reader reads it. */
  optedOut: z.boolean(),
  // v37 LANE (SP v37 PLAN W10): a lane's row paces many hosts. `label` names it ("Workday (all sites)": every Workday
  // site takes its turns there; its failures in a row are its 429s in a row, its sources every Workday source);
  // `lane` names the lane a host's requests take their turns on (a Workday site's). Absent from a server before v3.6.1.
  label: z.string().optional(),
  lane: z.string().optional(),
  // v37 FIX-LANE (SP v37 FIXES-361 D3, F6): a lane's pace adapts to its platform's 429s. On the lane's row:
  // `minIntervalMs` is its gap now, `easesAt` when that gap next halves (null at its least gap, `leastGapMs`),
  // `consecutiveFailures` its 429s in the last `windowMinutes`, and `breakerAfter` of them hold the whole lane for
  // `breakerMinutes`. On a lane's site's row: the lane's pause or hold now (`laneHoldUntil`, `laneHoldReason`).
  // `platform` (on both) names the lane's platform in a sentence ("Workday": "all of Workday"); the lanes are the API's
  // registry (features/ingest/hosts.ts), only Workday's in v3.6.1.
  platform: z.string().optional(),
  easesAt: IsoDateTime.nullable().optional(),
  leastGapMs: z.number().int().nonnegative().optional(),
  windowMinutes: z.number().int().positive().optional(),
  breakerAfter: z.number().int().positive().optional(),
  breakerMinutes: z.number().int().positive().optional(),
  laneHoldUntil: IsoDateTime.nullable().optional(),
  laneHoldReason: z.enum(CRAWL_HOST_HOLD_REASONS).nullable().optional(),
  // end v37 LANE
});
export type AdminHostRow = z.infer<typeof AdminHostRowSchema>;

/** The per-host page: the row and its robots.txt. */
export const AdminHostSchema = AdminHostRowSchema.extend({ robots: SiteRobotsSchema.nullable() });
export type AdminHost = z.infer<typeof AdminHostSchema>;

export const AdminHostsQuerySchema = z.object({
  q: SearchText.optional(),
  held: AdminQueryFlagSchema,
  failing: AdminQueryFlagSchema,
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
});
export type AdminHostsQuery = z.infer<typeof AdminHostsQuerySchema>;
export const AdminHostsListSchema = z.object({
  items: z.array(AdminHostRowSchema),
  total: z.number().int().nonnegative(),
  nextCursor: AdminCursorSchema.optional(),
});

/** An admin holds a host for some hours (reason `admin`), or releases its hold. */
export const AdminHostHoldBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hold'), hours: z.number().int().min(1).max(720) }),
  z.object({ action: z.literal('release') }),
]);
export type AdminHostHoldBody = z.infer<typeof AdminHostHoldBodySchema>;

// Candidates ---------------------------------------------------------------------------------------------------------

// v30 S2
/** Why discovery's validation reads nothing now. */
export const DISCOVERY_OFF_REASONS = ['identity', 'ingest_off'] as const;
export type DiscoveryOffReason = (typeof DISCOVERY_OFF_REASONS)[number];
export const DISCOVERY_OFF_LABEL: Record<DiscoveryOffReason, string> = {
  identity: 'Off until BOT_USER_AGENT names the public bot page and a role mailbox',
  ingest_off: 'Off while INGEST_ENABLED is false',
};
// end v30 S2

/** A board or site found but not yet a source (job_source_candidates): a count, never a user id. */
export const JobSourceCandidateSchema = z.object({
  id: z.number().int(),
  kind: z.enum(JOB_SOURCE_KINDS),
  name: z.string(),
  discoveredVia: z.enum(JOB_SOURCE_DISCOVERED_VIA),
  seenCount: z.number().int().nonnegative(),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  status: z.enum(JOB_SOURCE_CANDIDATE_STATUSES),
  attempts: z.number().int().nonnegative(),
  nextCheckAt: IsoDateTime.nullable(),
  /** The source it became. */
  sourceId: z.number().int().nullable(),
  // v30 S2: what its validation found (migration 0020) and, once a source, that board's measures (12 §5.2).
  /** Its last validation read. */
  checkedAt: IsoDateTime.nullable().optional(),
  /** Open postings its validation found. */
  openJobs: z.number().int().nonnegative().nullable().optional(),
  /** Why its last validation failed (a 404, a robots.txt refusal, a 5xx), in the reader's words. */
  lastError: z.string().nullable().optional(),
  /** The source it became: its name, whether it runs, its open jobs now and how long its jobs stay open (median days). */
  sourceName: z.string().nullable().optional(),
  sourceEnabled: z.boolean().nullable().optional(),
  sourceOpenJobs: z.number().int().nonnegative().nullable().optional(),
  openLifeDays: z.number().nonnegative().nullable().optional(),
  // end v30 S2
  /**
   * v36 SOURCES (PLAN S2, S8): the source it became waits for an admin (off, never turned on): validation makes every
   * source off. Null (or absent) when it became none.
   */
  sourceWaiting: z.boolean().nullable().optional(),
});
export type JobSourceCandidate = z.infer<typeof JobSourceCandidateSchema>;

export const AdminCandidatesQuerySchema = z.object({
  q: SearchText.optional(),
  kind: adminQueryList(z.enum(JOB_SOURCE_KINDS), JOB_SOURCE_KINDS.length),
  status: adminQueryList(z.enum(JOB_SOURCE_CANDIDATE_STATUSES), JOB_SOURCE_CANDIDATE_STATUSES.length),
  discoveredVia: adminQueryList(z.enum(JOB_SOURCE_DISCOVERED_VIA), JOB_SOURCE_DISCOVERED_VIA.length),
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
});
export type AdminCandidatesQuery = z.infer<typeof AdminCandidatesQuerySchema>;

/** The candidate funnel: candidates by status and by how they were found, and today's validations. */
export const CandidateFunnelSchema = z.object({
  byStatus: z.array(
    z.object({
      status: z.enum(JOB_SOURCE_CANDIDATE_STATUSES),
      count: z.number().int().nonnegative(),
      /**
       * v36 FIX-SRC (the final ux review's L7): of `count`, the candidates whose source waits for an admin (off, never
       * turned on: AdminSourceRow `waitingForAdmin`) and those whose source is on. Sent for every status (0 where no
       * candidate has a source); absent from a server before it.
       */
      sourcesWaiting: z.number().int().nonnegative().optional(),
      sourcesOn: z.number().int().nonnegative().optional(),
    }),
  ),
  byVia: z.array(z.object({ discoveredVia: z.enum(JOB_SOURCE_DISCOVERED_VIA), count: z.number().int().nonnegative() })),
  validatedToday: z.number().int().nonnegative(),
  // v30 S2: whether validation reads now (and why not), the day's cap, the measure owner question 17 waits for, and
  // Common Crawl's progress.
  validation: z
    .object({
      /** Validation reads boards now. */
      on: z.boolean(),
      /** Why not: BOT_USER_AGENT is a placeholder, or INGEST_ENABLED is off. */
      reason: z.enum(DISCOVERY_OFF_REASONS).nullable(),
      /** DISCOVERY_VALIDATIONS_PER_DAY. */
      cap: z.number().int().nonnegative(),
      /** Reads made today (UTC). */
      usedToday: z.number().int().nonnegative(),
      /** Kinds with candidates that validation does not read yet (no adapter, terms not recorded, or switched off). */
      waitingKinds: z.array(z.enum(JOB_SOURCE_KINDS)),
    })
    .optional(),
  /** Shared companies with open jobs and no known board (name probes' measure: owner question 17). */
  companiesWithoutBoard: z.number().int().nonnegative().optional(),
  /** DISCOVERY_PROBES_PER_HOST_PER_DAY (0: name probes off). */
  probesPerHost: z.number().int().nonnegative().optional(),
  commonCrawl: z
    .object({
      crawl: z.string().nullable(),
      done: z.boolean(),
      /** The query read now (of `queries`). */
      query: z.number().int().nonnegative(),
      queries: z.number().int().nonnegative(),
      finishedAt: IsoDateTime.nullable(),
    })
    .optional(),
  // end v30 S2
});
export type CandidateFunnel = z.infer<typeof CandidateFunnelSchema>;

export const AdminCandidatesListSchema = z.object({
  items: z.array(JobSourceCandidateSchema),
  total: z.number().int().nonnegative(),
  funnel: CandidateFunnelSchema,
  nextCursor: AdminCursorSchema.optional(),
});

/** What a bulk action does to chosen candidates: validate them at the next chance, or drop them for good. */
export const ADMIN_CANDIDATE_BULK_ACTIONS = ['retry', 'drop'] as const;
export const AdminCandidatesBulkBodySchema = z.object({ action: z.enum(ADMIN_CANDIDATE_BULK_ACTIONS), ids: adminBulkIds(Id) });
export type AdminCandidatesBulkBody = z.infer<typeof AdminCandidatesBulkBodySchema>;
export const AdminCandidatesBulkResultSchema = adminBulkResultSchema(ADMIN_SOURCE_BULK_OUTCOMES);
export type AdminCandidatesBulkResult = z.infer<typeof AdminCandidatesBulkResultSchema>;

// v30 S2: an admin's own boards (12 §4.1 signal 7: a list of board addresses or names, made candidates), and the
// measures by board kind (12 §5.2, §11 phase 2: boards, open jobs per board, new postings a month, open life).

/** The most entries one Add boards takes (one request). */
export const ADMIN_CANDIDATES_ADD_MAX = 200;
/** An admin's boards: board addresses (any posting's or board's page) or names, with their kind for a bare name. */
export const AdminCandidatesAddBodySchema = z.object({
  entries: z.array(z.string().trim().min(1).max(2048)).min(1).max(ADMIN_CANDIDATES_ADD_MAX),
  /** The kind of a bare name (an address names its own). */
  kind: z.enum(JOB_SOURCE_KINDS).optional(),
});
export type AdminCandidatesAddBody = z.infer<typeof AdminCandidatesAddBodySchema>;
/** What each entry did: a candidate added or seen again, a board a source reads already, an opted-out company's, none. */
export const ADMIN_CANDIDATE_ADD_OUTCOMES = ['added', 'bumped', 'known_source', 'forbidden', 'refused'] as const;
export type AdminCandidateAddOutcome = (typeof ADMIN_CANDIDATE_ADD_OUTCOMES)[number];
export const AdminCandidatesAddResultSchema = z.object({
  results: z
    .array(
      z.object({
        entry: z.string(),
        outcome: z.enum(ADMIN_CANDIDATE_ADD_OUTCOMES),
        kind: z.enum(JOB_SOURCE_KINDS).nullable(),
        name: z.string().nullable(),
        candidateId: z.number().int().nullable(),
        sourceId: z.number().int().nullable(),
        /** v30 FIX-A (REV-UX UX-17): why a `refused` entry names no board TailorIT reads (optional). */
        reason: z.string().max(300).optional(),
      }),
    )
    .max(ADMIN_CANDIDATES_ADD_MAX),
  counts: z.partialRecord(z.enum(ADMIN_CANDIDATE_ADD_OUTCOMES), z.number().int().nonnegative()),
});
export type AdminCandidatesAddResult = z.infer<typeof AdminCandidatesAddResultSchema>;

/** One board kind's measures, from the last daily pass over its enabled sources. */
export const DiscoveryKindMeasureSchema = z.object({
  kind: z.enum(JOB_SOURCE_KINDS),
  /** Enabled sources (boards) of the kind. */
  sources: z.number().int().nonnegative(),
  boardsWithOpenJobs: z.number().int().nonnegative(),
  openJobs: z.number().int().nonnegative(),
  /** Open jobs per board with open jobs. */
  openJobsPerBoard: z.number().nonnegative().nullable(),
  /** Postings first seen in the last 30 days, per board. */
  newPostingsPerBoardPerMonth: z.number().nonnegative().nullable(),
  /** Jobs closed in the last 90 days, and how long they were open (days): the median of the boards' medians, the mean. */
  closed90d: z.number().int().nonnegative(),
  openLifeDaysMedian: z.number().nonnegative().nullable(),
  openLifeDaysMean: z.number().nonnegative().nullable(),
  measuredAt: IsoDateTime.nullable(),
});
export type DiscoveryKindMeasure = z.infer<typeof DiscoveryKindMeasureSchema>;
export const DiscoveryMeasuresSchema = z.object({ byKind: z.array(DiscoveryKindMeasureSchema) });
export type DiscoveryMeasures = z.infer<typeof DiscoveryMeasuresSchema>;
// end v30 S2

// Purges by source ---------------------------------------------------------------------------------------------------

/**
 * A purge by source (11 §8.5), of one source or of every source of a company. It closes the jobs only that source
 * lists and deletes their raw payloads; with `deleteTexts`, their texts too, except the text of a job an application
 * names, which only `deleteAppliedTexts` (a contract that demands it) deletes.
 */
export const JobSourcePurgeRequestSchema = z
  .object({
    sourceId: Id.optional(),
    companyId: Id.optional(),
    reason: z.enum(JOB_SOURCE_PURGE_REASONS),
    deleteTexts: z.boolean(),
    deleteAppliedTexts: z.boolean().default(false),
  })
  .superRefine((purge, ctx) => {
    if ((purge.sourceId === undefined) === (purge.companyId === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['sourceId'], message: 'Name a source or a company, not both' });
    }
    if (purge.deleteAppliedTexts && !(purge.deleteTexts && purge.reason === 'contract_end')) {
      ctx.addIssue({
        code: 'custom',
        path: ['deleteAppliedTexts'],
        message: "Applied jobs' texts go only when a contract demands it, with the other texts",
      });
    }
  });
export type JobSourcePurgeRequest = z.infer<typeof JobSourcePurgeRequestSchema>;

/** A purge's row (job_source_purges): what it was asked to do, and its counts so far. */
export const JobSourcePurgeSchema = z.object({
  id: z.number().int(),
  sourceId: z.number().int().nullable(),
  sourceName: z.string().nullable(),
  companyId: z.number().int().nullable(),
  companyName: z.string().nullable(),
  reason: z.enum(JOB_SOURCE_PURGE_REASONS),
  deleteTexts: z.boolean(),
  deleteAppliedTexts: z.boolean(),
  /** The admin who asked, by email; null for an opt-out's own purge or a deleted account. */
  requestedBy: z.string().nullable(),
  state: z.enum(JOB_SOURCE_PURGE_STATES),
  jobsClosed: z.number().int().nonnegative(),
  textsDeleted: z.number().int().nonnegative(),
  rawDeleted: z.number().int().nonnegative(),
  textsKeptForApplications: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
});
export type JobSourcePurge = z.infer<typeof JobSourcePurgeSchema>;

export const AdminPurgesQuerySchema = z.object({
  state: adminQueryList(z.enum(JOB_SOURCE_PURGE_STATES), JOB_SOURCE_PURGE_STATES.length),
  cursor: AdminCursorSchema.optional(),
  limit: AdminPageSizeSchema,
});
export const AdminPurgesListSchema = z.object({ items: z.array(JobSourcePurgeSchema), nextCursor: AdminCursorSchema.optional() });

// The daily report ---------------------------------------------------------------------------------------------------

/**
 * The daily report's alarms (12 §9.8): a host failing too many of its requests in a day; a kind's open jobs dropping
 * by too large a share in a day (a broken adapter); a kind with no new jobs for days. Their thresholds are S1's.
 */
export const SOURCING_ALARM_KINDS = ['host_failing', 'kind_dropped', 'kind_quiet'] as const;
export type SourcingAlarmKind = (typeof SOURCING_ALARM_KINDS)[number];
export const SourcingAlarmSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host_failing'), host: z.string(), failureShare: z.number().min(0).max(1) }),
  z.object({ kind: z.literal('kind_dropped'), sourceKind: z.enum(JOB_SOURCE_KINDS), dropShare: z.number().min(0).max(1) }),
  z.object({ kind: z.literal('kind_quiet'), sourceKind: z.enum(JOB_SOURCE_KINDS), days: z.number().int().nonnegative() }),
]);
export type SourcingAlarm = z.infer<typeof SourcingAlarmSchema>;

/** One day's sourcing (12 §9.8): runs and 304s, jobs by kind, failures by host, the candidates, the alarms. */
export const SourcingDailyReportSchema = z.object({
  day: IsoDate,
  runs: z.number().int().nonnegative(),
  notModifiedRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
  byKind: z.array(
    z.object({
      kind: z.enum(JOB_SOURCE_KINDS),
      runs: z.number().int().nonnegative(),
      notModified: z.number().int().nonnegative(),
      created: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      closed: z.number().int().nonnegative(),
      reopened: z.number().int().nonnegative(),
      openJobs: z.number().int().nonnegative(),
      /** The change in open jobs since the day before (negative: fewer). */
      openJobsChange: z.number().int(),
    }),
  ),
  /** The hosts with failures, most failures first. */
  hosts: z.array(z.object({ host: z.string(), requests: z.number().int().nonnegative(), failures: z.number().int().nonnegative() })),
  candidates: z.object({ found: z.number().int().nonnegative(), validated: z.number().int().nonnegative() }),
  alarms: z.array(SourcingAlarmSchema),
});
export type SourcingDailyReport = z.infer<typeof SourcingDailyReportSchema>;
