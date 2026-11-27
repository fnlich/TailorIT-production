import { z } from 'zod';
import {
  ADMIN_BULK_MAX,
  AdminSourceRowSchema,
  IsoDateTime,
  JOB_IMPORT_WAYS, // v35 INT-A
  JOB_SOURCE_IMPORT_KINDS,
  JobImportCountsSchema, // v35 INT-A
  JOB_SOURCE_KIND_LABEL,
  JOB_SOURCE_READ_FORBIDDING_TERMS, // v37 INT-2b
  JOB_SOURCE_RUNNABLE_TERMS, // v37 INT-B
  JOB_SOURCE_TERMS_LABEL, // v37 FIX-37B
  JobSourceRunSchema,
  SHEET_SOURCE_LABEL,
  SheetSourceConfigSchema,
  type AdminRunSource,
  type AdminRunSources,
  type AdminRunsQuery,
  type AdminSourceAllAction,
  type AdminSourceRow,
  type AdminSourcesAllCount,
  type AdminSourcesAllResult,
  type AdminSourcesBulkBody,
  type AdminSourcesBulkResult,
  type AdminSourcesFilter,
  type AdminSourcesQuery,
  type JobSourceKind,
  type JobSourceRun,
  type JobSourceTermsStatus, // v37 FIX-37B
  type JobSourceWaiting,
} from '@tailorit/shared';
import { constantDefault } from '@tailorit/shared/constants'; // v36 SOURCES
import { decodeCursor, encodeCursor, likeText, Where } from '../../core/admin/index';
import { optedOutSourceSql, optedOutSources } from './opt-out-gate'; // v30 FIX-A; v35 ADMIN: optedOutSourceSql
import { turnedOffSql } from './turned-off'; // v36 SOURCES
import type { DbQueries, SqlParams } from '../../core/db/types';
import { validationFailed } from '../../core/http/errors';
import { apiBoardOf, BOARD_KIND_TERMS, BOARD_NO_ROBOTS_KINDS, boardSourceHost, type KindTerms } from './boards/index'; // v38 FRAME: the board registry
import { laneSql, onLaneSql } from './hosts'; // v37 INT-B (LANE W1 + TRANSFER T3); v37 INT-2b: every lane
import { neverReadPlatformOfHost } from './career/platforms'; // v38 FIX-C (D3)
import {
  RUN_STATUSES,
  RUN_TRIGGERS,
  SCHEDULED_KINDS,
  SOURCE_KINDS,
  SOURCE_KIND_LABEL,
  UNRUN_KINDS,
  type RunStatus,
  type RunTrigger,
  type SourceKind,
  type SourceRecord,
} from './types';

// job_sources and job_source_runs as the admin console sees them. The admin DTOs live here (the shared package has no
// admin contracts); apps/web/src/features/settings/admin/types.ts mirrors them. v3.0 D2-C: through the async client
// (`deps.db` or a transaction's handle).
//
// v30 S1-API (12-job-sourcing.md §9.3, §9.8; 11-database.md §5.3): v2.0's `schedule` is gone (migration 0013). A new
// source gets its host (hostOf: crawl_hosts' and site_robots' key), its kind's recorded terms (KIND_TERMS: the owner's
// rule, only allowed sources run), `not_applicable` robots for a kind that reads no outside host, and (a kind the
// worker runs) next_run_at = now: the worker reads it at once, then at its tier's cadence. Admin › Sources pages
// 80,000 rows with filters and a keyset cursor (listAdminSources, CT's AdminSourcesQuery), and acts on up to 100 at
// once (bulkSources). Each row also carries the v2.0 console's keys (config, job counts, latest run) until S1-WEB's
// console replaces it.

/** A job_sources row as stored. */
export interface SourceRow {
  id: number;
  kind: SourceKind;
  name: string;
  config: string;
  company_id: number | null;
  /** A flag: boolean on PostgreSQL. */
  enabled: boolean | number;
  deactivate_missing: boolean | number;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: string | null;
  created_at: string | null;
  updated_at: string | null;
  // v30 S1-API: the Part 2 columns (11 §5.3).
  host?: string | null;
  tier?: string;
  next_run_at?: string | null;
  priority?: number;
  terms_status?: string;
  robots_status?: string;
  etag?: string | null;
  last_modified?: string | null;
  last_complete_at?: string | null;
  last_change_at?: string | null;
  consecutive_failures?: number;
  open_jobs?: number;
  lease_until?: string | null;
  ai_input?: boolean;
  discovered_via?: string | null;
  // v31 RUNS: an admin's pause of the source (job_sources.paused_at, paused_by: a users.id).
  paused_at?: string | null;
  paused_by?: string | null;
  // v36 SOURCES (migration 0060): when an admin last turned it on, and who (a users.id; null once that account is gone).
  enabled_at?: string | null;
  enabled_by?: string | null;
}

/** A flag column as read (boolean on PostgreSQL) as a boolean. */
const flagOf = (value: boolean | number) => value === true || value === 1;

/** A source's config column as an object ({} when it is not one). */
function configOf(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** How a source's kind reads in the console: "Google Sheet" for a csv source that holds a copy of a sheet tab. */
export function kindLabelOf(kind: SourceKind, config: Record<string, unknown>): string {
  if (kind === 'csv' && SheetSourceConfigSchema.safeParse(config.sheet).success) return SHEET_SOURCE_LABEL;
  return SOURCE_KIND_LABEL[kind] ?? JOB_SOURCE_KIND_LABEL[kind as JobSourceKind] ?? kind;
}

export function toSourceRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: configOf(row.config),
    companyId: row.company_id,
    enabled: flagOf(row.enabled),
    deactivateMissing: flagOf(row.deactivate_missing),
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    lastStatus: row.last_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    host: row.host ?? null,
    tier: row.tier ?? 'normal',
    nextRunAt: row.next_run_at ?? null,
    priority: row.priority ?? 0,
    termsStatus: row.terms_status ?? 'unchecked',
    robotsStatus: row.robots_status ?? 'unchecked',
    etag: row.etag ?? null,
    lastModified: row.last_modified ?? null,
    lastCompleteAt: row.last_complete_at ?? null,
    lastChangeAt: row.last_change_at ?? null,
    consecutiveFailures: row.consecutive_failures ?? 0,
    openJobs: row.open_jobs ?? 0,
    leaseUntil: row.lease_until ?? null,
    aiInput: row.ai_input ?? true,
    discoveredVia: row.discovered_via ?? null,
    pausedAt: row.paused_at ?? null, // v31 RUNS
    enabledAt: row.enabled_at ?? null, // v36 SOURCES
  };
}

const SOURCE_BY_ID_SQL = 'SELECT * FROM job_sources WHERE id = ?';
const SOURCE_BY_NAME_SQL = 'SELECT * FROM job_sources WHERE kind = ? AND name = ?';
const FIRST_OF_KIND_SQL = 'SELECT * FROM job_sources WHERE kind = ? ORDER BY id LIMIT 1';

export async function getSourceRecord(db: DbQueries, id: number): Promise<SourceRecord | null> {
  const row = await db.one<SourceRow>(SOURCE_BY_ID_SQL, [id]);
  return row ? toSourceRecord(row) : null;
}

export async function findSourceRecord(db: DbQueries, kind: SourceKind, name: string): Promise<SourceRecord | null> {
  const row = await db.one<SourceRow>(SOURCE_BY_NAME_SQL, [kind, name]);
  return row ? toSourceRecord(row) : null;
}

