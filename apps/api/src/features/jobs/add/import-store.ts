import {
  csvSafeCell,
  DAY_MS,
  emptyJobImportCounts,
  HOUR_MS,
  JOB_IMPORT_COUNT_OF,
  JOB_IMPORT_DOWNLOAD_COLUMNS,
  JOB_IMPORT_NOTICE_MIN_ROWS,
  JOB_IMPORT_RESULTS_PAGE,
  JOB_IMPORT_ROW_RESULT_LABEL,
  JOB_IMPORT_ROW_RESULTS,
  JOB_VERIFY_REASON_ADMIN_TEXT,
  JOB_VERIFY_REASON_MESSAGE,
  JOB_VERIFY_REASONS,
  JobImportSheetRefSchema,
  JobRowDetailsSchema,
  toCsvText,
  type JobImportCounts,
  type JobImportDetail,
  type JobImportList,
  type JobImportRowOutcome,
  type JobImportRowReason,
  type JobImportRowResult,
  type JobImportSheetRef,
  type JobImportSummary,
  type JobImportWay,
  type JobRowDetails,
  type JobRowMapping,
  type JobVerifyReason,
  type Limit,
} from '@tailorit/shared';
import { isProfileKey, linkAs } from '@tailorit/shared/sharing';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries, DbTx } from '../../../core/db/types';
import { refuse } from '../../../core/http/refuse';
import { findSheetSource, findSourceRecord, insertSource } from '../../ingest/sources';
import type { SourceRecord } from '../../ingest/types';
import { notify } from '../../notifications/index';
import type { ParsedImportRow } from './import-rows';
import { rowProblemText } from './import-rows';
import { listedSql } from './verification'; // v35 FIX-STORE (ux M4): a row's heldIn; v37 REVIEW (R5): listedSql
import { holdOf, laneOfHost } from '../../ingest/hosts'; // v37 FIX-REV (REVIEW361-ux L9); v37 INT-2a: laneOfHost
import { timeForPeople } from './verdict'; // v37 FIX-REV (L9)
import type { LinkQueueOrigin } from './queue';

// v35 IMPORT (SP v35 PLAN.md H1, H2, H6): an import and its rows (migration 0057's job_imports, job_import_rows).
//   - startImport: the import, each row's result known now (no link, not a job link, a site never read, a repeat; a
//     person's rows over the day's room), and every other row queued for TailorIT's read (job_link_queue, with the row's
//     fields: `details`; a person's: their profile and grant), all in one transaction. An admin's import is one run on
//     Runs (job_source_runs, trigger `upload`): a paste or one link under the csv source "Pasted links" ({pasted: true}),
//     a file under the file's csv/json source, a Google Sheet under its tab's source (H6: those sources are no sources
//     to anyone: Sources hides the import kinds).
//   - recordQueueOutcome: a queued link read (queue.ts settle): every import row waiting on it gets its result; an import
//     whose rows are all read finishes (finishImports): its counts in job_imports.counts and its run's import_summary,
//     and a person's import of more than JOB_IMPORT_NOTICE_MIN_ROWS rows tells them (the jobs notices' kind).
//   - importDetail / listAdminImports: the results views (GET /api/admin/imports/:runId, GET /api/jobs/imports/:id,
//     GET /api/admin/imports), with "Download these rows" (the rows that need a title and company, formula-safe).
// v35 FIX-STORE (the final review's S4, D2, D3, D9; the fix list's items 9 and 10): the results views carry counts and a
// page of rows, "Download these rows" is a CSV of its own (needsDetailsCsv); a profile's imports are listed
// (listUserImports); a row's words are its viewer's (outcomeMessage); a lake's queued link becomes the import's
// (queueRows); the queue row's done and its rows' results are one transaction (recordQueueOutcome), with a repair for
// rows left waiting (repairImportRows); one import's rows are written under its lock (lockImportsOf).
// A person's rows are counted per person (v3.3: the person acting on a shared profile), FREE_/PAID_JOB_IMPORT_ROWS_PER_DAY
// in any 24 hours, checked under their lock.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The csv source an admin's pasted links and one-link imports run under (Sources hides it with every import kind). */
export const PASTED_SOURCE_NAME = 'Pasted links';
/** Rows one insert writes. */
const CHUNK = 500;

/** A source found by kind and name, else made (disabled: no import source is ever run on a schedule). */
async function sourceNamed(t: DbQueries, kind: 'csv' | 'json', name: string, config: Record<string, unknown>, at: string): Promise<SourceRecord> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await findSourceRecord(t, kind, name);
    if (found) return found;
    const made = await insertSource(t, { kind, name, config }, at);
    if (made) return made;
  }
  throw new Error('import: its source could not be made');
}

/** The source of an admin's pasted links and one-link imports. */
export function pastedLinksSource(t: DbQueries, at: string): Promise<SourceRecord> {
  return sourceNamed(t, 'csv', PASTED_SOURCE_NAME, { pasted: true }, at);
}

/** The source of an admin's file import: one per file name, as v3.0 named them (a .json file's kind is json). */
export async function fileImportSource(t: DbQueries, fileName: string, at: string): Promise<SourceRecord> {
  const name = fileName.slice(0, 100) || 'import.csv';
  const kind = /\.json$/i.test(name) ? 'json' : 'csv';
  const found = await findSourceRecord(t, kind, name);
  // A file import never shares a Google Sheet import's source (v3.0's rule): another name then.
  if (found && found.config.sheet) return sourceNamed(t, kind, `${name.slice(0, 90)} (file)`, { file: null, fileName: name }, at);
  return found ?? sourceNamed(t, kind, name, { file: null, fileName: name }, at);
}

