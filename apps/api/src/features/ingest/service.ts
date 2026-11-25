import { randomUUID } from 'node:crypto';
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import { AppError, notFound, validationFailed } from '../../core/http/errors';
import { assertNewReadAllowed, NewReadRefusedError } from '../../core/http/identity';
import { OutboundRefusedError } from '../../core/http/outbound';
import { refuse } from '../../core/http/refuse';
import { dayOf, ensureDayPartition, JOB_POSTINGS_RAW } from '../../core/db/pg/maintenance/partitions';
import type { DbClient, DbTx } from '../../core/db/types';
import { ADAPTERS } from './adapters/index';
import { missingOutsideKey } from './adapters/define'; // v30 S4
import { createHostGate, createRobotsStore, laneOfHost, lanePauseOf, laneSql, laneWaitingCodeOf } from './hosts'; // v37 FIX-LANE: the lane helpers
import { createIngestHttp, HostHeldError, IngestHttpError, type IngestHttp, type TurnPriority } from './http';
import { readLake } from './lake';
import { normalizeCompany, sourceHashOf, storedSourceJobId } from './normalize';
import { assertRobotsAllow, RobotsRefusal, useRobotsStore } from './robots';
import { holdsSavedJob, NEW_READ_KIND_OF, nextScheduleOf, type RunOutcome } from './scheduler';
import { sourceOptedOut } from './opt-out-gate'; // v30 FIX-A
import { CareerPagesOffError, careerPagesOn } from './career/switch'; // v30 FIX-A (REQ-5)
import { adminRun, getSourceRecord, kindLabelOf, termsAllowReads, termsParams, type AdminRunDetail } from './sources'; // v37 FIX-37B: terms
import {
  BATCH_SIZE,
  createIngestStore,
  emptyCounts,
  type BatchItem,
  type IngestStore,
  type UpsertCounts,
} from './store';
import {
  IngestError,
  SCHEDULED_KINDS,
  SourceNotFoundError,
  UNRUN_KINDS,
  type ListingValidators,
  type RawPosting,
  type RunStatus,
  type RunTrigger,
  type SourceAdapter,
  type SourceKind,
  type SourceRecord,
} from './types';
import { clearUnverifiedOf } from './unverified';
import { lockNewCompanyNames } from '../companies/resolve';
import { notifyRunFinished } from '../notifications/emitters'; // v31 NOTIFY
import { PAUSABLE_TRIGGERS, pausedBy, RunPausedError, RUNS_PAUSED_KEY, runsPaused } from './pause-state'; // v31 RUNS
import { isLinkListKind, queueLinksOfRun } from '../jobs/add/imports'; // v31 LINK

// Runs sources: one run per source at a time. Every run is a job_source_runs row with its counts and a log. Missing
// postings are closed only after a successful, complete listing.
//
// v3.0 D2-C: one run per source at a time is the source's lease in the database, not only this process's memory: a
// run starts with one conditional UPDATE that takes the source in the transaction that adds its run row, so two
// processes (or two requests) starting one source at once start one run and the other answers 409.
//
// v30 S1-API (12-job-sourcing.md §9; 11 §5.3; D2-C's wave-2 note):
//   - the lease is `lease_until` (now + INGEST_LEASE_MINUTES), renewed while the run goes on and cleared by its finish,
//     so a crashed process's lease runs out without a restart; recoverInterrupted fails the runs whose lease ran out,
//     and at start those of its own process kind (the API: Run now, uploads, the seed at start; the worker: schedule);
//   - the API process no longer runs the schedule: the ingest worker's due queue does (scheduler.ts, worker.ts), and
//     the API keeps the runs a person starts (Run now, imports) and Add job's reads, at most PARALLEL_RUNS at once;
//   - every read goes through one client per identity, paced per host for every process (hosts.ts: crawl_hosts), with
//     robots.txt before each read (robots.ts, site_robots), Retry-After and bot-check holds, backoff and the breaker
//     (http.ts). v2.0's kinds keep today's identity (INGEST_USER_AGENT); a NEW kind of read (scheduler.ts
//     NEW_READ_KIND_OF) runs only when assertNewReadAllowed allows it, with BOT_USER_AGENT;
//   - a listing answers a conditional GET with the last complete run's validators: a 304 is a `not_modified` run
//     (nothing upserted or closed; the source's live links are verified as of now);
//   - v30 FIX-A (REV-BEH BEH-4): the lease has an owner (job_sources.lease_owner, a random id per run). Renewals, the
//     close of missing postings and the finish act only while the lease is still the run's own: a run whose lease ran
//     out and was taken over (the machine slept, a renewal failed) stops, writes only its own run row (failed,
//     `interrupted`) and touches nothing on the source, so it never gives back or rewrites a newer run's lease;
//   - each run records its requests, bytes, HTTP status and an error code, and its finish sets the source's tier,
//     cadence and next run (scheduler.ts nextScheduleOf), its open jobs, its last complete and last change times, its
//     validators, and turns off a source that keeps failing or whose board is gone; a complete run brings its jobs
//     back from unverified (unverified.ts, projectJob in the same transaction).
//
// v31 RUNS (docs/design/v3.1/22-runs-pause.md, PLAN D5): an admin pauses every run, one source or one run (pause.ts).
// Each process looks every RUN_STOP_POLL_MS for stop requests on its own runs (checkStops: job_source_runs.
// stop_requested_at, or a paused source or every run paused for a run the schedule or Run now started) and aborts them
// with RunPausedError. The run stops at its next safe point: its read's abort signal, or between two batches of
// BATCH_SIZE postings. It ends `paused`: the batches it saved stay, it closes nothing (no markMissing), its source keeps
// its failures, tier, validators and verified links, and gives its lease back. The schedule and Run now start no run
// of a paused source, or while every run is paused (MSG_INGEST_RUNS_PAUSED, MSG_INGEST_SOURCE_PAUSED); Continue starts
// the source again from the top (upserts are idempotent).

/** The runs this process (the API: Run now, imports) makes at once; the worker has its own limit per host. */
export const PARALLEL_RUNS = 2;
const MAX_LOG_LINES = 2000;
const MAX_FAILURE_LINES = 200;
/** job_source_runs' column widths (the baseline's CHECKs): a longer log keeps its start and its closing lines. */
const RUN_LOG_MAX_CHARS = 20_000;
const RUN_ERROR_MAX_CHARS = 2_000;
/** The closing lines (the counts, the closes, the outcome) a cut log keeps. */
const RUN_LOG_TAIL_LINES = 3;
/** A running source's lease is renewed this many times per INGEST_LEASE_MINUTES. */
const LEASE_RENEWALS = 3;
/**
 * A listing DB-INGEST's markMissing judges suspect (12 §8.2) is read again this soon, and closes nothing meanwhile.
 * v30 FIX-A (BEH-1): once: a second suspect listing in a row (job_sources.suspect_at) waits for the tier's cadence.
 */
export const SUSPECT_REREAD_MS = 60 * 60_000;
/** The process kinds' run triggers, for recoverInterrupted at each one's start. */
export const API_TRIGGERS: readonly RunTrigger[] = ['manual', 'upload', 'startup'];
export const WORKER_TRIGGERS: readonly RunTrigger[] = ['schedule'];
/**
 * v36 SOURCES (SP v36 PLAN S5): the kinds that run while off: an admin's import record (csv, json: its upload, or Run
 * now on it) and the dev-only demo jobs (`seed`). No admin turns them on: they are no source Admin › Sources lists, and
 * neither reads an outside host. Every other source runs (schedule, Run now, a run's Continue) only once an admin
 * turned it on.
 */