/** Every source, newest first (a few dozen in tests and scripts; Admin › Sources pages them: listAdminSources). */
export async function listSourceRecords(db: DbQueries): Promise<SourceRecord[]> {
  return (await db.all<SourceRow>('SELECT * FROM job_sources ORDER BY created_at DESC, id DESC')).map(toSourceRecord);
}

/** The first source of a kind (the oldest), whatever its name: the job pages' one source. */
export async function firstSourceOfKind(db: DbQueries, kind: SourceKind): Promise<SourceRecord | null> {
  const row = await db.one<SourceRow>(FIRST_OF_KIND_SQL, [kind]);
  return row ? toSourceRecord(row) : null;
}

/**
 * The csv source that holds a copy of this sheet tab, matched by spreadsheet and tab id rather than by name (renaming
 * the spreadsheet or the tab changes the default name, not the tab).
 */
export async function findSheetSource(db: DbQueries, spreadsheetId: string, gid: number): Promise<SourceRecord | null> {
  const d = db.dialect;
  const rows = await db.all<SourceRow>(
    `SELECT * FROM job_sources WHERE kind = 'csv' AND ${d.jsonText('config', '$.sheet.spreadsheetId')} = ? ` +
      `AND CAST(${d.jsonText('config', '$.sheet.gid')} AS INTEGER) = ? ORDER BY id`,
    [spreadsheetId, gid],
  );
  return rows.map(toSourceRecord).find((source) => SheetSourceConfigSchema.safeParse(source.config.sheet).success) ?? null;
}

// ------------------------------------------------------------------------------------------------- a new source

/**
 * A source to add. v36 SOURCES (PLAN S1): it has no `enabled`: every new source is made off and not due, and only an
 * admin's action turns one on (enableSources, below).
 */
export interface NewSource {
  kind: SourceKind;
  name: string;
  config: Record<string, unknown>;
  deactivateMissing?: boolean;
}

/**
 * The host a source's reads go to, from its kind and config (migration 0013 writes the same for older rows): the four
 * board APIs' hosts; null for a kind with no outside read or whose host differs per posting (Workday: the tenant's
 * hosts, read one posting at a time). v38 FRAME (SP v38 PLAN A1): a board kind's host is its board descriptor's (a feed
 * ATS's company host, a Workday career site's tenant host, a career site's own host, an iCIMS board's host...).
 */
export function hostOf(kind: string, config: Record<string, unknown>): string | null {
  const board = apiBoardOf(kind);
  if (board) return boardSourceHost(board, config);
  switch (kind) {
    // v30 S4: the feeds' API hosts (12 §3.6-3.7).
    case 'usajobs':
      return 'data.usajobs.gov';
    case 'himalayas':
      return 'himalayas.app';
    case 'jobicy':
      return 'jobicy.com';
    default:
      return null;
  }
}

/**
 * v30 S3 (12 §3.2-3.3): a Workday career site's tenant host (config `host`), or a feed's company host (config `company`,
 * and Personio's `domain`, `de` or `com`); null when the config names none TailorIT reads. v38 FRAME: its board
 * descriptor's host (hostOf), for those kinds only.
 */
export function feedHostOf(kind: string, config: Record<string, unknown>): string | null {
  return ['workday_site', 'personio', 'recruitee', 'breezy', 'bamboohr'].includes(kind) ? hostOf(kind, config) : null;
}

/**
 * v37 BOARDS (SP v37 PLAN B2, I3): BambooHR's and iCIMS's recorded terms notes, word for word as migration 0063 writes
 * them (v38 FRAME: their board descriptors').
 */
export { BAMBOOHR_TERMS_NOTE } from './boards/bamboohr';
export { ICIMS_TERMS_NOTE } from './boards/icims';

/**
 * The terms recorded for each kind TailorIT reads today (12 §3.1, §3.11, read 2026-11-14: "use"): the owner's rule
 * that only sources allowing automated access run. A kind not listed starts `unchecked` and never runs until an admin
 * (or its package) records its terms. v38 FRAME (SP v38 PLAN A5): a board kind's are its board descriptor's (Greenhouse's,
 * Lever's, Ashby's and Workable's documented APIs; Workday's and its career sites' own reads; Personio's documented feed;
 * Recruitee's careers API, "allowed with conditions" until 2027-02-10; BambooHR's and iCIMS's dated notes of 2026-11-24;
 * career sites' "allowed with conditions"; Breezy none: unchecked). The kinds that are no board are listed here.
 */
export const KIND_TERMS: Partial<Record<string, KindTerms>> = {
  ft_lake: { status: 'allowed', url: null },
  csv: { status: 'allowed', url: null },
  json: { status: 'allowed', url: null },
  seed: { status: 'allowed', url: null },
  page: { status: 'allowed', url: null },
  ext_page: { status: 'allowed', url: null },
  // v30 S4 (12 §3.6-3.7, read 2026-11-14): USAJOBS' public data may be stored and republished for commercial use (a
  // credit is encouraged); Himalayas and Jobicy allow commercial display and storage with a visible credit and their
  // own apply links (Himalayas: expired jobs removed, never passed on to aggregators; Jobicy: one read an hour).
  usajobs: { status: 'allowed', url: 'https://developer.usajobs.gov/guides/terms-of-service' },
  himalayas: { status: 'allowed_with_conditions', url: 'https://himalayas.app/docs/remote-jobs-api' },
  jobicy: { status: 'allowed_with_conditions', url: 'https://jobicy.com/jobs-rss-feed' },
  ...BOARD_KIND_TERMS,
};

/**
 * v37 INT-B: whether a source's recorded terms let it be read (JOB_SOURCE_RUNNABLE_TERMS; none recorded: unchecked).
 * v37 FIX-37B (SP v37 FIXES-37 E2): the one check of every path, for every kind: the scheduler and Run now (the source),
 * Add source's Test, every link's read, the re-checks and discovery (the board's sources: ingest/terms.ts).
 */
export const termsAllowReads = (status: string | null | undefined): boolean =>
  (JOB_SOURCE_RUNNABLE_TERMS as readonly string[]).includes(status ?? 'unchecked');

/**
 * v37 INT-2b (the coordinator's ruling on SP v37 FIXES-37 E2, binding): whether a source's recorded terms say no
 * (Forbidden, Needs a contract: JOB_SOURCE_READ_FORBIDDING_TERMS), so its board is never READ by any path: the
 * board-level gate (ingest/terms.ts: links, imports, the link queue, Retry read, re-checks, discovery, Add source's
 * Test). Not checked does not stop those reads: it only keeps the source from running (termsAllowReads).
 */
export const termsForbidReads = (status: string | null | undefined): boolean =>
  (JOB_SOURCE_READ_FORBIDDING_TERMS as readonly string[]).includes(status ?? 'unchecked');

/**
 * v37 FIX-37B (SP v37 FIXES-37 E8): why a source whose terms don't allow automated access is not read, in the agreed words
 * (MSG_INGEST_SOURCE_TERMS: "Its terms are Forbidden: TailorIT doesn't read it."): Run now's refusal, a bulk Run now's row.
 */
export const termsParams = (status: string | null | undefined): { status: string } => ({
  status: JOB_SOURCE_TERMS_LABEL[(status ?? 'unchecked') as JobSourceTermsStatus] ?? JOB_SOURCE_TERMS_LABEL.unchecked,
});