/** The source of an admin's Google Sheet import: the tab's (config.sheet), else a new one named for it. */
export async function sheetImportSource(t: DbQueries, sheet: JobImportSheetRef, name: string, at: string): Promise<SourceRecord> {
  const found = await findSheetSource(t, sheet.spreadsheetId, sheet.gid);
  if (found) return found;
  const config = {
    sheet: {
      spreadsheetId: sheet.spreadsheetId,
      gid: sheet.gid,
      tabTitle: sheet.tabTitle,
      spreadsheetTitle: sheet.spreadsheetTitle,
      url: sheet.url,
      headerRow: sheet.headerRow,
      postedAt: null,
      readAt: at,
    },
  };
  for (let n = 1; n < 50; n += 1) {
    const candidate = n === 1 ? name.slice(0, 100) : `${name.slice(0, 92)} (${n})`;
    if (await findSourceRecord(t, 'csv', candidate)) continue;
    const made = await insertSource(t, { kind: 'csv', name: candidate, config }, at);
    if (made) return made;
  }
  throw new Error('import: the sheet source could not be made');
}

/** The run of an admin's import (H6): finished at once (its rows' reads are the import's), its rows as fetched. */
async function insertImportRun(t: DbQueries, sourceId: number, rows: number, log: string, at: string): Promise<number> {
  const row = await t.one<{ id: number }>(
    `INSERT INTO job_source_runs(source_id, trigger, status, started_at, finished_at, fetched, log)
     VALUES (?, 'upload', 'succeeded', ?, ?, ?, ?) RETURNING id`,
    [sourceId, at, at, rows, log.slice(0, 20_000)],
  );
  await t.run('UPDATE job_sources SET last_run_at = ?, last_success_at = ?, last_status = ?, updated_at = ? WHERE id = ?', [
    at,
    at,
    'succeeded',
    at,
    sourceId,
  ]);
  return Number(row!.id);
}

export interface StartImportInput {
  kind: 'admin' | 'user';
  way: JobImportWay;
  name: string;
  rows: readonly ParsedImportRow[];
  /** Who imports (an admin; a person: the one acting); null for a v3.4 route's run (no one named). */
  actorId: string | null;
  origin: Extract<LinkQueueOrigin, 'admin' | 'import' | 'sheets'>;
  /** An admin's import: the source its run is under, or the run it belongs to (an adapter's run: the v3.4 routes). */
  source?: SourceRecord;
  runId?: number;
  /** A person's import: the profile it saves to (the owner), the grant it acts under, the day's rows. */
  userId?: string;
  grantId?: string | null;
  dayLimit?: Limit;
  /** Import again: the sheet's tab and the mapping. */
  config?: { sheet?: JobImportSheetRef | null; mapping?: JobRowMapping | null } | null;
}

export interface StartedImport {
  importId: number;
  runId: number | null;
  /** Rows queued for a read. */
  queued: number;
  /** A person's rows left in their day after this import (null: no limit). */
  rowsLeftToday: number | null;
  /** Rows over the day's room were refused: when the room comes back. */
  retryAt: string | null;
}

/** A person's rows counted in the last 24 hours, and when the oldest of them leaves the window. In their lock. */
async function rowsToday(t: DbQueries, actorId: string, now: Date): Promise<{ used: number; oldestAt: string | null }> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const row = await t.one<{ used: number; oldest: string | null }>(
    `SELECT COALESCE(sum(counted), 0)::int AS used, min(created_at) FILTER (WHERE counted > 0) AS oldest
     FROM job_imports WHERE kind = 'user' AND actor_id = ? AND created_at > ?`,
    [actorId, since],
  );
  return { used: Number(row?.used ?? 0), oldestAt: row?.oldest ? new Date(row.oldest).toISOString() : null };
}

/** The hours until the day's room comes back (at least 1). */
function hoursUntil(at: string | null, now: Date): number {
  if (!at) return 24;
  return Math.max(1, Math.ceil((Date.parse(at) + DAY_MS - now.getTime()) / HOUR_MS));
}