export const RUNS_WHILE_OFF_KINDS: readonly SourceKind[] = ['csv', 'json', 'seed'];

export interface SourceTestResult {
  ok: boolean;
  message: string;
  count: number;
  samples: string[];
  companyName: string | null;
}

export interface StartedRun {
  runId: number;
  /** Resolves with the finished run; never rejects. */
  done: Promise<AdminRunDetail>;
}

export interface RunOptions {
  /** Skips the two-at-a-time limit (uploads, the seed, the worker's own runs: it limits them per host). */
  bypassSlots?: boolean;
  /**
   * Runs once the source is leased and before it is read, outside any transaction (an import stores its file and
   * config here, so a second import of the source never touches them while the first holds it). A throw fails the run.
   */
  prepare?: () => Promise<void>;
}

export interface IngestService {
  /**
   * The client of today's reads (INGEST_USER_AGENT): v2.0's kinds, Add job, the re-checks. v37 LANE (SP v37 PLAN W5):
   * in the API process (readForPeople) its turns on a lane are a waiting person's: Add job, the extension's add and From
   * page, Add by link and MCP add go ahead of the worker's background reads on the Workday lane.
   */
  readonly http: IngestHttp;
  /** The client of the new kinds of read (BOT_USER_AGENT; they run only when assertNewReadAllowed allows them). */
  readonly botHttp: IngestHttp;
  /** The store the runs use (store.ts). */
  readonly store: IngestStore;
  /**
   * v37 LANE (W5): this process serves people (the API: ingest's start hook): `http`'s turns are interactive from now
   * on. The worker never calls it (its reads are background). botHttp's (runs, Run now, Test) stay background.
   */
  readForPeople(): void;
  /**
   * Leases the source, starts a run of it and answers with the run's id (the run goes on in the background). Throws 404
   * for an unknown source and 409 when it is running (here or in another process).
   */
  run(sourceId: number, trigger: RunTrigger, options?: RunOptions): Promise<StartedRun>;
  /** A run of the source is going in this process (the console's "Running"). */
  isRunning(sourceId: number): boolean;
  /** The sources this process runs now. */
  runningIds(): number[];
  /** Reads a source without saving anything (the admin's Test button). */
  test(kind: SourceKind, config: Record<string, unknown>): Promise<SourceTestResult>;
  /**
   * Marks runs left running as failed and gives their sources back: those whose lease ran out, and (at a process's
   * start) those of `triggers` (default: every trigger), never one this process runs now.
   */
  recoverInterrupted(options?: { triggers?: readonly RunTrigger[] }): Promise<number>;
  /**
   * v31 RUNS: looks now for pause requests on this process's runs and stops them at their next safe point (each process
   * also looks every RUN_STOP_POLL_MS while it runs any). Answers how many it stopped.
   */
  checkStops(): Promise<number>;
  /** Stops every run (shutdown). */
  stop(): Promise<void>;
}

declare module '../../core/context' {
  interface AppServices {
    /** Job ingestion (work package J1). */
    ingest?: IngestService;
  }
}

/** The ingest service, or a 503 a person can read. */
export function requireIngest(deps: Pick<AppDeps, 'services'>): IngestService {
  const service = deps.services.ingest;
  if (!service) throw new AppError('internal', 'Job ingestion is not set up on this server.');
  return service;
}

class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];
  constructor(size: number) {
    this.free = size;
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    const release = () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    };
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(release);
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error('stopped'));
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** A run's log: one line per event, "HH:MM:SS text". */
class RunLog {
  readonly lines: string[] = [];
  constructor(private readonly now: () => Date) {}
  add(text: string): void {
    if (this.lines.length >= MAX_LOG_LINES) return;
    const time = this.now().toISOString().slice(11, 19);
    this.lines.push(`${time} ${text.replace(/\s+/g, ' ').trim()}`);
  }
  /** The log as stored: at most RUN_LOG_MAX_CHARS, its start and its closing lines when it is longer (v3.0 PG-C). */
  text(): string {
    const all = this.lines.join('\n');
    if (all.length <= RUN_LOG_MAX_CHARS) return all;
    const tail = this.lines.slice(-RUN_LOG_TAIL_LINES).map((line) => line.slice(0, 500));
    // "HH:MM:SS " of the last line, then the note.
    const cut = `${this.lines[this.lines.length - 1]!.slice(0, 9)}More lines were not kept.`;
    const room = RUN_LOG_MAX_CHARS - [cut, ...tail].join('\n').length - 1;
    const head = this.lines.slice(0, -RUN_LOG_TAIL_LINES).join('\n').slice(0, Math.max(0, room));
    const whole = head.lastIndexOf('\n');
    return [...(whole > 0 ? [head.slice(0, whole)] : []), cut, ...tail].join('\n');
  }
}

/** Errors whose words a person may read as they are. */
function plainError(error: unknown): error is Error {
  return (
    error instanceof IngestError ||
    error instanceof IngestHttpError ||
    error instanceof AppError ||
    error instanceof RobotsRefusal ||
    error instanceof OutboundRefusedError
  );
}

function messageOf(error: unknown): string {
  if (plainError(error)) return error.message;
  return 'Something went wrong while reading this source. The details are in the server log.';
}