/**
 * Kinds that read no outside host: robots.txt does not apply (12 §1: keyed APIs are `not_applicable` too). v38 FRAME: and
 * every board kind whose descriptor says so (Workday's one-posting kind: each posting's read asks its tenant's robots.txt).
 */
export const NO_ROBOTS_KINDS: readonly string[] = [
  'ft_lake',
  'csv',
  'json',
  'seed',
  'page',
  'ext_page',
  ...BOARD_NO_ROBOTS_KINDS,
  // v30 S4: a keyed API (12 §1: data.usajobs.gov's `Disallow: /` is for crawlers; the key's terms govern).
  'usajobs',
];

/**
 * The columns a new source's row is made with (newSourceValues' order): autofill/sources.ts makes rows the same way.
 * v36 SOURCES (PLAN S1): `enabled` and `next_run_at` are not among them: a new row takes the columns' defaults, off
 * (migration 0060) and not due.
 */
export const NEW_SOURCE_COLUMNS =
  'job_sources(kind, name, config, deactivate_missing, host, terms_status, terms_url, terms_checked_at, robots_status, ' +
  'created_at, updated_at, terms_note)';
/** NEW_SOURCE_COLUMNS' placeholders. */
export const NEW_SOURCE_PLACEHOLDERS = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

/** The values of a new source's row, in NEW_SOURCE_COLUMNS' order. */
export function newSourceValues(source: NewSource, now: string) {
  const terms = KIND_TERMS[source.kind];
  return [
    source.kind,
    source.name,
    JSON.stringify(source.config),
    // Flags bound as booleans (decision K). An upload adds jobs; a later upload of another file must not close the
    // first one's.
    source.deactivateMissing ?? !['csv', 'json'].includes(source.kind),
    hostOf(source.kind, source.config),
    terms?.status ?? 'unchecked',
    terms?.url ?? null,
    terms ? now : null,
    NO_ROBOTS_KINDS.includes(source.kind) ? 'not_applicable' : 'unchecked',
    now,
    now,
    terms?.note ?? null, // v37 BOARDS: the kind's dated terms note (BambooHR, iCIMS)
  ];
}

// v36 SOURCES (PLAN S1) ------------------------------------------------------------------------------------- "on"

/** The admin an enable records (job_sources.enabled_by): the signed-in administrator's account. */
export interface EnablingAdmin {
  id: string;
}

/**
 * The one writer of "on" (PLAN S1): turns the sources that are off on, recording when (enabled_at) and the admin
 * (enabled_by), and makes a kind the worker runs due now (a source turned on runs at its next look). Only the admin
 * routes call it (router.ts: the switch, Add source with "Turn on now"; through bulkSources: bulk Enable, Enable all, an
 * import run's Enable all); v36-source-fence.test.ts fails on any other code that writes `enabled = true`. A kind that
 * is never run is never turned on. `admin` is null only where no account exists (tests' fixtures); every route passes
 * the signed-in admin. Answers the ids it turned on.
 * v36 FIX-SRC (the final data review's D2): a career site turned on loses Add job's mark (config `addedBy`), which a
 * keeper discovery adopted keeps while it waits: its pages are its own runs' from then on (the scheduler's), never the
 * weekly page re-read's (jobs/add/recheck.ts), also if an admin turns it off again.
 * v37 TRANSFER (SP v37 PLAN T3): in the same statement, each host of the sources it turned on gets its crawl_hosts row
 * when it has none (Admin › Hosts lists it before its first request): paced `hostPaceMs` apart (the routes pass
 * INGEST_HOST_MIN_INTERVAL_MS), or by the host's robots.txt Crawl-delay when that is longer, as the robots store writes
 * it; a host's row that is there is left as it is. Every way of turning a source on comes here, so every way adds it.
 * v37 INT-B (LANE W1): a Workday source's requests take their turns on the one Workday lane (hosts.ts WORKDAY_LANE): its
 * row is added too when a Workday source is turned on (its own pace 0: WORKDAY_MIN_INTERVAL_MS rules, read at each
 * turn), so Admin › Hosts holds a real lane row (Hold works on it) from the turn-on. The tenant's own row stays (its
 * holds and backoff are its own). v37 INT-2b (E1): every registered lane alike (laneSql / onLaneSql over the turned-on
 * hosts: Workday's, BambooHR's, iCIMS's), one row per lane key.
 */
export async function enableSources(
  db: DbQueries,
  ids: readonly number[],
  admin: EnablingAdmin | null,
  now: string,
  hostPaceMs: number = constantDefault('INGEST_HOST_MIN_INTERVAL_MS') as number, // v37 TRANSFER
): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<{ id: number }>(
    `WITH turned AS (
       UPDATE job_sources SET enabled = true, enabled_at = CAST(@now AS timestamptz), enabled_by = @by, updated_at = CAST(@now AS timestamptz),
         config = CASE WHEN kind = 'career_site' THEN config - 'addedBy' ELSE config END,
         next_run_at = CASE WHEN kind = ANY(string_to_array(@scheduled, ','))
           THEN LEAST(COALESCE(next_run_at, CAST(@now AS timestamptz)), CAST(@now AS timestamptz)) ELSE next_run_at END
       WHERE id = ANY(CAST(string_to_array(@ids, ',') AS bigint[])) AND NOT enabled AND NOT (kind = ANY(string_to_array(@unrun, ',')))
       RETURNING id, host
     ), hosts AS (
       INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at)
       SELECT h.host, GREATEST(CAST(@pace AS integer), COALESCE(r.crawl_delay_s, 0) * 1000), CAST(@now AS timestamptz), CAST(@now AS timestamptz)
       FROM (SELECT DISTINCT host FROM turned WHERE host IS NOT NULL AND host <> '') h
       LEFT JOIN site_robots r ON r.host = h.host AND r.status <> 'unreachable'
       ORDER BY h.host
       ON CONFLICT (host) DO NOTHING
     ), lane AS (
       INSERT INTO crawl_hosts(host, min_interval_ms, next_slot_at, updated_at)
       SELECT DISTINCT ${laneSql('turned.host')}, 0, CAST(@now AS timestamptz), CAST(@now AS timestamptz)
       FROM turned WHERE ${onLaneSql('turned.host')}
       ON CONFLICT (host) DO NOTHING
     )
     SELECT id FROM turned`,
    {
      now,
      by: admin?.id ?? null,
      ids: ids.join(','),
      scheduled: SCHEDULED_KINDS.join(','),
      unrun: UNRUN_KINDS.join(','),
      pace: Math.max(0, Math.round(hostPaceMs)), // v37 TRANSFER
    },
  );
  return rows.map((row) => Number(row.id));
}
// end v36 SOURCES

/**
 * Adds the source, or answers null when its kind and name are taken (UNIQUE(kind, name): two requests adding one name at
 * once make one source). The caller decides: a 409, or the source that holds the name.
 */
export async function insertSource(db: DbQueries, source: NewSource, now: string): Promise<SourceRecord | null> {
  const row = await db.one<SourceRow>(
    `INSERT INTO ${NEW_SOURCE_COLUMNS} VALUES (${NEW_SOURCE_PLACEHOLDERS}) ON CONFLICT(kind, name) DO NOTHING RETURNING *`,
    newSourceValues(source, now),
  );
  return row ? toSourceRecord(row) : null;
}

// ------------------------------------------------------------------------------------------------- admin DTOs