/** Starts an import (see the top). A person with no room left today is refused (429) before anything is written. */
export async function startImport(deps: Deps, input: StartImportInput): Promise<StartedImport> {
  const now = deps.now();
  const at = now.toISOString();
  const started = await deps.db.tx(
    async (t) => {
      let room = Number.POSITIVE_INFINITY;
      let retryAt: string | null = null;
      let rowsLeftToday: number | null = null;
      const pending = input.rows.filter((row) => row.result === null);
      if (input.kind === 'user') {
        if (input.actorId === null) throw new Error('import: a person import names who imports');
        await t.lockPerson(input.actorId);
        const limit = input.dayLimit ?? null;
        if (limit !== null) {
          const today = await rowsToday(t, input.actorId, now);
          room = Math.max(0, limit - today.used);
          const hours = hoursUntil(today.oldestAt, now);
          if (room === 0 && pending.length > 0) {
            throw refuse(deps, 'rate_limited', 'MSG_JOB_IMPORT_DAY_LIMIT', { limit, hours }, { retryAfterSeconds: hours * 3600 });
          }
          if (pending.length > room) retryAt = new Date(Date.parse(today.oldestAt ?? at) + DAY_MS).toISOString();
          rowsLeftToday = Math.max(0, room - pending.length);
        }
      }
      let runId = input.runId ?? null;
      let sourceId = input.source?.id ?? null;
      if (input.kind === 'admin' && runId === null) {
        if (!input.source) throw new Error('import: an admin import needs its source');
        runId = await insertImportRun(t, input.source.id, input.rows.length, `${input.name}: ${input.rows.length} rows.`, at);
      }
      if (input.kind === 'admin' && runId !== null && sourceId === null) {
        const run = await t.one<{ source_id: number }>('SELECT source_id FROM job_source_runs WHERE id = ?', [runId]);
        sourceId = run ? Number(run.source_id) : null;
      }
      const config = input.config ? { sheet: input.config.sheet ?? null, mapping: input.config.mapping ?? null } : null;
      const made = await t.one<{ id: number }>(
        `INSERT INTO job_imports(kind, way, name, run_id, source_id, user_id, actor_id, grant_id, rows, config, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          input.kind,
          input.way,
          input.name.slice(0, 200) || 'Import',
          runId,
          sourceId,
          input.kind === 'user' ? input.userId! : null,
          input.actorId,
          input.kind === 'user' ? (input.grantId ?? null) : null,
          input.rows.length,
          config ? JSON.stringify(config) : null,
          at,
        ],
      );
      const importId = Number(made!.id);
      // The rows to read, in order, while the day has room; the others fail now.
      const toQueue: ParsedImportRow[] = [];
      const settled = new Map<number, { result: JobImportRowResult; reason: JobImportRowReason | null }>();
      for (const row of input.rows) {
        if (row.result !== null) settled.set(row.row, { result: row.result, reason: row.reason });
        else if (toQueue.length < room) toQueue.push(row);
        else settled.set(row.row, { result: 'failed', reason: 'day_limit' });
      }
      // The queue's batch: the run's (v3.1's run:<id>, the old progress view's), else the import's.
      const batchId = runId !== null ? `run:${runId}` : `import:${importId}`;
      const queueIds = await queueRows(t, importId, batchId, toQueue, input, sourceId, at);
      for (let start = 0; start < input.rows.length; start += CHUNK) {
        const chunk = input.rows.slice(start, start + CHUNK);
        await t.run(
          `INSERT INTO job_import_rows(import_id, row_number, url, url_key, details, result, reason, repeats_row, queue_id)
           VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          chunk.flatMap((row) => {
            const known = settled.get(row.row);
            const details = cleanDetails(row.details);
            return [
              importId,
              row.row,
              row.url,
              row.urlKey,
              details ? JSON.stringify(details) : row.url === null && row.linkCell ? JSON.stringify({ link: row.linkCell }) : null,
              known?.result ?? 'queued',
              known?.reason ?? null,
              row.repeatsRow,
              known ? null : (queueIds.get(row.urlKey ?? '') ?? null),
            ];
          }),
        );
      }
      await t.run('UPDATE job_imports SET counted = ? WHERE id = ?', [input.kind === 'user' ? toQueue.length : 0, importId]);
      return { importId, runId, queued: toQueue.length, rowsLeftToday, retryAt };
    },
    { label: 'start an import' },
  );
  await finishImports(deps as AppDeps, [started.importId]);
  return started;
}

/** A row's fields as stored: validated by the shared contract (an empty object is none). */
function cleanDetails(details: JobRowDetails): JobRowDetails | null {
  const parsed = JobRowDetailsSchema.safeParse(details);
  if (!parsed.success) return null;
  return Object.keys(parsed.data).length > 0 ? parsed.data : null;
}

/** Queues the rows' links (one open row per link and profile; a link already waiting keeps its row). Answers each key's row. */
async function queueRows(
  t: DbTx,
  importId: number,
  batchId: string,
  rows: readonly ParsedImportRow[],
  input: StartImportInput,
  sourceId: number | null,
  at: string,
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  const userId = input.kind === 'user' ? input.userId! : null;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    // v35 FIX-STORE (the final review's D2): a link the free_tailor lake queued and has not read yet becomes this
    // import's (its origin, source and who queued it): the lake's read (addJobByLink) never writes an import row's
    // result. Every other open row keeps its own; a link read already (done) gets a row of its own.
    const inserted = await t.all<{ id: number; url_key: string }>(
      `INSERT INTO job_link_queue(url, url_key, host, origin, batch_id, source_id, added_by, next_at, created_at, details, user_id, grant_id, import_id)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT (url_key, (COALESCE(for_job_id, 0)), (COALESCE(user_id, ''))) WHERE state <> 'done'
       DO UPDATE SET details = COALESCE(job_link_queue.details, excluded.details),
         import_id = COALESCE(job_link_queue.import_id, excluded.import_id),
         origin = CASE WHEN job_link_queue.origin = 'ft_lake' THEN excluded.origin ELSE job_link_queue.origin END,
         source_id = CASE WHEN job_link_queue.origin = 'ft_lake' THEN excluded.source_id ELSE job_link_queue.source_id END,
         added_by = CASE WHEN job_link_queue.origin = 'ft_lake' THEN excluded.added_by ELSE job_link_queue.added_by END
       RETURNING id, url_key`,
      chunk.flatMap((row) => {
        const details = cleanDetails(row.details);
        return [
          row.url,
          row.urlKey,
          row.host,
          input.origin,
          batchId,
          sourceId,
          input.actorId,
          at,
          at,
          details ? JSON.stringify(details) : null,
          userId,
          input.kind === 'user' ? (input.grantId ?? null) : null,
          importId,
        ];
      }),
    );
    for (const row of inserted) ids.set(row.url_key, Number(row.id));
  }
  return ids;
}

// ------------------------------------------------------------------------------------------------- the reads' results

/** What TailorIT's read of a queued link came to, for the import rows waiting on it. */
export interface QueueOutcome {
  result: Exclude<JobImportRowResult, 'queued' | 'working' | 'repeated'>;
  reason: JobImportRowReason | null;
  jobId: number | null;
  /** The job waits for an admin (held): the queue row's v3.1 state says so. */
  held?: boolean;
}

/** An import row waiting for a read. */
interface WaitingRow {
  import_id: number;
  row_number: number;
}

/**
 * v35 FIX-STORE (the final review's D9): takes the row lock of each import of `rows` (as finishImports does), in id
 * order, so two reads of one import's rows on two hosts decide "Repeats row N" one after the other. Answers the ids.
 */
async function lockImportsOf(t: DbQueries, rows: readonly WaitingRow[]): Promise<number[]> {
  const ids = [...new Set(rows.map((row) => Number(row.import_id)))].sort((a, b) => a - b);
  if (ids.length > 0) await t.all(`SELECT id FROM job_imports WHERE id IN (${t.dialect.list(ids.length)}) ORDER BY id FOR UPDATE`, ids);
  return ids;
}