/** job_source_runs.error_code for a failed run: what stopped it, in a word an admin can filter on. */
function errorCodeOf(error: unknown): string {
  if (error instanceof LeaseLostError) return 'interrupted';
  if (error instanceof HostHeldError) return 'held';
  if (error instanceof NewReadRefusedError) return 'identity';
  if (error instanceof OutboundRefusedError) return 'refused';
  if (error instanceof RobotsRefusal) return `robots_${error.reason}`;
  if (error instanceof SourceNotFoundError) return 'not_found';
  if (error instanceof IngestHttpError) return error.status > 0 ? `http_${error.status}` : 'unreachable';
  if (error instanceof IngestError) return 'invalid';
  return 'error';
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Takes the source's lease: one statement, so of two takers at once one changes the row and the other none. A lease
 * that ran out (a crashed process's) is taken over.
 */
const LEASE_SQL = `UPDATE job_sources SET last_run_at = CAST(@now AS timestamptz), last_status = 'running', lease_until = CAST(@until AS timestamptz),
    lease_owner = CAST(@owner AS uuid)
  WHERE id = @id AND (lease_until IS NULL OR lease_until < CAST(@now AS timestamptz))`;
/**
 * v37 FIX-LANE (SP v37 FIXES-361 F8, PLAN W6): whether another source of the lane `@lane` (a Workday source for
 * Workday's) holds an unexpired lease (it runs), for every way a run starts (the schedule, Run now, an import): one
 * source of a lane at a time. Read under LANE_LEASE_LOCK, so two starts at once never both find the lane free. Built at
 * each use (hosts.ts laneSql reads the lane registry).
 */
const otherLaneRunSql = () => `SELECT 1 AS found FROM job_sources o
  WHERE o.id <> @id AND o.lease_until > CAST(@now AS timestamptz) AND ${laneSql('o.host')} = @lane LIMIT 1`;
/**
 * v37 FIX-LANE (F8): the transaction lock that takes a lane's source's lease one at a time (pg_advisory_xact_lock, with
 * the lane's key hashed as its second key: each lane its own lock).
 */
export const LANE_LEASE_LOCK = 7_370_062;

/** v30 FIX-A: a run whose lease another run took over (BEH-4): it stops, and writes only its own run row. */
export class LeaseLostError extends IngestError {
  constructor() {
    super('This run lost its lease on the source (it ran out, and another run took the source over): it stopped, and changed nothing on the source.');
    this.name = 'LeaseLostError';
  }
}
const INSERT_RUN_SQL = "INSERT INTO job_source_runs(source_id, trigger, status, started_at) VALUES (?, ?, 'running', ?) RETURNING id";

/**
 * v31 RUNS: which of this process's runs must stop now: asked to (stop_requested_at), or (a run the schedule or Run now
 * started) its source or every run is paused.
 */
const STOP_SQL = `SELECT r.id FROM job_source_runs r JOIN job_sources s ON s.id = r.source_id
  WHERE r.id = ANY(CAST(string_to_array(@ids, ',') AS bigint[])) AND r.status = 'running'
    AND (r.stop_requested_at IS NOT NULL
      OR (r.trigger = ANY(string_to_array(@pausable, ','))
        AND (s.paused_at IS NOT NULL OR EXISTS (SELECT 1 FROM app_settings WHERE key = @key))))`;

/** A run's tally of its reads (job_source_runs.requests, bytes_fetched, http_status). */
interface ReadTally {
  requests: number;
  bytes: number;
  firstStatus: number | null;
}

/** `http` counting each request a run makes, and the bytes and first status of its answers. */
function countingHttp(http: IngestHttp, tally: ReadTally): IngestHttp {
  return {
    getJson(url, options = {}) {
      tally.requests += 1;
      return http.getJson(url, {
        ...options,
        meta: (meta) => {
          tally.bytes += meta.bytes;
          tally.firstStatus ??= meta.status;
          options.meta?.(meta);
        },
      });
    },
  };
}

export interface IngestServiceOptions {
  http?: IngestHttp;
  /** The new kinds' client (default: one with BOT_USER_AGENT, or `http` when a test gives one). */
  botHttp?: IngestHttp;
  adapters?: Partial<Record<SourceKind, SourceAdapter>>;
}

/**
 * A client for one identity: paced and held per host for every process, robots.txt before each read. v37 LANE:
 * `priority`, whose turns its requests take on a lane (read at each request).
 */
function clientFor(deps: AppDeps, userAgent: string, priority?: () => TurnPriority): IngestHttp {
  const constants = () => constantsOf(deps);
  let client: IngestHttp | null = null;
  const http = createIngestHttp({
    userAgent,
    timeoutMs: deps.config.ingest.httpTimeoutMs,
    minIntervalMs: () => constants().get('INGEST_HOST_MIN_INTERVAL_MS'),
    maxBytes: () => constants().get('INGEST_ANSWER_MAX_BYTES'),
    now: () => deps.now().getTime(),
    gate: createHostGate(deps),
    ...(priority ? { priority } : {}),
    robots: (url, signal) =>
      assertRobotsAllow(client!, url.host, [`${url.pathname}${url.search}`], { signal, now: () => deps.now().getTime() }),
  });
  client = http;
  useRobotsStore(http, createRobotsStore(deps));
  return http;
}

/**
 * v30 FIX-C BEH-8 (applied by FIX-INT): one batch of postings in one transaction, its new company names' locks taken
 * first, in one order (companies/resolve.ts lockNewCompanyNames), so two batches meeting the same NEW names (two
 * multi-employer feeds, a Run now beside the worker) wait for each other in turn instead of deadlocking. Names that
 * exist take no lock (FIX-C's part).
 */
export function saveBatch(db: DbClient, store: IngestStore, source: SourceRecord, batch: BatchItem[], at: string) {
  return db.tx(
    async (t) => {
      await lockNewCompanyNames(t, batch.map((item) => normalizeCompany(item.raw.company).nameKey));
      return store.upsertBatch(source, batch, at);
    },
    { label: 'ingest batch' },
  );
}

export function createIngestService(deps: AppDeps, options: IngestServiceOptions = {}): IngestService {
  const { log } = deps;
  const db = deps.db;
  /** v37 LANE (W5): whether `http`'s turns are a waiting person's (the API process: readForPeople). */
  let forPeople = false;
  const http = options.http ?? clientFor(deps, deps.config.ingest.userAgent, () => (forPeople ? 'interactive' : 'background'));
  const botHttp = options.botHttp ?? (options.http ? options.http : clientFor(deps, deps.config.outside.botUserAgent));
  // v30 DB-INGEST: the store reads the central constants (two misses, the suspect share, the fuzzy bits) and the seams.
  const store = createIngestStore(db, deps);
  const adapters = { ...ADAPTERS, ...options.adapters };
  const slots = new Slots(PARALLEL_RUNS);
  const running = new Map<number, { runId: number; controller: AbortController; done: Promise<AdminRunDetail> }>();
  const leaseMs = () => constantsOf(deps).get('INGEST_LEASE_MINUTES') * 60_000;
  /** The client a kind reads with: BOT_USER_AGENT for a new kind of read, today's identity otherwise. */
  const httpFor = (kind: string) => (NEW_READ_KIND_OF[kind] ? botHttp : http);

  // v31 RUNS: the stop poll. While this process runs any source, it looks every RUN_STOP_POLL_MS for pause requests on
  // its own runs (STOP_SQL) and aborts them with RunPausedError; nothing is read while it runs none.
  let stopTimer: ReturnType<typeof setInterval> | null = null;
  let stopLook: Promise<number> | null = null;

  async function lookForStops(): Promise<number> {
    const live = [...running.values()].filter((run) => !run.controller.signal.aborted);
    if (live.length === 0) return 0;
    const rows = await db.all<{ id: number }>(STOP_SQL, {
      ids: live.map((run) => run.runId).join(','),
      pausable: PAUSABLE_TRIGGERS.join(','),
      key: RUNS_PAUSED_KEY,
    });
    const asked = new Set(rows.map((row) => Number(row.id)));
    let stopped = 0;
    for (const run of live) {
      if (!asked.has(run.runId) || run.controller.signal.aborted) continue;
      run.controller.abort(new RunPausedError());
      stopped += 1;
      log.info(`[ingest] run ${run.runId} was paused by an admin; it stops at its next safe point`);
    }
    return stopped;
  }

  /** One look at a time; a second ask waits for the look going on. */
  function checkStops(): Promise<number> {
    stopLook ??= lookForStops().finally(() => {
      stopLook = null;
    });
    return stopLook;
  }

  function watchStops(): void {
    if (stopTimer || running.size === 0) return;
    const every = Math.max(100, constantsOf(deps).get('RUN_STOP_POLL_MS'));
    stopTimer = setInterval(() => {
      checkStops().catch((error: unknown) => log.warn('[ingest] could not look for paused runs; it looks again soon', error));
    }, every);
    stopTimer.unref?.();
  }

  function unwatchStops(): void {
    if (running.size > 0 || !stopTimer) return;
    clearInterval(stopTimer);
    stopTimer = null;
  }

  // v30 FIX-A (BEH-6, REQ-6): the run history's retention is the daily step run-history.ts (batched deletes); the tick
  // no longer trims old logs (a scan of the whole table every 15 seconds).

  /** What a finished run tells its source. */
  interface Finish {
    status: RunStatus;
    fetched: number;
    counts: UpsertCounts;
    error: string | null;
    errorCode: string | null;
    tally: ReadTally;
    /** A complete listing, or a 304: the source's live links are verified as of now. */
    complete: boolean;
    validators: ListingValidators | null;
    notFound: boolean;
    heldUntil: string | null;
    /** robots.txt's verdict when it refused the run. */
    robots: 'disallowed' | 'error' | null;
    /** The listing dropped too much to be trusted (12 §8.2): read again in SUSPECT_REREAD_MS. */
    suspect?: boolean;
    /**
     * v30 FIX-A (REV-BEH BEH-2): the complete listing missed postings it has not closed yet (their miss counts wait
     * for the next listing): its validators are not kept, so the next run reads the board whole (a 304 would repeat
     * this listing and count nothing).
     */
    pendingMisses?: boolean;
    /** v37 FIX-LANE (F7): it read nothing, waiting for Workday's pause: not the source's success either. */
    waiting?: boolean;
  }

  /**
   * Records the run's end and gives the source's lease back (lease_until cleared), with the source's next schedule
   * (scheduler.ts nextScheduleOf), all in one transaction; a complete run also brings its jobs back from unverified.
   */
  async function finish(source: SourceRecord, runId: number, end: Finish, runLog: RunLog, owner: string) {
    const now = nowIso(deps);
    const changed = end.counts.created + end.counts.updated + end.counts.deactivated + end.counts.reactivated > 0;
    await db.tx(
      async (t) => {
        // v30 FIX-A (BEH-4): the source's row first, locked: a run that no longer owns the lease writes its own run row
        // as interrupted and nothing else (the newer run's lease, tier and schedule stay its own).
        const holder = await t.one<{ mine: boolean }>(
          'SELECT lease_owner IS NOT DISTINCT FROM CAST(? AS uuid) AS mine FROM job_sources WHERE id = ? FOR UPDATE',
          [owner, source.id],
        );
        if (holder && !holder.mine) {
          const lost = new LeaseLostError();
          runLog.add(lost.message);
          await t.run(
            "UPDATE job_source_runs SET status = 'failed', finished_at = ?, fetched = ?, created = ?, updated = ?, unchanged = ?, deactivated = ?, " +
              "reopened = ?, failed = ?, requests = ?, bytes_fetched = ?, http_status = ?, error_code = 'interrupted', error = ?, log = ? WHERE id = ?",
            [
              now,
              end.fetched,
              end.counts.created,
              end.counts.updated,
              end.counts.unchanged,
              end.counts.deactivated,
              end.counts.reactivated,
              end.counts.failed,
              end.tally.requests,
              end.tally.bytes,
              end.tally.firstStatus,
              lost.message,
              runLog.text(),
              runId,
            ],
          );
          log.warn(`[ingest] run ${runId} of source ${source.id} lost its lease to another run; it changed nothing on the source`);
          return;
        }
        await t.run(
          'UPDATE job_source_runs SET status = ?, finished_at = ?, fetched = ?, created = ?, updated = ?, unchanged = ?, deactivated = ?, ' +
            'reopened = ?, failed = ?, requests = ?, bytes_fetched = ?, http_status = ?, error_code = ?, error = ?, log = ? WHERE id = ?',
          [
            end.status,
            now,
            end.fetched,
            end.counts.created,
            end.counts.updated,
            end.counts.unchanged,
            end.counts.deactivated,
            end.counts.reactivated,
            end.counts.failed,
            end.tally.requests,
            end.tally.bytes,
            end.tally.firstStatus,
            end.errorCode,
            end.error === null ? null : end.error.slice(0, RUN_ERROR_MAX_CHARS),
            runLog.text(),
            runId,
          ],
        );
        if (end.status === 'paused') {
          await finishPaused(t, source, runId, now);
          return;
        }
        const current = await t.one<{ consecutive_failures: number; tier: string; last_change_at: string | null; suspect_at: string | null }>(
          'SELECT consecutive_failures, tier, last_change_at, suspect_at FROM job_sources WHERE id = ?',
          [source.id],
        );
        if (!current) return;
        const open =
          (
            await t.one<{ n: number }>(
              'SELECT count(*) AS n FROM job_source_links l JOIN jobs j ON j.id = l.job_id WHERE l.source_id = ? AND l.missing_since IS NULL AND j.active',
              [source.id],
            )
          )?.n ?? 0;
        const recent = await t.all<{ changed: boolean }>(
          // v31 RUNS: a paused run read part of the listing: it says nothing of the source's changes.
          "SELECT (created + updated + deactivated + reopened) > 0 AS changed FROM job_source_runs WHERE source_id = ? AND id <> ? AND status NOT IN ('running', 'paused') " +
            'ORDER BY started_at DESC, id DESC LIMIT 2',
          [source.id, runId],
        );
        const ok = end.status !== 'failed';
        const outcome: RunOutcome = { ok, notFound: end.notFound, heldUntil: end.heldUntil, changed, openJobs: open };
        const next = nextScheduleOf(deps, {
          now: deps.now().getTime(),
          consecutiveFailures: current.consecutive_failures,
          tier: current.tier,
          lastChangeAt: current.last_change_at,
          recentChanges: recent.map((row) => Boolean(row.changed)),
          holdsSavedJob: ok ? await holdsSavedJob(t, source.id) : false,
          outcome,
        });
        const scheduled = SCHEDULED_KINDS.includes(source.kind) || Boolean(NEW_READ_KIND_OF[source.kind]);
        await t.run(
          `UPDATE job_sources SET last_status = @status, lease_until = NULL, lease_owner = NULL,
             last_success_at = CASE WHEN CAST(@ok AS boolean) THEN CAST(@now AS timestamptz) ELSE last_success_at END,
             last_complete_at = CASE WHEN CAST(@complete AS boolean) THEN CAST(@now AS timestamptz) ELSE last_complete_at END,
             last_change_at = CASE WHEN CAST(@changed AS boolean) THEN CAST(@now AS timestamptz) ELSE last_change_at END,
             etag = CASE WHEN CAST(@dropValidators AS boolean) THEN NULL WHEN CAST(@newValidators AS boolean) THEN CAST(@etag AS text) ELSE etag END,
             last_modified = CASE WHEN CAST(@dropValidators AS boolean) THEN NULL
               WHEN CAST(@newValidators AS boolean) THEN CAST(@lastModified AS text) ELSE last_modified END,
             suspect_at = CASE WHEN CAST(@suspect AS boolean) THEN CAST(@now AS timestamptz) WHEN CAST(@complete AS boolean) THEN NULL ELSE suspect_at END,
             open_jobs = CAST(@open AS integer),
             consecutive_failures = CAST(@failures AS smallint), tier = @tier,
             cadence = CAST(@cadenceMs AS bigint) * interval '1 millisecond',
             next_run_at = CASE WHEN CAST(@scheduled AS boolean) THEN CAST(@nextRunAt AS timestamptz) ELSE next_run_at END,
             enabled = CASE WHEN CAST(@disable AS boolean) THEN false ELSE enabled END,
             robots_status = COALESCE(CAST(@robots AS text), robots_status),
             robots_checked_at = CASE WHEN CAST(@robots AS text) IS NULL THEN robots_checked_at ELSE CAST(@now AS timestamptz) END
           WHERE id = @id`,
          {
            id: source.id,
            status: end.status,
            ok: ok && !end.waiting, // v37 FIX-LANE (F7): a run that only waited for Workday is no success of the source
            now,
            complete: end.complete,
            changed,
            // A complete listing read whole keeps its validators (none: the next run asks without); a 304 keeps the old.
            newValidators: end.complete && end.status !== 'not_modified',
            // v30 FIX-A (BEH-2): a listing with misses still to count, or a suspect one, keeps none: the next read is whole.
            dropValidators: Boolean(end.pendingMisses || end.suspect),
            suspect: Boolean(end.suspect),
            etag: end.validators?.etag ?? null,
            lastModified: end.validators?.lastModified ?? null,
            // v37 FIX-37A (E7, REVIEW37-ux M5): the live jobs the source holds, written at every run's end (a paused run
            // keeps its own: finishPaused): a run that reads part of a board (an iCIMS site, a Workday career site) is
            // never complete, and its row, sheet, Open jobs sort and daily report read 0 open jobs.
            open,
            failures: next.consecutiveFailures,
            tier: next.tier,
            cadenceMs: next.cadenceMs,
            scheduled,
            // v30 FIX-A (BEH-1): the hour's re-read once; a second suspect listing in a row keeps the tier's cadence.
            nextRunAt:
              end.suspect && current.suspect_at === null ? new Date(deps.now().getTime() + SUSPECT_REREAD_MS).toISOString() : next.nextRunAt,
            disable: next.disable,
            robots: end.robots,
          },
        );
        if (next.disable) {
          runLog.add(
            next.tier === 'not_found'
              ? 'The board was not found again: the source is turned off.'
              : `The source failed ${next.consecutiveFailures} times in a row: it is turned off.`,
          );
          log.warn(`[ingest] ${source.kind} "${source.name}" (source ${source.id}) turned off after ${next.consecutiveFailures} failed runs`);
        }
        // A complete listing (or a 304) verifies the source's live links: their jobs come back from unverified.
        if (end.complete) await clearUnverifiedOf(t, source.id);
        // v31 NOTIFY: a failed run, or the source turned off, told to the admins (once an hour at most) in this
        // transaction (never throws).
        if (!ok || next.disable) {
          await notifyRunFinished(deps, {
            sourceId: source.id,
            sourceName: source.name,
            failed: !ok,
            disabled: next.disable,
            failures: next.consecutiveFailures,
          });
        }
      },
      { label: 'ingest run finished' },
    );
  }

  /**
   * v31 RUNS: a paused run's source (in finish's transaction, its lease checked): its state and lease only. Its failures,
   * tier, validators, open jobs and verified links stay as they were. A source the worker schedules is due again after
   * its cadence (Continue makes it due now); due now when the pause was taken back before the run stopped (a Continue
   * between the request and the stop: no stop asked any more, the source and every run going).
   */
  async function finishPaused(t: DbTx, source: SourceRecord, runId: number, now: string): Promise<void> {
    const scheduled = SCHEDULED_KINDS.includes(source.kind) || Boolean(NEW_READ_KIND_OF[source.kind]);
    await t.run(
      `UPDATE job_sources s SET last_status = 'paused', lease_until = NULL, lease_owner = NULL,
         next_run_at = CASE WHEN NOT CAST(@scheduled AS boolean) THEN s.next_run_at
           WHEN s.paused_at IS NULL AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = @key)
             AND (SELECT r.stop_requested_at FROM job_source_runs r WHERE r.id = @runId) IS NULL THEN CAST(@now AS timestamptz)
           ELSE CAST(@now AS timestamptz) + s.cadence END
       WHERE s.id = @id`,
      { id: source.id, runId, now, scheduled, key: RUNS_PAUSED_KEY },
    );
  }

  async function execute(source: SourceRecord, runId: number, trigger: RunTrigger, signal: AbortSignal, owner: string): Promise<AdminRunDetail> {
    const runLog = new RunLog(deps.now);
    const counts = emptyCounts();
    const tally: ReadTally = { requests: 0, bytes: 0, firstStatus: null };
    const end: Finish = {
      status: 'succeeded',
      fetched: 0,
      counts,
      error: null,
      errorCode: null,
      tally,
      complete: false,
      validators: null,
      notFound: false,
      heldUntil: null,
      robots: null,
    };
    let failureLines = 0;
    const noteFailure = (text: string) => {
      failureLines += 1;
      if (failureLines <= MAX_FAILURE_LINES) runLog.add(text);
      else if (failureLines === MAX_FAILURE_LINES + 1) runLog.add('More failures were not logged.');
    };
    /** v31 RUNS: a safe point: a run asked to stop (paused, or its lease lost) stops here. */
    const stopHere = () => {
      if (!signal.aborted) return;
      throw signal.reason instanceof RunPausedError ? signal.reason : new IngestError('The run was stopped before it finished.');
    };
    try {
      stopHere(); // v31 RUNS: paused while it waited for a slot or was prepared
      const adapter = adapters[source.kind];
      if (!adapter) throw new IngestError(`There is no reader for "${source.kind}" sources.`);
      const newKind = NEW_READ_KIND_OF[source.kind];
      if (newKind) assertNewReadAllowed(deps, newKind);
      runLog.add(`Run ${runId} of ${source.name} started (${trigger}).`);
      // The listing judges only the links last seen before it began (see store.markMissing).
      const listedFrom = nowIso(deps);
      const conditional = source.lastCompleteAt && (source.etag || source.lastModified);
      const result = await adapter.fetch(source, {
        deps,
        http: countingHttp(httpFor(source.kind), tally),
        signal,
        log: (line) => runLog.add(line),
        needsPayCheck: (sourceJobId) => store.needsPayCheck(source.id, sourceJobId),
        validators: conditional ? { etag: source.etag ?? null, lastModified: source.lastModified ?? null } : null,
      });

      if (result.heldUntil) end.heldUntil = result.heldUntil; // v37 LANE (W4): stopped at a pause: due again after it
      if (result.notModified) {
        // 12 §9.4: the listing is complete and unchanged; nothing else is done.
        end.status = 'not_modified';
        end.complete = true;
        runLog.add('The listing has not changed since the last complete run (304): nothing was read again.');
      } else {
        const unique = new Map<string, RawPosting>();
        for (const posting of result.postings) {
          // Keyed as the store keeps the id, so the seen-list below names the links as they are stored.
          const id = storedSourceJobId(posting.sourceJobId);
          if (unique.has(id)) noteFailure(`Posting ${id} is listed twice; the first one was kept.`);
          else unique.set(id, posting);
        }
        end.fetched = unique.size + result.failures.length;
        counts.failed += result.failures.length;
        for (const failure of result.failures) noteFailure(failure.message);

        // v31 LINK: an import's rows (CSV, JSON, a Google Sheet, the lake) are links, each queued for TailorIT's own read
        // (jobs/add/imports.ts); nothing a row says is stored.
        const linkList = isLinkListKind(source.kind) && (await queueLinksOfRun(deps, source, runId, [...unique.values()], (line) => runLog.add(line)));
        const items: BatchItem[] = linkList ? [] : [...unique.values()].map((raw) => ({ raw, sourceHash: sourceHashOf(raw) }));
        if (items.length > 0) await ensureRawPartition(source.kind);
        for (let start = 0; start < items.length; start += BATCH_SIZE) {
          stopHere(); // between two batches (v31 RUNS: a pause stops here, the batches saved kept)
          const batch = items.slice(start, start + BATCH_SIZE);
          const outcome = await saveBatch(db, store, source, batch, nowIso(deps));
          for (const key of Object.keys(counts) as Array<keyof UpsertCounts>) counts[key] += outcome.counts[key];
          for (const failure of outcome.failures) noteFailure(`"${failure.title}" (${failure.sourceJobId}) was not saved: ${failure.message}`);
          await yieldToEventLoop();
        }
        runLog.add(
          `Saved: ${counts.created} new, ${counts.updated} updated, ${counts.unchanged} unchanged${counts.reactivated ? `, ${counts.reactivated} reopened` : ''}${counts.failed ? `, ${counts.failed} failed` : ''}.`,
        );
        // v31 RUNS: a run paused once its batches were saved closes nothing (markMissing is not reached).
        stopHere();

        if (!result.complete && result.readAll) {
          // v37 FIX-37A (E9): every planned posting read and none failed: succeeded; still nothing closes by absence.
          runLog.add("Every planned posting was read. This board's listing never closes a posting by its absence, so none was marked missing.");
        } else if (!result.complete) {
          end.status = 'partial';
          runLog.add('The listing was incomplete, so no posting was marked missing.');
        } else {
          end.complete = true;
          end.validators = result.validators ?? null;
          if (source.deactivateMissing) {
            const seen = [
              ...unique.keys(),
              ...(result.skippedIds ?? []),
              ...result.failures.map((failure) => failure.sourceJobId).filter((id): id is string => Boolean(id)),
            ];
            // v30 FIX-A (BEH-4): only while the lease is still this run's (checked under the source's row lock).
            const closed = await db.tx(
              async (t) => {
                await assertOwnLease(t, source.id, owner);
                return store.markMissing(source.id, seen, nowIso(deps), listedFrom);
              },
              { label: 'ingest missing' },
            );
            counts.deactivated += closed.deactivated;
            // DB-INGEST's two-miss rule may judge the listing suspect (12 §8.2): not complete, read again soon.
            if (closed.suspect) {
              end.suspect = true;
              end.complete = false;
              end.status = 'partial';
              runLog.add('The listing dropped too many open postings to be trusted: nothing closed, and the next listing decides (missed again, they count).');
            }
            // v30 DB-INGEST: a posting closes when two listings in a row miss it (12 §8.2).
            if (closed.missed) {
              end.pendingMisses = true;
              if (!closed.suspect) runLog.add(`${closed.missed} postings were not listed this time; they close if the next listing misses them too.`);
            }
            if (closed.missing || closed.deactivated) {
              runLog.add(`${closed.missing} postings are no longer listed; ${closed.deactivated} jobs closed.`);
            }
          }
        }
        counts.deactivated += result.closedByRead ?? 0; // v30 INT-4: the adapter's own reads' closes (S3's edit D)
        if (counts.deactivated) runLog.add(`${counts.deactivated} jobs closed in all.`);
        if (end.status === 'succeeded' && counts.failed > 0) end.status = 'partial';
      }
    } catch (caught) {
      if (pausedBy(signal)) {
        // v31 RUNS: paused, not failed: what it saved stays, nothing was closed, the source keeps its schedule's state.
        end.status = 'paused';
        end.complete = false;
        end.error = null;
        end.errorCode = null;
        runLog.add(
          `Paused by an admin: ${counts.created} new and ${counts.updated} updated postings were saved; nothing was closed. ` +
            'Continue reads the source again from the top.',
        );
        return finishRun(source, runId, end, runLog, owner);
      }
      // v37 FIX-LANE (SP v37 FIXES-361 F7): the lane's platform paused every one of its sites (Workday: every Workday
      // site), or an admin held them all, before this run read its postings: the run waits for it, never a failure (none
      // counted, no admin told); its next run is due after the pause (scheduler.ts nextScheduleOf).
      const lanePause = signal.aborted ? null : lanePauseOf(caught);
      if (lanePause) {
        end.status = 'partial';
        end.complete = false;
        end.waiting = true;
        end.heldUntil = lanePause.until;
        end.error = messageOf(caught);
        end.errorCode = laneWaitingCodeOf(lanePause.lane);
        runLog.add(`Waiting for ${lanePause.lane.name}: ${end.error} Nothing was closed; the next run starts after it.`);
        return finishRun(source, runId, end, runLog, owner);
      }
      end.status = 'failed';
      end.complete = false;
      end.error = messageOf(caught);
      end.errorCode = errorCodeOf(caught);
      if (caught instanceof HostHeldError) end.heldUntil = caught.until;
      if (caught instanceof SourceNotFoundError) end.notFound = true;
      if (caught instanceof RobotsRefusal) end.robots = caught.reason === 'disallowed' ? 'disallowed' : 'error';
      // A lease lost mid-run (keepLease aborted the read): the run stops as interrupted.
      if (signal.aborted && signal.reason instanceof LeaseLostError) {
        end.error = signal.reason.message;
        end.errorCode = 'interrupted';
      }
      if (!plainError(caught)) log.error(`[ingest] run ${runId} of source ${source.id} failed`, caught);
      runLog.add(`Failed: ${end.error} Nothing was closed.`);
    }
    return finishRun(source, runId, end, runLog, owner);
  }

  /** A run's last log line, its finish, its line in the server log, and the run as stored. */
  async function finishRun(source: SourceRecord, runId: number, end: Finish, runLog: RunLog, owner: string): Promise<AdminRunDetail> {
    const { counts, tally } = end;
    runLog.add(`Finished: ${end.status}.`);
    await finish(source, runId, end, runLog, owner);
    log.info(
      `[ingest] ${source.kind} "${source.name}" run ${runId}: ${end.status} (fetched ${end.fetched}, new ${counts.created}, ` +
        `updated ${counts.updated}, unchanged ${counts.unchanged}, closed ${counts.deactivated}, failed ${counts.failed}, ` +
        `requests ${tally.requests})`,
    );
    return (await adminRun(db, runId))!;
  }

  /**
   * v30 INT-3 (S1-API edit D, D5L's note): the day's job_postings_raw partition, made outside any transaction before a
   * run's batches keep raw payloads, for a kind that keeps any (job_source_kinds.raw_keep_days). D5L's housekeeping makes
   * today's and two days ahead; a clock past them or a cluster whose housekeeping has not run yet would otherwise keep
   * nothing (the store skips a day without a partition). A failure is logged and the run goes on.
   */
  async function ensureRawPartition(kind: string): Promise<void> {
    try {
      const keeps = await db.one<{ days: number }>('SELECT raw_keep_days AS days FROM job_source_kinds WHERE kind = ?', [kind]);
      if (!keeps || keeps.days <= 0) return;
      await ensureDayPartition(db, JOB_POSTINGS_RAW, dayOf(nowIso(deps)));
    } catch (error) {
      log.warn(`[ingest] the raw payloads' partition of today could not be made: ${(error as Error).message}`);
    }
  }

  /**
   * The checks before a run: no run of it here, a source that exists and is ever run, an identity it may read with.
   * v36 SOURCES (PLAN S5): and one an admin turned on (enabled, with enabled_at), but a kind that runs while off.
   */
  function checkRunnable(source: SourceRecord | null): SourceRecord {
    if (!source) throw notFound('That job source');
    if (UNRUN_KINDS.includes(source.kind)) {
      throw validationFailed(
        source.kind === 'workday'
          ? 'TailorIT reads Workday postings one at a time, never a whole Workday site: this source cannot be run.'
          : 'TailorIT never reads job pages again: the jobs added from them keep the text the person saw.',
      );
    }
    if ((!source.enabled || !source.enabledAt) && !RUNS_WHILE_OFF_KINDS.includes(source.kind)) {
      throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_OFF'); // v36 SOURCES
    }
    // v37 BOARDS (SP v37 PLAN B3): as the scheduler, bulk Run now and the waiting reasons do, only a source whose recorded
    // terms allow automated access runs (a kind that runs while off, an import's record, has its kind's terms).
    // v37 FIX-37B (SP v37 FIXES-37 E2, E8): the one check (termsAllowReads), refused in the agreed words by its status.
    if (!RUNS_WHILE_OFF_KINDS.includes(source.kind) && !termsAllowReads(source.termsStatus)) {
      throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_TERMS', termsParams(source.termsStatus));
    }
    // v30 FIX-A (REQ-5): a career site (made by hand or by discovery) runs only while "Read career pages" is on.
    if (source.kind === 'career_site' && !careerPagesOn(deps)) throw validationFailed(new CareerPagesOffError().message);
    // v30 S4: a keyed kind (USAJOBS, Himalayas) stays off while its key is empty (DECISIONS P1, owner question 10).
    const setting = missingOutsideKey(adapters[source.kind], deps);
    const missingKey = setting
      ? `TailorIT reads no ${kindLabelOf(source.kind, source.config)} source while ${setting} is empty: set it in .env, then restart.`
      : null;
    const newKind = NEW_READ_KIND_OF[source.kind];
    if (newKind) {
      try {
        assertNewReadAllowed(deps, newKind);
      } catch (error) {
        // v30 INT-4: a keyed kind waiting for both its key and the bot identity names both (its key first).
        throw validationFailed(missingKey ? `${missingKey} ${(error as Error).message}` : (error as Error).message);
      }
    }
    if (missingKey) throw validationFailed(missingKey);
    if (running.has(source.id)) throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_RUNNING');
    return source;
  }

  /**
   * Renews a running source's lease (best effort) until `stop` is called, only while the lease is still this run's
   * (v30 FIX-A, BEH-4): a renewal that finds another owner (the lease ran out and another run took the source) stops the
   * run (`lost`), so it never extends the newer run's lease.
   */
  function keepLease(sourceId: number, owner: string, lost: () => void): () => void {
    const every = Math.max(1000, Math.floor(leaseMs() / LEASE_RENEWALS));
    const timer = setInterval(() => {
      db.run('UPDATE job_sources SET lease_until = CAST(? AS timestamptz) WHERE id = ? AND lease_owner = CAST(? AS uuid)', [
        new Date(deps.now().getTime() + leaseMs()).toISOString(),
        sourceId,
        owner,
      ])
        .then((result) => {
          if (result.changes === 0) lost();
        })
        .catch((error: unknown) => log.warn(`[ingest] could not renew the lease of source ${sourceId}`, error));
    }, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** v30 FIX-A (BEH-4): throws LeaseLostError unless the source's lease is still `owner`'s (locks the source's row). */
  async function assertOwnLease(t: DbTx, sourceId: number, owner: string): Promise<void> {
    const row = await t.one<{ mine: boolean }>(
      'SELECT lease_owner IS NOT DISTINCT FROM CAST(? AS uuid) AS mine FROM job_sources WHERE id = ? FOR UPDATE',
      [owner, sourceId],
    );
    if (!row?.mine) throw new LeaseLostError();
  }

  /** The leased source's run, in the background: its slot, `prepare`, the read and its finish. */
  function launch(source: SourceRecord, runId: number, trigger: RunTrigger, startedAt: string, runOptions: RunOptions, owner: string): StartedRun {
    const controller = new AbortController();
    /** This run is no longer going here (a newer run of the source, leased once this one gave it back, stays listed). */
    const forget = () => {
      if (running.get(source.id)?.runId === runId) running.delete(source.id);
      unwatchStops(); // v31 RUNS
    };
    /** The run as stored, or (the database closing under a shutdown) what is known of it. */
    const recorded = async (error: string): Promise<AdminRunDetail> => {
      try {
        const stored = await adminRun(db, runId);
        if (stored) return stored;
      } catch {
        /* the database is closing */
      }
      return {
        id: runId,
        sourceId: source.id,
        sourceKind: source.kind,
        sourceKindLabel: kindLabelOf(source.kind, source.config),
        sourceName: source.name,
        status: 'failed',
        trigger,
        startedAt,
        finishedAt: null,
        httpStatus: null,
        bytesFetched: null,
        requests: 0,
        fetched: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        deactivated: 0,
        reopened: 0,
        failed: 0,
        errorCode: 'error',
        error,
        log: [],
      };
    };
    /**
     * A run that ends before it reads anything: recorded failed, its lease given back. v31 RUNS: recorded paused when an
     * admin paused it meanwhile (it waited for a slot).
     */
    const failEarly = async (failure: string): Promise<AdminRunDetail> => {
      const paused = pausedBy(controller.signal);
      const message = paused ? 'Paused by an admin before it read anything. Continue reads the source from the top.' : failure;
      const runLog = new RunLog(deps.now);
      runLog.add(message);
      try {
        await finish(
          source,
          runId,
          {
            status: paused ? 'paused' : 'failed',
            fetched: 0,
            counts: emptyCounts(),
            error: paused ? null : message,
            errorCode: paused ? null : 'error',
            tally: { requests: 0, bytes: 0, firstStatus: null },
            complete: false,
            validators: null,
            notFound: false,
            heldUntil: null,
            robots: null,
          },
          runLog,
          owner,
        );
      } catch {
        /* the database is closing */
      }
      forget();
      return recorded(message);
    };
    const done = (async (): Promise<AdminRunDetail> => {
      let release = () => {};
      const stopLease = keepLease(source.id, owner, () => {
        log.warn(`[ingest] run ${runId} of source ${source.id} lost its lease; it stops`);
        controller.abort(new LeaseLostError());
      });
      try {
        try {
          if (!runOptions.bypassSlots) release = await slots.acquire(controller.signal);
        } catch {
          return await failEarly('The server stopped before this run started.');
        }
        let read = source;
        if (runOptions.prepare) {
          try {
            await runOptions.prepare();
            // What `prepare` stored (an import's file and mapping) is the source's config now.
            read = (await getSourceRecord(db, source.id)) ?? source;
          } catch (caught) {
            log.error(`[ingest] run ${runId} of source ${source.id} could not be prepared`, caught);
            return await failEarly(messageOf(caught));
          }
        }
        return await execute(read, runId, trigger, controller.signal, owner);
      } catch (caught) {
        log.error(`[ingest] could not record run ${runId}`, caught);
        return await recorded('The run could not be recorded.');
      } finally {
        stopLease();
        release();
        forget();
      }
    })();
    running.set(source.id, { runId, controller, done });
    watchStops(); // v31 RUNS
    return { runId, done };
  }

  const service: IngestService = {
    http,
    botHttp,
    store,

    readForPeople() {
      forPeople = true; // v37 LANE (W5)
    },

    async run(sourceId, trigger, runOptions = {}) {
      const source = checkRunnable(await getSourceRecord(db, sourceId));
      // v30 FIX-A (SEC-2, BEH-3): a source of a company that opted out is never read (Run now, the worker, an import).
      if (await sourceOptedOut(db, source.id)) throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_OPTED_OUT');
      // v31 RUNS: the schedule and Run now start nothing while every run, or this source, is paused (a run that starts
      // while the pause is written stops at the next look: STOP_SQL).
      if (PAUSABLE_TRIGGERS.includes(trigger)) {
        if (await runsPaused(deps)) throw refuse(deps, 'conflict', 'MSG_INGEST_RUNS_PAUSED');
        if (source.pausedAt) throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_PAUSED');
      }
      const startedAt = nowIso(deps);
      const until = new Date(deps.now().getTime() + leaseMs()).toISOString();
      // v30 FIX-A (BEH-4): the run's own id on the lease.
      const owner = randomUUID();
      // v37 FIX-LANE (F8, W6): a source on a lane (a Workday source) runs only while no other source of its lane does.
      const lane = source.host ? laneOfHost(source.host) : null;
      const runId = await db.tx(
        async (t): Promise<number | 'lane' | null> => {
          if (lane) {
            await t.run('SELECT pg_advisory_xact_lock(CAST(@lock AS integer), hashtext(@lane))', { lock: LANE_LEASE_LOCK, lane: lane.key });
            if (await t.one(otherLaneRunSql(), { id: source.id, now: startedAt, lane: lane.key })) return 'lane';
          }
          // The lease: no row changed means the source runs already (another request, or another process).
          if ((await t.run(LEASE_SQL, { now: startedAt, until, id: source.id, owner })).changes === 0) return null;
          return (await t.one<{ id: number }>(INSERT_RUN_SQL, [source.id, trigger, startedAt]))!.id;
        },
        { label: 'ingest run started' },
      );
      if (runId === 'lane') throw refuse(deps, 'conflict', 'MSG_INGEST_LANE_RUNNING', { site: lane!.name });
      if (runId === null) throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_RUNNING');
      return launch(source, runId, trigger, startedAt, runOptions, owner);
    },

    isRunning(sourceId) {
      return running.has(sourceId);
    },

    runningIds() {
      return [...running.keys()];
    },

    async test(kind, config) {
      const fail = (message: string): SourceTestResult => ({ ok: false, message, count: 0, samples: [], companyName: null });
      if (kind === 'ft_lake') {
        const path = typeof config.path === 'string' && config.path.trim() ? config.path.trim() : deps.config.ingest.ftLakeDbPath;
        try {
          const snapshot = readLake(path, { limit: 3 });
          return {
            ok: true,
            message: `${snapshot.total} jobs in the lake, ${snapshot.withAnalysis} with an analysis.`,
            count: snapshot.total,
            samples: snapshot.rows.map((row) => `${row.title} at ${row.company}`),
            companyName: null,
          };
        } catch (caught) {
          return fail(messageOf(caught));
        }
      }
      const adapter = adapters[kind];
      if (!adapter || !['greenhouse', 'lever', 'ashby', 'workable'].includes(kind)) {
        return fail('Only job boards and the free_tailor lake can be tested.');
      }
      const source: SourceRecord = {
        id: -1,
        kind,
        name: 'test',
        config,
        companyId: null,
        enabled: false, // v36 SOURCES: a Test's record is never stored, and an adapter's read never asks
        deactivateMissing: false,
        lastRunAt: null,
        lastSuccessAt: null,
        lastStatus: null,
        createdAt: null,
        updatedAt: null,
      };
      const limitMs = Math.max(deps.config.ingest.httpTimeoutMs * 2, 30_000);
      const signal = AbortSignal.timeout(limitMs);
      try {
        const lines: string[] = [];
        const result = await adapter.fetch(source, {
          deps,
          http,
          signal,
          log: (line) => lines.push(line),
          needsPayCheck: () => false,
          listingOnly: true,
        });
        const count = result.postings.length;
        return {
          ok: true,
          message: count ? `Found ${count} open ${count === 1 ? 'job' : 'jobs'}.` : 'The board answered, but it lists no open jobs.',
          count,
          samples: result.postings.slice(0, 3).map((posting) => posting.title),
          companyName: result.postings[0]?.company.name ?? null,
        };
      } catch (caught) {
        if (signal.aborted) return fail(`The board did not answer within ${Math.round(limitMs / 1000)} s. Try again in a minute.`);
        return fail(messageOf(caught));
      }
    },

    async recoverInterrupted(recoverOptions = {}) {
      const triggers = recoverOptions.triggers ?? null;
      const mine = [...running.keys()];
      const now = nowIso(deps);
      const changed = await db.tx(
        async (t) => {
          // A run whose source's lease ran out (its process stopped), or (at a process's start) one of its own kind. v31
          // RUNS: one an admin asked to pause is recorded paused (it stopped, as asked), not failed.
          const runs = await t.all<{ source_id: number; status: string }>(
            `UPDATE job_source_runs r SET status = CASE WHEN r.stop_requested_at IS NULL THEN 'failed' ELSE 'paused' END,
               finished_at = CAST(@now AS timestamptz),
               error = CASE WHEN r.stop_requested_at IS NULL THEN @error END,
               error_code = CASE WHEN r.stop_requested_at IS NULL THEN 'interrupted' END
             FROM job_sources s
             WHERE s.id = r.source_id AND r.status = 'running'
               AND NOT (r.source_id = ANY(CAST(string_to_array(@mine, ',') AS bigint[])))
               AND (s.lease_until IS NULL OR s.lease_until < CAST(@now AS timestamptz)
                 OR (CAST(@all AS boolean) OR r.trigger = ANY(string_to_array(@triggers, ','))))
             RETURNING r.source_id, r.status`,
            {
              now,
              error: 'The server stopped during this run.',
              mine: mine.join(','),
              all: triggers === null,
              triggers: (triggers ?? []).join(','),
            },
          );
          const ids = [...new Set(runs.map((run) => run.source_id))];
          const paused = runs.filter((run) => run.status === 'paused').map((run) => run.source_id);
          // The leases those runs held.
          if (ids.length > 0) {
            await t.run(
              `UPDATE job_sources SET last_status = CASE WHEN id = ANY(CAST(string_to_array(@paused, ',') AS bigint[])) THEN 'paused' ELSE 'failed' END,
                 lease_until = NULL, lease_owner = NULL WHERE id = ANY(CAST(string_to_array(@ids, ',') AS bigint[]))`,
              { ids: ids.join(','), paused: paused.join(',') },
            );
          }
          return runs.length;
        },
        { label: 'ingest recover' },
      );
      if (changed) log.warn(`[ingest] marked ${changed} run(s) a stopped process left running as failed`);
      return changed;
    },

    checkStops,

    async stop() {
      if (stopTimer) clearInterval(stopTimer); // v31 RUNS
      stopTimer = null;
      const runs = [...running.values()];
      for (const run of runs) run.controller.abort();
      await Promise.race([
        Promise.allSettled(runs.map((run) => run.done)),
        new Promise((resolve) => setTimeout(resolve, 10_000).unref?.()),
      ]);
    },
  };
  return service;
}