export const SourceRunSummarySchema = z.object({
  id: z.number().int(),
  status: z.enum(RUN_STATUSES),
  trigger: z.enum(RUN_TRIGGERS),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  fetched: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  deactivated: z.number().int(),
  failed: z.number().int(),
  error: z.string().nullable(),
});
export type SourceRunSummary = z.infer<typeof SourceRunSummarySchema>;

/**
 * One source as Admin › Sources shows it: CT's row (AdminSourceRowSchema), the v2.0 console's keys (its config, job
 * counts and latest run) and, for one source, its terms and pace.
 */
export const AdminSourceSchema = AdminSourceRowSchema.extend({
  kind: z.enum(SOURCE_KINDS),
  config: z.record(z.string(), z.unknown()),
  deactivateMissing: z.boolean(),
  createdAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime.nullable(),
  /** Jobs this source links to, and how many of them are live. */
  jobCount: z.number().int(),
  activeJobCount: z.number().int(),
  lastRun: SourceRunSummarySchema.nullable(),
  termsUrl: z.string().nullable().optional(),
  termsNote: z.string().nullable().optional(),
  termsCheckedAt: IsoDateTime.nullable().optional(),
  robotsCheckedAt: IsoDateTime.nullable().optional(),
  priority: z.number().int().optional(),
  /** The tier's cadence, in hours (job_sources.cadence). */
  cadenceHours: z.number().nonnegative().optional(),
});
export type AdminSource = z.infer<typeof AdminSourceSchema>;

/** One run (CT's JobSourceRunSchema) with the v2.0 console's kind label. */
export const AdminRunSchema = JobSourceRunSchema.extend({
  status: z.enum(RUN_STATUSES),
  trigger: z.enum(RUN_TRIGGERS),
  sourceKind: z.enum(SOURCE_KINDS),
  /** "Greenhouse", "CSV import", "Google Sheet"... (kindLabelOf). */
  sourceKindLabel: z.string(),
});
export type AdminRun = z.infer<typeof AdminRunSchema>;

export const AdminRunDetailSchema = AdminRunSchema.extend({ log: z.array(z.string()) });
export type AdminRunDetail = z.infer<typeof AdminRunDetailSchema>;

interface RunRow {
  id: number;
  source_id: number;
  trigger: RunTrigger;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  http_status: number | null;
  bytes_fetched: number | null;
  requests: number | null;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  reopened: number | null;
  failed: number;
  error_code: string | null;
  error: string | null;
  log: string | null;
  /** v31 RUNS: when an admin asked it to pause. */
  stop_requested_at?: string | null;
  kind?: SourceKind;
  name?: string;
  /** The source's config (joined in by the run queries, for its kind label). */
  config?: string;
  /** v35 INT-A: the run's import (job_imports, joined in by the run queries: RUN_IMPORT_COLUMNS). */
  import_id?: number | null;
  import_way?: string | null;
  import_name?: string | null;
  import_started_by?: string | null;
  import_rows?: number | null;
  import_finished_at?: string | null;
  import_counts?: string | Record<string, unknown> | null;
}

/**
 * v35 INT-A: the run queries' join of the run's import (IMPORT's job_imports, one per run: ux_job_imports_run) and who
 * started it, for Runs' "Import · <name> · <counts>" (importOf.import).
 */
const RUN_IMPORT_COLUMNS =
  'ji.id AS import_id, ji.way AS import_way, ji.name AS import_name, ji.rows AS import_rows, ji.finished_at AS import_finished_at, ' +
  "ji.counts AS import_counts, COALESCE(NULLIF(ju.name, ''), ju.email) AS import_started_by";
const RUN_IMPORT_JOIN = 'LEFT JOIN job_imports ji ON ji.run_id = r.id LEFT JOIN users ju ON ju.id = ji.actor_id';

/** v35 INT-A: the run's import as Runs shows it (JobSourceRun importOf.import), or null. */
function runImportOf(row: RunRow): NonNullable<NonNullable<JobSourceRun['importOf']>['import']> | null {
  if (row.import_id === null || row.import_id === undefined || !row.import_name) return null;
  const way = JOB_IMPORT_WAYS.find((value) => value === row.import_way);
  if (!way) return null;
  const finishedAt = row.import_finished_at ? new Date(row.import_finished_at).toISOString() : null;
  let counts: unknown = row.import_counts ?? null;
  if (typeof counts === 'string') {
    try {
      counts = JSON.parse(counts);
    } catch {
      counts = null;
    }
  }
  const parsed = finishedAt ? JobImportCountsSchema.safeParse(counts) : null;
  return {
    id: Number(row.import_id),
    way,
    name: row.import_name,
    startedBy: row.import_started_by ?? null,
    rows: Number(row.import_rows ?? 0),
    finishedAt,
    counts: parsed?.success ? parsed.data : null,
  };
}

function toRunSummary(row: RunRow): SourceRunSummary {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    fetched: row.fetched ?? 0,
    created: row.created ?? 0,
    updated: row.updated ?? 0,
    unchanged: row.unchanged ?? 0,
    deactivated: row.deactivated ?? 0,
    failed: row.failed ?? 0,
    error: row.error,
  };
}

/**
 * v35 ADMIN (PLAN H6): how an import's run came (its csv or json record's config: a Google Sheet's tab, pasted links
 * (`pasted`), else a file), for its label on Admin › Runs; null for a source's run.
 */
export function importOfRun(kind: SourceKind, config: Record<string, unknown>): NonNullable<JobSourceRun['importOf']> | null {
  if (!(JOB_SOURCE_IMPORT_KINDS as readonly string[]).includes(kind)) return null;
  const sheet = SheetSourceConfigSchema.safeParse(config.sheet);
  const fileName = typeof config.fileName === 'string' && config.fileName.trim() ? config.fileName.trim() : null;
  if (sheet.success) {
    return { way: 'sheet', fileName, sheet: { spreadsheetTitle: sheet.data.spreadsheetTitle, tabTitle: sheet.data.tabTitle } };
  }
  return { way: config.pasted === true ? 'pasted' : 'file', fileName, sheet: null };
}

/** v35 INT-A: importOfRun with the run's import (runImportOf; absent when the run has none). */
function importOfRunRow(kind: SourceKind, row: RunRow): JobSourceRun['importOf'] {
  const of = importOfRun(kind, configOf(row.config));
  const imported = of ? runImportOf(row) : null;
  return of ? { ...of, ...(imported ? { import: imported } : {}) } : null;
}

function toAdminRun(row: RunRow): AdminRun {
  const kind = row.kind ?? 'seed';
  return {
    ...toRunSummary(row),
    sourceId: row.source_id,
    sourceKind: kind,
    sourceKindLabel: kindLabelOf(kind, configOf(row.config)),
    sourceName: row.name ?? '',
    httpStatus: row.http_status,
    bytesFetched: row.bytes_fetched,
    requests: row.requests ?? 0,
    reopened: row.reopened ?? 0,
    errorCode: row.error_code,
    stopRequestedAt: row.stop_requested_at ?? null, // v31 RUNS
    importOf: importOfRunRow(kind, row), // v35 ADMIN; v35 INT-A: with its import
  };
}

/** A source row with the company's name and the job counts the v2.0 console shows. */
type ListedRow = SourceRow & {
  company_name: string | null;
  /** v31 RUNS: the email of the admin who paused it. */
  paused_by_email?: string | null;
  /** v36 SOURCES: the email of the admin who last turned it on. */
  enabled_by_email?: string | null;
  cadence_hours: number | null;
  terms_url: string | null;
  terms_note: string | null;
  terms_checked_at: string | null;
  robots_checked_at: string | null;
};