/**
 * Writes one waiting row's result (in the caller's transaction, under its import's lock): a second row of one import
 * that reached a job the import already reposted, added or found is `repeated` (H5: one repost per import).
 */
async function writeRowOutcome(t: DbQueries, row: WaitingRow, outcome: QueueOutcome): Promise<void> {
  let result: JobImportRowResult = outcome.result;
  let repeatsRow: number | null = null;
  if (outcome.jobId !== null && (outcome.result === 'reposted' || outcome.result === 'added' || outcome.result === 'known')) {
    const earlier = await t.one<{ row_number: number }>(
      `SELECT row_number FROM job_import_rows WHERE import_id = ? AND job_id = ? AND row_number <> ?
         AND result IN ('added', 'reposted', 'known') ORDER BY row_number LIMIT 1`,
      [row.import_id, outcome.jobId, row.row_number],
    );
    if (earlier) {
      result = 'repeated';
      repeatsRow = Number(earlier.row_number);
    }
  }
  await t.run(
    `UPDATE job_import_rows SET result = ?, reason = ?, job_id = ?, repeats_row = COALESCE(?, repeats_row), queue_id = NULL
     WHERE import_id = ? AND row_number = ? AND result IN ('queued', 'working')`,
    [result, outcome.reason, outcome.jobId, repeatsRow, row.import_id, row.row_number],
  );
}

/**
 * A queued link read (queue.ts settle): every import row waiting on it gets its result, then the imports whose rows are
 * all read finish. v35 FIX-STORE (the final review's D3): `markDone` (the queue row's own done state) is written in the
 * same transaction, so a stop between the two never leaves a done queue row with rows waiting on it. Never throws: when
 * that transaction fails, the queue row is marked done alone (a link is never read again for it) and the queue pass's
 * repair (repairImportRows) gives its rows their result.
 */
export async function recordQueueOutcome(
  deps: AppDeps,
  queueId: number,
  outcome: QueueOutcome,
  markDone?: (t: DbQueries) => Promise<unknown>,
): Promise<void> {
  let touched: number[];
  try {
    touched = await deps.db.tx(
      async (t) => {
        if (markDone) await markDone(t);
        const rows = await t.all<WaitingRow>(
          "SELECT import_id, row_number FROM job_import_rows WHERE queue_id = ? AND result IN ('queued', 'working') ORDER BY import_id, row_number",
          [queueId],
        );
        const ids = await lockImportsOf(t, rows);
        for (const row of rows) await writeRowOutcome(t, row, outcome);
        return ids;
      },
      { label: 'import rows read' },
    );
  } catch (error) {
    deps.log.warn('[job-imports] a read link could not be written to its import', error instanceof Error ? error.name : 'unknown');
    if (markDone) {
      await markDone(deps.db).catch((again: unknown) =>
        deps.log.warn('[job-imports] a read link could not be marked done', again instanceof Error ? again.name : 'unknown'),
      );
    }
    return;
  }
  try {
    await finishImports(deps, touched);
  } catch (error) {
    deps.log.warn('[job-imports] an import could not be finished', error instanceof Error ? error.name : 'unknown');
  }
}

/** v35 FIX-STORE (D3): the import rows one repair takes. */
export const IMPORT_REPAIR_BATCH = 500;

/** A done queue row's result as an import row's (the repair's): what v3.1's state, reason and job say. */
export function outcomeOfDoneRow(
  queue: { state: string | null; result: string | null; reason: string | null; job_id: number | null } | null,
  details: unknown,
): QueueOutcome {
  const gone: QueueOutcome = { result: 'failed', reason: 'unavailable', jobId: null };
  if (!queue || queue.state !== 'done') return gone;
  const reason = queue.reason !== null && (JOB_VERIFY_REASONS as readonly string[]).includes(queue.reason) ? (queue.reason as JobVerifyReason) : null;
  const jobId = queue.job_id === null ? null : Number(queue.job_id);
  switch (queue.result) {
    case 'published':
      return jobId !== null ? { result: 'known', reason: null, jobId } : gone;
    case 'waiting_admin':
      return jobId !== null ? { result: 'known', reason: 'waiting_review', jobId } : gone;
    case 'private_unverified':
      if (jobId !== null) return { result: 'added_private', reason, jobId };
      break;
    case 'refused':
      if (reason === 'closed') return { result: 'closed', reason, jobId: null };
      break;
    default:
      return gone;
  }
  // Nothing stored: a row with no title and company needs them; any other could not be imported.
  if (reason === null) return gone;
  const fixable = reason !== 'unreadable_host' && reason !== 'invalid_link' && reason !== 'opted_out' && reason !== 'rejected' && reason !== 'terms'; // v37 FIX-37B
  const parsed = JobRowDetailsSchema.safeParse(jsonOf(details) ?? {});
  const named = parsed.success && Boolean(parsed.data.title?.trim()) && Boolean(parsed.data.company?.trim());
  return fixable && !named ? { result: 'needs_details', reason, jobId: null } : { result: 'failed', reason, jobId: null };
}

/**
 * v35 FIX-STORE (the final review's D2, D3): the link queue's repair (each pass, at most once a minute: queue.ts). An
 * import row still waiting whose queue row is done (a stop between two writes; a lake's read of a link an import took
 * over while it was being read) or gone (pruned) gets that row's result (outcomeOfDoneRow; gone: Couldn't import,
 * unavailable), then its import finishes. Answers the rows repaired.
 */
export async function repairImportRows(deps: AppDeps, limit = IMPORT_REPAIR_BATCH): Promise<number> {
  const rows = await deps.db.all<WaitingRow & { details: unknown; state: string | null; result: string | null; reason: string | null; job_id: number | null }>(
    `SELECT ir.import_id, ir.row_number, ir.details, q.state, q.result, q.reason, q.job_id
     FROM job_import_rows ir LEFT JOIN job_link_queue q ON q.id = ir.queue_id
     WHERE ir.result IN ('queued', 'working') AND (q.id IS NULL OR q.state = 'done')
     ORDER BY ir.import_id, ir.row_number LIMIT ?`,
    [limit],
  );
  if (rows.length === 0) return 0;
  const touched = await deps.db.tx(
    async (t) => {
      const ids = await lockImportsOf(t, rows);
      for (const row of rows) await writeRowOutcome(t, row, outcomeOfDoneRow(row.state === null ? null : row, row.details));
      return ids;
    },
    { label: 'import rows repaired' },
  );
  deps.log.warn(`[job-imports] ${rows.length} import row(s) whose link was read without them got its result`);
  await finishImports(deps, touched);
  return rows.length;
}

/** An import's counts, from its rows. */
async function countsOf(db: DbQueries, importId: number): Promise<JobImportCounts> {
  const rows = await db.all<{ result: JobImportRowResult; n: number }>(
    'SELECT result, count(*)::int AS n FROM job_import_rows WHERE import_id = ? GROUP BY result',
    [importId],
  );
  const counts = emptyJobImportCounts();
  for (const row of rows) {
    const key = JOB_IMPORT_COUNT_OF[row.result];
    if (!key) continue;
    counts[key] += Number(row.n);
    counts.rows += Number(row.n);
  }
  return counts;
}

/**
 * Finishes the imports among `importIds` whose rows are all read (see the top): their counts, their run's summary, the
 * person's notice. Each import finishes once (finished_at set under its row's lock).
 */
export async function finishImports(deps: AppDeps, importIds: readonly number[]): Promise<void> {
  for (const importId of new Set(importIds)) {
    const done = await deps.db.tx(
      async (t) => {
        const head = await t.one<{ finished_at: string | null; run_id: number | null; kind: string; actor_id: string | null; way: string; name: string }>(
          'SELECT finished_at, run_id, kind, actor_id, way, name FROM job_imports WHERE id = ? FOR UPDATE',
          [importId],
        );
        if (!head || head.finished_at !== null) return null;
        const waiting = await t.one("SELECT 1 FROM job_import_rows WHERE import_id = ? AND result IN ('queued', 'working') LIMIT 1", [importId]);
        if (waiting) return null;
        const counts = await countsOf(t, importId);
        const at = nowIso(deps);
        await t.run('UPDATE job_imports SET counts = ?, finished_at = ? WHERE id = ?', [JSON.stringify(counts), at, importId]);
        if (head.run_id !== null) {
          const summary = { importId, way: head.way, name: head.name, startedBy: head.actor_id, finishedAt: at, ...counts };
          await t.run('UPDATE job_source_runs SET import_summary = ? WHERE id = ?', [JSON.stringify(summary), head.run_id]);
        }
        return { counts, kind: head.kind };
      },
      { label: 'finish an import' },
    );
    if (done && done.kind === 'user' && done.counts.rows > JOB_IMPORT_NOTICE_MIN_ROWS) await noticeImportFinished(deps, importId, done.counts);
  }
}

/** The finished import's notice to whoever imported (the actor; on a shared profile, there): once. Never throws. */
async function noticeImportFinished(deps: AppDeps, importId: number, counts: JobImportCounts): Promise<void> {
  try {
    const row = await deps.db.one<{ actor_id: string | null; user_id: string; grant_id: string | null }>(
      'UPDATE job_imports SET notified_at = ? WHERE id = ? AND notified_at IS NULL RETURNING actor_id, user_id, grant_id',
      [nowIso(deps), importId],
    );
    if (!row) return;
    const to = row.actor_id ?? row.user_id;
    // On a shared profile the notice opens the owner's Jobs there (v33 SHARE-6's link form).
    const link = row.grant_id && to !== row.user_id && isProfileKey(row.grant_id) ? linkAs('/jobs', row.grant_id) : '/jobs';
    await notify(deps, to, {
      kind: 'job_verified',
      title: 'MSG_NOTIFY_JOB_IMPORT_TITLE',
      body: [],
      bodyExtra: importNoticeBody(deps, counts), // v35 FIX-STORE (ux M2, M3)
      params: { rows: counts.rows },
      link,
      dedupeKey: `import:${importId}`,
    });
  } catch (error) {
    deps.log.warn('[job-imports] an import notice could not be written', error instanceof Error ? error.name : 'unknown');
  }
}

/** v35 FIX-STORE (ux M2, M3): the notice's parts, in the results' order, each with its one snake_case placeholder. */
const IMPORT_NOTICE_PARTS = [
  ['added', 'MSG_NOTIFY_JOB_IMPORT_PART_ADDED'],
  ['known', 'MSG_NOTIFY_JOB_IMPORT_PART_KNOWN'],
  ['review', 'MSG_NOTIFY_JOB_IMPORT_PART_REVIEW'],
  ['needs_details', 'MSG_NOTIFY_JOB_IMPORT_PART_NEEDS_DETAILS'],
  ['closed', 'MSG_NOTIFY_JOB_IMPORT_PART_CLOSED'],
  ['failed', 'MSG_NOTIFY_JOB_IMPORT_PART_FAILED'],
] as const;

/**
 * v35 FIX-STORE (the ux review's M2, M3): the finished import's notice body, counted as its results are (the results'
 * chips): Added (added), Already in TailorIT (known, and a repost), To review (review, and a person's own job waiting for
 * review: added_private), Needs a title and company, Closed, Couldn't import (failed, and a repeated row). Only the parts
 * above 0, joined: "8 jobs waiting for review, 4 need a title and company."
 */