const LISTED_COLUMNS =
  's.*, c.name AS company_name, extract(epoch from s.cadence) / 3600 AS cadence_hours, pu.email AS paused_by_email, ' +
  'eu.email AS enabled_by_email';
// v31 RUNS: the admin who paused a source (paused_by: a users.id), by their email. v36 SOURCES: and the admin who last
// turned it on (enabled_by).
const LISTED_FROM =
  'job_sources s LEFT JOIN companies c ON c.id = s.company_id LEFT JOIN users pu ON pu.id = s.paused_by ' +
  'LEFT JOIN users eu ON eu.id = s.enabled_by';

/**
 * v36 SOURCES (PLAN S8): a source waiting for an admin: off, found by discovery or an admin's import, and never turned
 * on by an admin (Admin › Sources' "Waiting for an admin"). Discovery makes every source this way.
 */
export function isWaitingForAdmin(source: Pick<SourceRecord, 'enabled' | 'enabledAt' | 'discoveredVia'>): boolean {
  return !source.enabled && !source.enabledAt && Boolean(source.discoveredVia);
}
/** isWaitingForAdmin in SQL, on the job_sources row `s`. */
export const WAITING_FOR_ADMIN_SQL = '(NOT s.enabled AND s.enabled_at IS NULL AND s.discovered_via IS NOT NULL)';

/** Each source's job counts and latest run, for the rows of one page (read through job_source_links' key and the runs index). */
async function extrasOf(db: DbQueries, ids: readonly number[]) {
  if (ids.length === 0) return { counts: new Map<number, { total: number; live: number }>(), latest: new Map<number, SourceRunSummary>() };
  const list = ids.join(',');
  const counts = new Map(
    (
      await db.all<{ source_id: number; total: number; live: number }>(
        'SELECT l.source_id, count(*) AS total, count(*) FILTER (WHERE j.active) AS live FROM job_source_links l ' +
          'JOIN jobs j ON j.id = l.job_id WHERE l.source_id = ANY(CAST(string_to_array(?, \',\') AS bigint[])) GROUP BY l.source_id',
        [list],
      )
    ).map((row) => [row.source_id, row]),
  );
  const latest = new Map(
    (
      await db.all<RunRow>(
        'SELECT r.* FROM unnest(CAST(string_to_array(?, \',\') AS bigint[])) AS s(id) JOIN LATERAL (SELECT x.* FROM job_source_runs x ' +
          'WHERE x.source_id = s.id ORDER BY x.started_at DESC, x.id DESC LIMIT 1) r ON true',
        [list],
      )
    ).map((row) => [row.source_id, toRunSummary(row)]),
  );
  return { counts, latest };
}

function toAdminRow(row: ListedRow, at: string, waiting: JobSourceWaiting | null = null): AdminSourceRow {
  const source = toSourceRecord(row);
  return {
    id: source.id,
    kind: source.kind,
    kindLabel: kindLabelOf(source.kind, source.config),
    name: source.name,
    host: source.host ?? null,
    companyId: source.companyId,
    companyName: row.company_name,
    enabled: source.enabled,
    tier: (source.tier ?? 'normal') as AdminSourceRow['tier'],
    termsStatus: (source.termsStatus ?? 'unchecked') as AdminSourceRow['termsStatus'],
    robotsStatus: (source.robotsStatus ?? 'unchecked') as AdminSourceRow['robotsStatus'],
    discoveredVia: (source.discoveredVia ?? null) as AdminSourceRow['discoveredVia'],
    nextRunAt: source.nextRunAt ?? null,
    lastRunAt: source.lastRunAt,
    lastSuccessAt: source.lastSuccessAt,
    lastCompleteAt: source.lastCompleteAt ?? null,
    lastStatus: source.lastStatus,
    consecutiveFailures: source.consecutiveFailures ?? 0,
    openJobs: source.openJobs ?? 0,
    aiInput: source.aiInput ?? true,
    running: source.leaseUntil !== null && source.leaseUntil !== undefined && Date.parse(source.leaseUntil) > Date.parse(at),
    // v31 RUNS
    pausedAt: source.pausedAt ?? null,
    pausedBy: source.pausedAt ? (row.paused_by_email ?? null) : null,
    waiting, // v35 ADMIN
    // v36 SOURCES
    enabledAt: source.enabledAt ?? null,
    enabledBy: source.enabledAt ? (row.enabled_by_email ?? null) : null,
    waitingForAdmin: isWaitingForAdmin(source),
  };
}

function toAdminSource(
  row: ListedRow,
  at: string,
  count: { total: number; live: number } | undefined,
  lastRun: SourceRunSummary | null,
  runningHere: boolean,
  detail: boolean,
  waiting: JobSourceWaiting | null = null, // v35 ADMIN
): AdminSource {
  const base = toAdminRow(row, at, waiting);
  const source = toSourceRecord(row);
  return {
    ...base,
    kind: source.kind,
    running: base.running || runningHere,
    config: source.config,
    deactivateMissing: source.deactivateMissing,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    jobCount: count?.total ?? 0,
    activeJobCount: count?.live ?? 0,
    lastRun,
    ...(detail
      ? {
          termsUrl: row.terms_url,
          termsNote: row.terms_note,
          termsCheckedAt: row.terms_checked_at,
          robotsCheckedAt: row.robots_checked_at,
          priority: source.priority ?? 0,
          cadenceHours: row.cadence_hours === null ? 0 : Math.round(Number(row.cadence_hours) * 100) / 100,
        }
      : {}),
  };
}

/** Admin › Sources' orders: the column, its direction, and whether it holds NULLs (sorted last). */
const SORTS: Record<AdminSourcesQuery['sort'], { column: string; desc: boolean; nullable: boolean }> = {
  next_run: { column: 's.next_run_at', desc: false, nullable: true },
  last_run: { column: 's.last_run_at', desc: true, nullable: true },
  name: { column: 's.name', desc: false, nullable: false },
  open_jobs: { column: 's.open_jobs', desc: true, nullable: false },
  failures: { column: 's.consecutive_failures', desc: true, nullable: false },
};

const STALE_CURSOR = 'This list changed. Load it again from the top.';

/** The keyset condition after a cursor's row for a sort (NULLs last, the id breaking ties in the sort's direction). */
function afterSorted(sort: (typeof SORTS)[keyof typeof SORTS], cursor: string): { sql: string; params: Record<string, unknown> } {
  const { k, id } = decodeCursor(cursor, STALE_CURSOR);
  if (typeof id !== 'number' || (k !== null && typeof k !== 'string' && typeof k !== 'number')) throw validationFailed(STALE_CURSOR);
  const past = sort.desc ? '<' : '>';
  const key = sort.nullable && typeof k === 'string' ? `CAST(@cursorKey AS timestamptz)` : '@cursorKey';
  if (k === null) return { sql: `(${sort.column} IS NULL AND s.id ${past} @cursorId)`, params: { cursorId: id } };
  const sql =
    `(${sort.column} ${past} ${key} OR (${sort.column} = ${key} AND s.id ${past} @cursorId)` +
    `${sort.nullable ? ` OR ${sort.column} IS NULL` : ''})`;
  return { sql, params: { cursorKey: k, cursorId: id } };
}

/** A list filter's values as one text parameter (`= ANY(string_to_array(...))`): the values are closed lists. */
const listParam = (values: readonly string[]) => values.join(',');