export function importNoticeBody(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, counts: JobImportCounts): string {
  const values: Record<(typeof IMPORT_NOTICE_PARTS)[number][0], number> = {
    added: counts.added,
    known: counts.known + counts.reposted,
    review: counts.review + counts.addedPrivate,
    needs_details: counts.needsDetails,
    closed: counts.closed,
    failed: counts.failed + counts.repeated,
  };
  const constants = constantsOf(deps);
  const parts = IMPORT_NOTICE_PARTS.filter(([name]) => values[name] > 0).map(([name, key]) => constants.message(key, { [name]: values[name] }));
  return parts.length > 0 ? `${parts.join(', ')}.` : '';
}

// ------------------------------------------------------------------------------------------------- the views

interface ImportRow {
  id: number;
  kind: 'admin' | 'user';
  way: JobImportWay;
  name: string;
  run_id: number | null;
  user_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  config: unknown;
  counts: unknown;
  rows: number;
  created_at: string;
  finished_at: string | null;
}

const IMPORT_COLUMNS = `i.id, i.kind, i.way, i.name, i.run_id, i.user_id, i.actor_id, i.config, i.counts, i.rows, i.created_at, i.finished_at,
  COALESCE(NULLIF(u.name, ''), u.email) AS actor_name`;

function jsonOf(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function summaryOf(db: DbQueries, row: ImportRow, showStarter: boolean): Promise<JobImportSummary> {
  const config = jsonOf(row.config);
  const sheet = JobImportSheetRefSchema.safeParse(config?.sheet);
  const mapping = jsonOf(config?.mapping);
  const counts = row.finished_at ? { ...emptyJobImportCounts(), ...(jsonOf(row.counts) ?? {}) } : await countsOf(db, Number(row.id));
  return {
    id: Number(row.id),
    runId: row.run_id === null ? null : Number(row.run_id),
    way: row.way,
    name: row.name,
    startedBy: showStarter ? row.actor_name : null,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    counts: counts as JobImportCounts,
    sheet: sheet.success ? sheet.data : null,
    mapping: mapping as JobImportSummary['mapping'],
  };
}

/**
 * A row's result in words: its result's, and its reason's when it has one. v35 FIX-STORE (the fix list's item 10): in
 * the words its viewer needs: an admin's import says why TailorIT could not read a link the way Admin › Review does
 * (JOB_VERIFY_REASON_ADMIN_TEXT: what to do about it), a person's import the way Add job does. The web shows `message`.
 */
function outcomeMessage(
  deps: Deps,
  row: { result: JobImportRowResult; reason: string | null; repeats_row: number | null; url: string | null; held_in: JobImportHeldIn },
  admin: boolean,
): string {
  const constants = constantsOf(deps);
  const label = JOB_IMPORT_ROW_RESULT_LABEL[row.result];
  // v35 FIX-STORE (decision 8): an admin's Added row whose read waits in Review › New jobs says so.
  if (admin && row.result === 'added' && row.held_in === 'new_job') return constants.message('MSG_JOB_IMPORT_ROW_ADDED_HELD');
  if (row.result === 'repeated' && row.repeats_row !== null) return constants.message('MSG_JOB_IMPORT_ROW_REPEATS', { row: Number(row.repeats_row) });
  if (row.reason === 'waiting_review') return constants.message('MSG_JOB_IMPORT_ROW_WAITING');
  if (row.reason === 'day_limit') return `${label}: ${constants.message('MSG_JOB_IMPORT_ROW_OVER_DAY', { hours: 24 })}`;
  if (row.reason === 'no_link') return `${label}: ${constants.message('MSG_JOB_IMPORT_ROW_NO_LINK')}`;
  if (row.result === 'failed' && (row.reason === 'unreadable_host' || row.reason === 'terms')) {
    let host = '';
    try {
      host = row.url ? new URL(row.url).hostname : '';
    } catch {
      host = '';
    }
    // v37 FIX-37B (E8): a board whose terms say no: "TailorIT doesn't read <host>: its terms say no."
    return rowProblemText(deps, { result: 'failed', reason: row.reason, repeatsRow: null, host }) ?? label;
  }
  if (row.reason && (JOB_VERIFY_REASONS as readonly string[]).includes(row.reason) && row.result !== 'added' && row.result !== 'reposted') {
    const reason = row.reason as JobVerifyReason;
    return `${label}: ${admin ? JOB_VERIFY_REASON_ADMIN_TEXT[reason] : constants.message(JOB_VERIFY_REASON_MESSAGE[reason])}`;
  }
  return label;
}

/**
 * v37 FIX-REV (REVIEW361-ux L9): the words of each waiting row whose read is due later (the link queue reads it again
 * after a site's pause, or after a failure for now): why and when, "Waiting: Workday asked us to slow down; TailorIT
 * reads the link again after 8:03 PM Pacific Time." while the site (all of Workday; v37 INT-2a: any lane, by its
 * platform's name) asked TailorIT to slow down, else
 * "Waiting: TailorIT reads the link again after 8:03 PM Pacific Time.". A row due now stays "Waiting". By row number.
 */
async function waitingTexts(
  deps: Deps,
  rows: ReadonlyArray<{ row_number: number; result: JobImportRowResult; next_at: string | Date | null; queue_host: string | null }>,
): Promise<Map<number, string>> {
  const texts = new Map<number, string>();
  const now = deps.now();
  const holds = new Map<string, Awaited<ReturnType<typeof holdOf>>>();
  const constants = constantsOf(deps);
  const label = JOB_IMPORT_ROW_RESULT_LABEL.queued;
  for (const row of rows) {
    if (row.result !== 'queued' || row.next_at === null) continue;
    const next = new Date(row.next_at).toISOString();
    if (Date.parse(next) <= now.getTime()) continue;
    const host = row.queue_host ?? '';
    if (host && !holds.has(host)) holds.set(host, await holdOf(deps.db, host, now.toISOString()));
    const hold = host ? holds.get(host) : null;
    // v37 INT-2a: any lane of FIX-LANE's registry (Workday's in v3.6.1) says its platform's name, and its breaker reads
    // as a slow-down, as Workday's did.
    const lane = host ? laneOfHost(host) : null;
    const slowDown = hold && (hold.reason === 'retry_after' || (lane !== null && hold.reason === 'breaker'));
    const until = hold && Date.parse(hold.until) > Date.parse(next) ? hold.until : next;
    const time = timeForPeople(deps, until);
    const why = slowDown
      ? constants.message('MSG_JOB_IMPORT_ROW_PAUSED', { site: lane?.name ?? host, time })
      : constants.message('MSG_JOB_IMPORT_ROW_LATER', { time });
    texts.set(Number(row.row_number), `${label}: ${why}`);
  }
  return texts;
}

/** v35 FIX-STORE (the ux review's M4): where a row's job waits for an admin's review now (JobImportRowOutcome.heldIn). */
type JobImportHeldIn = 'unverified' | 'new_job' | null;

/**
 * The SQL of a results row's `heldIn` (row `r`), read from the reviews as they are now, not from its result: a pending
 * New jobs review of its job (a held read, or a rejected one a re-import reopened: FIX-PIPE's D4) is `new_job`; else a
 * note Review › Couldn't verify lists (verification.ts listedSql, as the list: v37 REVIEW (R5) an admin import's rows
 * whatever EXT_NEW_PAGE_JOBS_REVIEW says) is `unverified`; else null.
 */
function heldInSql(deps: Deps): string {
  const listed = `WHEN EXISTS (SELECT 1 FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE v.job_id = r.job_id AND ${listedSql(deps)}) THEN 'unverified'`;
  return `CASE WHEN r.job_id IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM job_reviews hr WHERE hr.job_id = r.job_id AND hr.kind = 'new_job' AND hr.state = 'pending') THEN 'new_job'
    ${listed} ELSE NULL END`;
}

/** Which import a results route names: an admin's by its run, a person's by its id and the profile in use. */
export type ImportWhere = { runId: number } | { importId: number; userId: string };

/** The import a results route names (a person's only on their own profile), or undefined. */
function importOf(deps: Deps, where: ImportWhere): Promise<ImportRow | undefined> {
  return 'runId' in where
    ? deps.db.one<ImportRow>(`SELECT ${IMPORT_COLUMNS} FROM job_imports i LEFT JOIN users u ON u.id = i.actor_id WHERE i.run_id = ?`, [where.runId])
    : deps.db.one<ImportRow>(
        `SELECT ${IMPORT_COLUMNS} FROM job_imports i LEFT JOIN users u ON u.id = i.actor_id WHERE i.id = ? AND i.kind = 'user' AND i.user_id = ?`,
        [where.importId, where.userId],
      );
}

/**
 * An import with a page of its rows (after row `cursor`). v35 FIX-STORE (the final review's S4): its counts only, never
 * the rows that need a title and company (every page and every poll carried them: up to SHEET_MAX_ROWS descriptions);
 * those are "Download these rows" (needsDetailsCsv).
 */
export async function importDetail(
  deps: Deps,
  where: ImportWhere,
  cursor?: string,
  results: readonly JobImportRowResult[] = [], // v35 IMPORTWEB: the rows of these results only (the results' chips)
): Promise<JobImportDetail | null> {
  const row = await importOf(deps, where);
  if (!row) return null;
  const summary = await summaryOf(deps.db, row, row.kind === 'admin');
  const after = cursor && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0;
  const rows = await deps.db.all<{
    row_number: number;
    url: string | null;
    details: unknown;
    result: JobImportRowResult;
    reason: string | null;
    repeats_row: number | null;
    job_id: number | null;
    held_in: JobImportHeldIn;
    next_at: string | Date | null; // v37 FIX-REV (L9): its queued read's next time
    queue_host: string | null;
  }>(
    `SELECT r.row_number, r.url, r.details, r.result, r.reason, r.repeats_row, r.job_id, ${heldInSql(deps)} AS held_in,
       q.next_at, q.host AS queue_host
     FROM job_import_rows r LEFT JOIN job_link_queue q ON q.id = r.queue_id
     WHERE r.import_id = ? AND r.row_number > ?${results.length > 0 ? ` AND r.result IN (${deps.db.dialect.list(results.length)})` : ''}
     ORDER BY r.row_number LIMIT ?`,
    [row.id, after, ...results, JOB_IMPORT_RESULTS_PAGE + 1],
  );
  const page = rows.slice(0, JOB_IMPORT_RESULTS_PAGE);
  const waiting = await waitingTexts(deps, page); // v37 FIX-REV (L9)
  const items: JobImportRowOutcome[] = page.map((item) => {
    const details = jsonOf(item.details) ?? {};
    const text = (key: string) => (typeof details[key] === 'string' ? (details[key] as string) : null);
    return {
      row: Number(item.row_number),
      link: item.url,
      result: (JOB_IMPORT_ROW_RESULTS as readonly string[]).includes(item.result) ? item.result : 'failed',
      reason: (item.reason as JobImportRowReason | null) ?? null,
      repeatsRow: item.repeats_row === null ? null : Number(item.repeats_row),
      jobId: item.job_id === null ? null : Number(item.job_id),
      heldIn: item.held_in === 'unverified' || item.held_in === 'new_job' ? item.held_in : null,
      title: text('title'),
      company: text('company'),
      message: waiting.get(Number(item.row_number)) ?? outcomeMessage(deps, item, row.kind === 'admin'),
    };
  });
  return {
    ...summary,
    rows: items,
    nextCursor: rows.length > JOB_IMPORT_RESULTS_PAGE ? String(page[page.length - 1]!.row_number) : null,
  };
}

/** v35 FIX-STORE (S4): the rows one read of "Download these rows" takes at a time. */
const DOWNLOAD_PAGE = 500;

/** "tailorit-import-<name>-needs-details.csv": the import's name in lower-case ASCII words (the web's file name until v3.5's fixes). */
export function needsDetailsFileName(importName: string): string {
  const slug = importName
    .toLowerCase()
    .replace(/\.(csv|tsv|txt|json|xlsx)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `tailorit-import-${slug || 'rows'}-needs-details.csv`;
}

/**
 * v35 FIX-STORE (the final review's S4): "Download these rows" (GET .../needs-details.csv): the rows that need a title
 * and company as a CSV to fill in and import again (JOB_IMPORT_DOWNLOAD_COLUMNS; every cell formula-safe, csvSafeCell,
 * and written by toCsvText), read a page at a time. A file over JOB_IMPORT_DOWNLOAD_MAX_MB is refused (413) before it
 * is all read. Null when there is no such import (or it is not the profile's).
 */
export async function needsDetailsCsv(deps: Deps, where: ImportWhere): Promise<{ fileName: string; text: string } | null> {
  const row = await importOf(deps, where);
  if (!row) return null;
  const maxMb = constantsOf(deps).get('JOB_IMPORT_DOWNLOAD_MAX_MB');
  const maxBytes = maxMb * 1024 * 1024;
  const tooBig = () => refuse(deps, 'file_too_large', 'MSG_JOB_IMPORT_DOWNLOAD_TOO_BIG', { max: maxMb });
  const cells: string[][] = [];
  // Each cell's bytes, a separator and a pair of quotes: what toCsvText writes at least (quotes inside it double).
  let bytes = 0;
  let after = 0;
  for (;;) {
    const page = await deps.db.all<{ row_number: number; url: string | null; details: unknown }>(
      "SELECT row_number, url, details FROM job_import_rows WHERE import_id = ? AND result = 'needs_details' AND row_number > ? ORDER BY row_number LIMIT ?",
      [row.id, after, DOWNLOAD_PAGE],
    );
    for (const item of page) {
      const details = jsonOf(item.details) ?? {};
      const text = (key: string) => (typeof details[key] === 'string' ? (details[key] as string) : '');
      const line = [item.url ?? text('link'), text('company'), text('title'), text('description'), text('rate'), text('location')].map(csvSafeCell);
      bytes += line.reduce((sum, cell) => sum + Buffer.byteLength(cell) + 3, 0);
      if (bytes > maxBytes) throw tooBig();
      cells.push(line);
    }
    if (page.length < DOWNLOAD_PAGE) break;
    after = Number(page[page.length - 1]!.row_number);
  }
  const text = toCsvText(JOB_IMPORT_DOWNLOAD_COLUMNS, cells);
  if (Buffer.byteLength(text) > maxBytes) throw tooBig();
  return { fileName: needsDetailsFileName(row.name), text };
}

/** GET /api/admin/imports: Recent imports, newest first (a page after import `cursor`). */
export async function listAdminImports(deps: Deps, cursor?: string, limit = 20): Promise<{ items: JobImportSummary[]; nextCursor: string | null }> {
  const before = cursor && /^\d{1,18}$/.test(cursor) ? Number(cursor) : null;
  const rows = await deps.db.all<ImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM job_imports i LEFT JOIN users u ON u.id = i.actor_id
     WHERE i.kind = 'admin' ${before !== null ? 'AND i.id < ?' : ''} ORDER BY i.id DESC LIMIT ?`,
    before !== null ? [before, limit + 1] : [limit + 1],
  );
  const page = rows.slice(0, limit);
  const items: JobImportSummary[] = [];
  for (const row of page) items.push(await summaryOf(deps.db, row, true));
  return { items, nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
}

/**
 * v35 FIX-STORE (the fix list's item 9): GET /api/jobs/imports: a profile's imports, newest first (a page of `limit`
 * after import `cursor`), so Add job shows the latest import on every device. Who imported is not named (as GET
 * /api/jobs/imports/:id).
 */
export async function listUserImports(deps: Deps, userId: string, limit: number, cursor?: string): Promise<JobImportList> {
  const before = cursor && /^\d{1,18}$/.test(cursor) ? Number(cursor) : null;
  const rows = await deps.db.all<ImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM job_imports i LEFT JOIN users u ON u.id = i.actor_id
     WHERE i.kind = 'user' AND i.user_id = ? ${before !== null ? 'AND i.id < ?' : ''} ORDER BY i.id DESC LIMIT ?`,
    before !== null ? [userId, before, limit + 1] : [userId, limit + 1],
  );
  const page = rows.slice(0, limit);
  const items: JobImportSummary[] = [];
  for (const row of page) items.push(await summaryOf(deps.db, row, false));
  return { items, nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
}

/** A person's import summary (their own; null when it is not theirs). */
export async function userImportSummary(deps: Deps, importId: number, userId: string): Promise<JobImportSummary | null> {
  const row = await deps.db.one<ImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM job_imports i LEFT JOIN users u ON u.id = i.actor_id WHERE i.id = ? AND i.kind = 'user' AND i.user_id = ?`,
    [importId, userId],
  );
  return row ? summaryOf(deps.db, row, false) : null;
}

/** An admin import's summary by its id. */
export async function adminImportSummary(deps: Deps, importId: number): Promise<JobImportSummary | null> {
  const row = await deps.db.one<ImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM job_imports i LEFT JOIN users u ON u.id = i.actor_id WHERE i.id = ? AND i.kind = 'admin'`,
    [importId],
  );
  return row ? summaryOf(deps.db, row, true) : null;
}

/** The person's day: the rows left (null: no limit). */
export async function rowsLeftToday(deps: Deps, actorId: string, limit: Limit): Promise<number | null> {
  if (limit === null) return null;
  const today = await rowsToday(deps.db, actorId, deps.now());
  return Math.max(0, limit - today.used);
}