/**
 * The condition of Admin › Sources' filters on the job_sources row `s` (the list, its count, and Enable all / Disable
 * all). v35 ADMIN (PLAN H6): an import's records (csv, json) are never one of them, whatever the filter.
 */
export function sourcesWhere(filter: AdminSourcesFilter): Where {
  const where = new Where();
  where.add("NOT (s.kind = ANY(string_to_array(@importKinds, ',')))", { importKinds: listParam(JOB_SOURCE_IMPORT_KINDS) });
  if (filter.q) where.add("(s.name ILIKE @q ESCAPE '\\' OR s.host ILIKE @q ESCAPE '\\')", { q: likeText(filter.q) });
  if (filter.kind.length) where.add("s.kind = ANY(string_to_array(@kinds, ','))", { kinds: listParam(filter.kind) });
  if (filter.tier.length) where.add("s.tier = ANY(string_to_array(@tiers, ','))", { tiers: listParam(filter.tier) });
  if (filter.terms.length) where.add("s.terms_status = ANY(string_to_array(@terms, ','))", { terms: listParam(filter.terms) });
  if (filter.robots.length) where.add("s.robots_status = ANY(string_to_array(@robots, ','))", { robots: listParam(filter.robots) });
  if (filter.discoveredVia.length) {
    where.add("s.discovered_via = ANY(string_to_array(@via, ','))", { via: listParam(filter.discoveredVia) });
  }
  // v36 SOURCES (PLAN S8): `waiting`, found and never turned on (WAITING_FOR_ADMIN_SQL).
  if (filter.enabled !== 'all') {
    where.add(filter.enabled === 'enabled' ? 's.enabled' : filter.enabled === 'waiting' ? WAITING_FOR_ADMIN_SQL : 'NOT s.enabled');
  }
  if (filter.turnedOff) where.add(turnedOffSql(filter.turnedOff)); // v36 SOURCES (PLAN S7): the notice's sources
  if (filter.failing) where.add("(s.consecutive_failures > 0 OR s.tier = 'failing')");
  if (filter.host) where.add('s.host = @host', { host: filter.host });
  if (filter.companyId) where.add('s.company_id = @companyId', { companyId: filter.companyId });
  return where;
}

/** v35 ADMIN (PLAN H7): each listed source's waiting reason (by id), as ingest/waiting.ts reads it; none by default. */
export type SourcesWaiting = (sources: readonly SourceRecord[]) => Promise<ReadonlyMap<number, JobSourceWaiting>>;

/**
 * Admin › Sources at 80,000 rows (12 §9.8): searched by name or host, filtered (kind, tier, terms, robots, how found,
 * enabled, failing, host, company), counted, ordered (next run by default, idx_job_sources_next_run) and paged by a
 * keyset cursor. `runningHere`: the sources this process runs now (the rest by their lease). v35 ADMIN: never an
 * import's record (sourcesWhere); each row says why it waits when it is on and cannot run (`waiting`).
 */
export async function listAdminSources(
  db: DbQueries,
  query: AdminSourcesQuery,
  at: string,
  runningHere: (id: number) => boolean = () => false,
  waiting?: SourcesWaiting,
): Promise<{ items: AdminSource[]; total: number; nextCursor?: string }> {
  const where = sourcesWhere(query);
  const total = (await db.one<{ n: number }>(`SELECT count(*) AS n FROM job_sources s ${where.sql()}`, where.params as SqlParams))?.n ?? 0;

  const sort = SORTS[query.sort];
  if (query.cursor) {
    const after = afterSorted(sort, query.cursor);
    where.add(after.sql, after.params);
  }
  const direction = sort.desc ? 'DESC' : 'ASC';
  const rows = await db.all<ListedRow>(
    `SELECT ${LISTED_COLUMNS} FROM ${LISTED_FROM} ${where.sql()} ` +
      `ORDER BY ${sort.column} ${direction}${sort.nullable ? ' NULLS LAST' : ''}, s.id ${direction} LIMIT @limit`,
    { ...where.params, limit: query.limit + 1 } as SqlParams,
  );
  const page = rows.slice(0, query.limit);
  const { counts, latest } = await extrasOf(
    db,
    page.map((row) => row.id),
  );
  const reasons = waiting ? await waiting(page.map(toSourceRecord)) : new Map<number, JobSourceWaiting>();
  const items = page.map((row) =>
    toAdminSource(row, at, counts.get(row.id), latest.get(row.id) ?? null, runningHere(row.id), false, reasons.get(row.id) ?? null),
  );
  if (rows.length <= query.limit || page.length === 0) return { items, total };
  const last = page[page.length - 1]!;
  // The sort column's value on the last row ("s.next_run_at" -> next_run_at), and its id.
  const value = (last as unknown as Record<string, string | number | null | undefined>)[sort.column.slice(2)];
  return { items, total, nextCursor: encodeCursor({ k: value ?? null, id: last.id }) };
}

/** One source for the admin (its row, job counts, latest run, terms and pace, why it waits), or null. */
export async function adminSource(
  db: DbQueries,
  id: number,
  running: boolean,
  at = new Date().toISOString(),
  waiting?: SourcesWaiting,
): Promise<AdminSource | null> {
  const row = await db.one<ListedRow>(`SELECT ${LISTED_COLUMNS} FROM ${LISTED_FROM} WHERE s.id = ?`, [id]);
  if (!row) return null;
  const { counts, latest } = await extrasOf(db, [id]);
  const reason = waiting ? ((await waiting([toSourceRecord(row)])).get(id) ?? null) : null;
  return toAdminSource(row, at, counts.get(id), latest.get(id) ?? null, running, true, reason);
}

/**
 * Runs, newest first (CT's AdminRunsQuery: a source, kinds, statuses), a page at a time; the cursor is the last run's
 * id. `before` (a run id) is v2.0's cursor and still read.
 */
export async function adminRuns(
  db: DbQueries,
  options: { sourceId?: number; limit: number; before?: number; kind?: readonly string[]; status?: readonly string[]; cursor?: string },
): Promise<{ items: AdminRun[]; nextCursor?: string }> {
  const where = new Where();
  if (options.sourceId !== undefined) where.add('r.source_id = @sourceId', { sourceId: options.sourceId });
  if (options.kind?.length) where.add("s.kind = ANY(string_to_array(@kinds, ','))", { kinds: listParam(options.kind) });
  if (options.status?.length) where.add("r.status = ANY(string_to_array(@statuses, ','))", { statuses: listParam(options.status) });
  let before = options.before;
  if (options.cursor !== undefined) {
    before = Number(options.cursor);
    if (!Number.isSafeInteger(before) || before <= 0) throw validationFailed(STALE_CURSOR);
  }
  if (before !== undefined) where.add('r.id < @before', { before });
  const rows = await db.all<RunRow>(
    `SELECT r.*, s.kind AS kind, s.name AS name, s.config AS config, ${RUN_IMPORT_COLUMNS} FROM job_source_runs r ` +
      `JOIN job_sources s ON s.id = r.source_id ${RUN_IMPORT_JOIN} ` + // v35 INT-A: the run's import
      `${where.sql()} ORDER BY r.id DESC LIMIT @limit`,
    { ...where.params, limit: options.limit + 1 } as SqlParams,
  );
  const items = rows.slice(0, options.limit).map(toAdminRun);
  return rows.length > options.limit ? { items, nextCursor: String(items[items.length - 1]!.id) } : { items };
}

/** The run history's query (CT's AdminRunsQuery) for adminRuns. */
export const runsOptionsOf = (query: AdminRunsQuery) => ({
  sourceId: query.sourceId,
  kind: query.kind,
  status: query.status,
  cursor: query.cursor,
  limit: query.limit,
});

const RUN_SQL =
  `SELECT r.*, s.kind AS kind, s.name AS name, s.config AS config, ${RUN_IMPORT_COLUMNS} FROM job_source_runs r ` +
  `JOIN job_sources s ON s.id = r.source_id ${RUN_IMPORT_JOIN} WHERE r.id = ?`; // v35 INT-A: the run's import

function toRunDetail(row: RunRow): AdminRunDetail {
  return { ...toAdminRun(row), log: (row.log ?? '').split('\n').filter(Boolean) };
}

export async function adminRun(db: DbQueries, id: number): Promise<AdminRunDetail | null> {
  const row = await db.one<RunRow>(RUN_SQL, [id]);
  return row ? toRunDetail(row) : null;
}

// ------------------------------------------------------------------------------------------------- bulk actions

/** The words of a bulk row that was skipped. */
const SKIP_WORDS = {
  gone: 'That source no longer exists.',
  already_enabled: 'It is on already.',
  already_disabled: 'It is off already.',
  never_run: 'This kind of source is never run, so it cannot be turned on or run.',
  robots: "Its host's robots.txt does not allow it (or has not been read yet).",
  not_scheduled: 'This kind of source runs only by hand (Run now).',
  /** v30 FIX-A: its company opted out (the words are MSG_INGEST_SOURCE_OPTED_OUT's, given by the route). */
  opted_out: "This source's company asked TailorIT not to read its jobs.",
  /** v31 RUNS: an admin paused it (the words are MSG_INGEST_SOURCE_PAUSED's, given by the route). */
  paused: 'It is paused: continue it first.',
  /** v35 ADMIN (PLAN H6): an import's record (Admin › Import lists it). */
  import: 'An import is not a source: Admin › Import lists it.',
  /** v38 FIX-C (SP v38 FIXES-38 D3): a career site on a host TailorIT never reads (SuccessFactors, Phenom, JobDiva). */
  never_read: "TailorIT doesn't read this platform, so this career site can't be turned on.",
} as const;

/**
 * Admin › Sources' bulk actions on up to 100 sources (12 §9.8): turn them on or off, or make them due now (the worker
 * runs them next, under each host's pace; nothing runs in the request). One UPDATE per action, each row answered.
 */
export async function bulkSources(
  db: DbQueries,
  body: AdminSourcesBulkBody,
  now: string,
  words: BulkWords, // v31 RUNS, v36 SOURCES: one object (an opt-out's and a pause's words)
  admin: EnablingAdmin | null, // v36 SOURCES: the admin an enable records
): Promise<{ ids: number[]; body: AdminSourcesBulkResult }> {
  const optedOutWords = words.optedOut ?? SKIP_WORDS.opted_out;
  const pausedWords = words.paused ?? SKIP_WORDS.paused;
  const offWords = words.off ?? (constantDefault('MSG_INGEST_SOURCE_OFF') as string); // v36 SOURCES
  // v30 FIX-A (SEC-2, BEH-3): enable and run now skip a source whose company opted out (opt-out-gate.ts).
  const optedOut = body.action === 'disable' ? new Set<number>() : await optedOutSources(db, body.ids);
  const rows = new Map(
    (await db.all<SourceRow>("SELECT * FROM job_sources WHERE id = ANY(CAST(string_to_array(?, ',') AS bigint[]))", [body.ids.join(',')])).map(
      (row) => [row.id, toSourceRecord(row)],
    ),
  );
  const results: AdminSourcesBulkResult['results'] = [];
  const chosen: number[] = [];
  for (const id of body.ids) {
    const source = rows.get(id);
    // v36 SOURCES: `disabled` (it is off) says MSG_INGEST_SOURCE_OFF's words, as Run now's refusal does.
    const skip = (why: keyof typeof SKIP_WORDS | 'disabled') =>
      results.push({
        id,
        outcome: 'skipped',
        message: why === 'opted_out' ? optedOutWords : why === 'paused' ? pausedWords : why === 'disabled' ? offWords : SKIP_WORDS[why],
      });
    if (!source) skip('gone');
    else if ((JOB_SOURCE_IMPORT_KINDS as readonly string[]).includes(source.kind)) skip('import'); // v35 ADMIN
    else if (optedOut.has(id) && !(body.action === 'enable' && source.enabled)) skip('opted_out');
    else if (body.action === 'enable') {
      if (UNRUN_KINDS.includes(source.kind)) skip('never_run');
      else if (source.enabled) skip('already_enabled');
      else if (source.kind === 'career_site' && neverReadPlatformOfHost(source.host ?? '')) skip('never_read'); // v38 FIX-C (D3)
      else chosen.push(id);
    } else if (body.action === 'disable') {
      if (!source.enabled) skip('already_disabled');
      else chosen.push(id);
    } else if (UNRUN_KINDS.includes(source.kind)) skip('never_run');
    else if (!SCHEDULED_KINDS.includes(source.kind)) skip('not_scheduled');
    else if (!source.enabled) skip('disabled');
    else if (!termsAllowReads(source.termsStatus)) {
      // v37 FIX-37B (E8): by its status, in Run now's words.
      results.push({ id, outcome: 'skipped', message: words.terms?.(source.termsStatus) ?? fillTerms(source.termsStatus) });
    }
    else if (!['allowed', 'not_applicable'].includes(source.robotsStatus ?? '')) skip('robots');
    else if (source.pausedAt) skip('paused'); // v31 RUNS: run now waits for Continue
    else chosen.push(id);
  }
  let changed = chosen;
  if (chosen.length > 0 && body.action === 'enable') {
    // v36 SOURCES (PLAN S1): through the one writer of "on", recording the admin; a source turned on is due at once (a
    // kind the worker runs). One turned on meanwhile is on already. v37 TRANSFER: its host's row at the route's pace.
    const turned = new Set(await enableSources(db, chosen, admin, now, words.hostPaceMs));
    for (const id of chosen) {
      results.push(turned.has(id) ? { id, outcome: 'done' } : { id, outcome: 'skipped', message: SKIP_WORDS.already_enabled });
    }
    changed = chosen.filter((id) => turned.has(id));
  } else if (chosen.length > 0) {
    const sql =
      body.action === 'disable'
        ? "UPDATE job_sources SET enabled = false, updated_at = @now WHERE id = ANY(CAST(string_to_array(@ids, ',') AS bigint[]))"
        : "UPDATE job_sources SET next_run_at = CAST(@now AS timestamptz) WHERE id = ANY(CAST(string_to_array(@ids, ',') AS bigint[]))";
    await db.run(sql, { now, ids: chosen.join(',') });
    for (const id of chosen) results.push({ id, outcome: 'done' });
  }
  // In the request's order.
  const order = new Map(body.ids.map((id, index) => [id, index]));
  results.sort((a, b) => order.get(a.id as number)! - order.get(b.id as number)!);
  const counts: AdminSourcesBulkResult['counts'] = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  return { ids: changed, body: { results, counts } };
}

// v35 ADMIN (PLAN H6) ------------------------------------------------------------------------------- "all" and imports

/** The words a bulk change gives a skipped row (the route's constants: an opt-out's, a pause's). */
export interface BulkWords {
  optedOut?: string;
  paused?: string;
  /** v36 SOURCES: run now on a source that is off (MSG_INGEST_SOURCE_OFF). */
  off?: string;
  /** v37 TRANSFER (PLAN T3): the pace of a host row an enable adds (INGEST_HOST_MIN_INTERVAL_MS; its default if absent). */
  hostPaceMs?: number;
  /** v37 FIX-37B (E8): run now on a source whose terms don't allow reading (MSG_INGEST_SOURCE_TERMS by its status). */
  terms?: (status: string | null | undefined) => string;
}

/** v37 FIX-37B (E8): MSG_INGEST_SOURCE_TERMS' default words for a status (a route passes the admin's words). */
function fillTerms(status: string | null | undefined): string {
  return String(constantDefault('MSG_INGEST_SOURCE_TERMS')).replace('{status}', termsParams(status).status);
}

/**
 * What Enable all / Disable all would change for the filter (Admin › Sources' confirm): every match, those off that may
 * run (no kind that never runs, no company that opted out) and those on.
 */
export async function countSourcesAll(db: DbQueries, filter: AdminSourcesFilter): Promise<AdminSourcesAllCount> {
  const where = sourcesWhere(filter);
  const row = await db.one<{ total: number; can_enable: number; can_disable: number }>(
    `SELECT count(*) AS total,
       count(*) FILTER (WHERE NOT s.enabled AND NOT (s.kind = ANY(string_to_array(@unrun, ','))) AND NOT ${optedOutSourceSql('s')}) AS can_enable,
       count(*) FILTER (WHERE s.enabled) AS can_disable
     FROM job_sources s ${where.sql()}`,
    { ...where.params, unrun: UNRUN_KINDS.join(',') } as SqlParams,
  );
  return { total: row?.total ?? 0, canEnable: row?.can_enable ?? 0, canDisable: row?.can_disable ?? 0 };
}

/**
 * Turns on, or off, the sources of `next`'s pages (ids in ascending order after the last one), ADMIN_BULK_MAX at a time,
 * each page through bulkSources (its skips: on already, a kind that never runs, an opt-out, an import's record): one
 * result for them all. Answers the ids it changed too (for the audit's count).
 */
async function bulkInPages(
  db: DbQueries,
  action: AdminSourceAllAction,
  now: string,
  words: BulkWords,
  admin: EnablingAdmin | null, // v36 SOURCES
  next: (after: number) => Promise<number[]>,
): Promise<{ result: AdminSourcesAllResult; changed: number }> {
  const counts: AdminSourcesAllResult['counts'] = {};
  let matched = 0;
  let changed = 0;
  for (let after = 0; ; ) {
    const ids = await next(after);
    if (ids.length === 0) break;
    matched += ids.length;
    const done = await bulkSources(db, { action, ids }, now, words, admin);
    changed += done.ids.length;
    for (const [outcome, n] of Object.entries(done.body.counts)) {
      const key = outcome as keyof AdminSourcesAllResult['counts'];
      counts[key] = (counts[key] ?? 0) + (n ?? 0);
    }
    after = ids[ids.length - 1]!;
    if (ids.length < ADMIN_BULK_MAX) break;
  }
  return { result: { action, matched, counts }, changed };
}

/**
 * POST /api/admin/sources/all: Enable all / Disable all for every source the filter matches now (see countSourcesAll),
 * in pages of ADMIN_BULK_MAX by id.
 */
export async function sourcesAll(
  db: DbQueries,
  action: AdminSourceAllAction,
  filter: AdminSourcesFilter,
  now: string,
  words: BulkWords,
  admin: EnablingAdmin | null, // v36 SOURCES: the admin an enable records
): Promise<{ result: AdminSourcesAllResult; changed: number }> {
  return bulkInPages(db, action, now, words, admin, async (after) => {
    const where = sourcesWhere(filter);
    where.add('s.id > @after', { after });
    const rows = await db.all<{ id: number }>(`SELECT s.id FROM job_sources s ${where.sql()} ORDER BY s.id LIMIT @limit`, {
      ...where.params,
      limit: ADMIN_BULK_MAX,
    } as SqlParams);
    return rows.map((row) => row.id);
  });
}

/** Whether a run is an import's (its source a csv or json record); null when there is no such run. */
export async function importRunOf(db: DbQueries, runId: number): Promise<{ sourceId: number; kind: SourceKind } | null> {
  const row = await db.one<{ source_id: number; kind: SourceKind }>(
    'SELECT r.source_id, s.kind FROM job_source_runs r JOIN job_sources s ON s.id = r.source_id WHERE r.id = ?',
    [runId],
  );
  return row ? { sourceId: row.source_id, kind: row.kind } : null;
}

/**
 * GET /api/admin/runs/:id/sources: the board sources an import's run found (job_source_import_finds), the ones it made
 * first, then by name, each as it is now with why it waits; null when there is no such run.
 */
export async function runSources(db: DbQueries, runId: number, waiting?: SourcesWaiting): Promise<AdminRunSources | null> {
  if (!(await importRunOf(db, runId))) return null;
  const rows = await db.all<SourceRow & { created: boolean; company_name: string | null }>(
    `SELECT s.*, f.created, c.name AS company_name FROM job_source_import_finds f JOIN job_sources s ON s.id = f.source_id
     LEFT JOIN companies c ON c.id = s.company_id WHERE f.run_id = ? ORDER BY f.created DESC, lower(s.name), s.id`,
    [runId],
  );
  const records = rows.map(toSourceRecord);
  const reasons = waiting ? await waiting(records) : new Map<number, JobSourceWaiting>();
  const items: AdminRunSource[] = rows.map((row, i) => {
    const source = records[i]!;
    return {
      id: source.id,
      kind: source.kind as AdminRunSource['kind'],
      kindLabel: kindLabelOf(source.kind, source.config),
      name: source.name,
      host: source.host ?? null,
      companyName: row.company_name ?? (typeof source.config.companyName === 'string' ? source.config.companyName : null),
      enabled: source.enabled,
      created: row.created === true,
      discoveredVia: (source.discoveredVia ?? null) as AdminRunSource['discoveredVia'],
      openJobs: source.openJobs ?? 0,
      lastRunAt: source.lastRunAt,
      pausedAt: source.pausedAt ?? null,
      waiting: reasons.get(source.id) ?? null,
      waitingForAdmin: isWaitingForAdmin(source), // v36 INT-A: Sources found says so, as Admin › Sources does
    };
  });
  const made = items.filter((item) => item.created);
  return { items, total: items.length, created: made.length, createdEnabled: made.filter((item) => item.enabled).length };
}

/**
 * POST /api/admin/runs/:id/sources {action}: Enable all / Disable all of the sources an import's run made (the ones it
 * found there already stay as they are: each is switched on its own row); null when there is no such run.
 */
export async function runSourcesAll(
  db: DbQueries,
  runId: number,
  action: AdminSourceAllAction,
  now: string,
  words: BulkWords,
  admin: EnablingAdmin | null, // v36 SOURCES: the admin an enable records
): Promise<{ result: AdminSourcesAllResult; changed: number } | null> {
  if (!(await importRunOf(db, runId))) return null;
  return bulkInPages(db, action, now, words, admin, async (after) =>
    (
      await db.all<{ source_id: number }>(
        'SELECT source_id FROM job_source_import_finds WHERE run_id = ? AND created AND source_id > ? ORDER BY source_id LIMIT ?',
        [runId, after, ADMIN_BULK_MAX],
      )
    ).map((row) => row.source_id),
  );
}
// end v35 ADMIN
