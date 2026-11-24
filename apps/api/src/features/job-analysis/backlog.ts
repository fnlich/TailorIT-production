import { RESUME_ANALYSIS_VERSION, HOUR_MS } from '@tailorit/shared';
import { createBackgroundGate, createHourlyBudget } from '../../ai/background';
import { constantsOf } from '../../core/constants/index';
import { dayKeyAt, nextDailyResetAt } from '../../core/constants/day';
import { nowIso, type AppDeps } from '../../core/context';
import { JOB_ANALYSIS_PROMPT_VERSION } from '../../ai/prompts/job-analysis/job-analysis';
import { jobTextJoin, readJobText } from '../jobs/text';
import { MAX_PENDING_ANALYSES, MIN_TEXT_FOR_AI, readableForAi, type JobAnalysisServiceInternals } from './service';
import { AI_OUTAGE_WAIT_MS, setAsideAiTexts } from './store';

// The add-time job AI backlog (AI_JOB_ANALYSIS=ingest, the default): every added job gets the rule-based analysis at
// once (ingest), then Claude reads it, once per posting text, through this durable queue. `saved` mode runs the same
// backlog over the jobs someone has saved; `lazy` and `off` leave it off, as do AI_ENABLED=false and
// AI_CLI_BACKGROUND_SLOTS=0.
//
// - Candidates: live jobs with enough text whose text has no Claude analysis of the current prompt version (a
//   free_tailor lake analysis does not count) and is not backing off in job_ai_attempts. Each text once: jobs that
//   share a text share its analysis, and the task is deduplicated by it. The length is the stored count of the text's
//   characters (job_texts.text_chars); a text it lets through that readableForAi still finds too short (a count that
//   disagrees with the text) is set aside there for good when a step meets it, so a run of them never keeps the
//   backlog from the jobs after them.
// - v2.0: a text Claude read at an older prompt version is read again only as JOB_ANALYSIS_V2_REREAD says (`saved`, the
//   default: only while someone has a job of it at Saved, those first, oldest saved first; `all`: in the order below;
//   `off`: never). Every reading here is a server cost (chargeTo null).
// - Order: newest first_seen_at first; jobs first seen before this release (app_settings job_ai_backlog_since,
//   recorded on first start) after every newer one. Opening or saving (one job or many) never queue a job or move it up.
// - Cost: a step walks idx_jobs_ai_backlog (migration 0403; the PostgreSQL baseline's partial index of the live jobs)
//   in that order and stops at CANDIDATES_PER_STEP, so it reads a few index entries while there is work near the top,
//   and every live job's entry only when there is none; it reads a text only for a job Claude still has to read. After
//   a step that found nothing, the next steps read no jobs until something is written that a candidate depends on
//   (the write mark, migrations-pg 0007), the reread scope changes, or a backoff ends.
// - At most one task of its own in flight (system-owned, background priority, charged to no one), and never more
//   than MAX_PENDING_ANALYSES job analyses pending in all.
// - It yields to resume readings (resume refines go first) while one is queued or running, or one is due (read from
//   resume_analysis_backlog and ai_tasks, as the resume backlog keeps them, while that backlog is on and under its
//   hourly cap); waits while the background gate is shut (any AI hold, a usage warning) and past
//   AI_JOB_ANALYSIS_PER_HOUR (0 = no cap).
// - Failures (job_ai_attempts, written by the service's task handler): only Claude failing on the text counts, with
//   a 30 then 60 minute wait, and after the third a day; Claude being unavailable only waits for the outage to pass.
//   The backlog itself also rests: AI_OUTAGE_WAIT_MS after its task found Claude unavailable (signed out, no CLI: no
//   hold shuts the gate then), and half an hour after FAILURE_STREAK failures in a row, so neither an outage nor a
//   failure on every text runs through the whole backlog.
// - Restarts lose nothing: the AI queue resumes its queued tasks, the memory of failures is in the database, and the
//   order is read from it at every step. No timers before `start`; every timer body logs and carries on.
// - v3.0 D2-F: on the async client.
// - v30 FIX-B (REV-REQ REQ-2, approved Q13; 12 §9.7): `ingest` reads at most AI_JOB_ANALYSIS_INGEST_MAX_PER_DAY new jobs
//   a day, then works as `saved` until the daily reset: once its own tasks since today's reset (DAY_RESET_TIME, the day
//   key every daily cap reads) reach the constant, a step's candidates are the saved jobs only. Read at each step, so an
//   admin's change reaches the next one; 0 reads saved jobs only.
// - v3.0 PG-F: on PostgreSQL. No planner hint (SQLite's INDEXED BY): the candidates' WHERE, ORDER BY and LIMIT are the
//   index's, and the plan test (job-analysis-backlog-perf) checks the planner walks it. The length is
//   job_texts.text_chars (features/jobs/text.ts's join); the text is read through readJobText. The write mark is
//   0007's sequence with this database's open writers, in place of total_changes() and pragma_data_version.

/** app_settings key: when this release first started (an ISO time as JSON). Jobs first seen before it go last. */
export const BACKLOG_SINCE_KEY = 'job_ai_backlog_since';

/** How often the backlog looks for work when nothing nudges it (its own task finishing does). */
export const BACKLOG_TICK_MS = 30_000;
/** A nudge runs the next step this soon. */
const NUDGE_MS = 500;
/** After the AI queue turned its task away (stopping, paused), the backlog asks again this much later. */
const REFUSED_WAIT_MS = 60_000;
/** Its tasks failing on this many texts in a row (ai_failed) rest the backlog for FAILURE_STREAK_WAIT_MS. */
export const FAILURE_STREAK = 5;
const FAILURE_STREAK_WAIT_MS = 30 * 60_000;
/** Candidates a round of a step reads: a few spare for a text that turns out too short once trimmed. */
export const CANDIDATES_PER_STEP = 25;
/**
 * Rounds a step reads at most while every candidate of a round turns out too short (each round sets those aside and
 * the next reads past them): 200 texts, a few milliseconds. The step after carries on from there.
 */
export const SET_ASIDE_ROUNDS = 8;
/** last_error of a text set aside. */
const TOO_SHORT = `Fewer than ${MIN_TEXT_FOR_AI} characters once trimmed: too short for Claude to read.`;

/** Why a step started nothing. */
export type BacklogWait =
  /** Its own task is queued or running (one at a time). */
  | 'in_flight'
  /** MAX_PENDING_ANALYSES job analyses are queued or running. */
  | 'pending_limit'
  /** The background gate is shut: an AI hold, or the usage window is nearly used up. */
  | 'paused'
  /** Its last task found Claude unavailable, or its tasks failed FAILURE_STREAK times in a row: it rests. */
  | 'unavailable'
  /** AI_JOB_ANALYSIS_PER_HOUR tasks were started in the last hour. */
  | 'hourly_cap'
  /** The AI queue turned the last task away; it asks again a minute later. */
  | 'refused'
  /** A resume reading is queued, running or due: those go first. */
  | 'resume_first'
  /** Every candidate is analysed or backing off. */
  | 'none'
  /** The step itself failed (logged); the next one tries again. */
  | 'error';

export type BacklogStep =
  | { status: 'off' }
  | { status: 'waiting'; reason: BacklogWait; retryAtMs?: number; detail?: string }
  | { status: 'queued'; jobId: number; taskId: string; deduped: boolean };

export interface JobAnalysisBacklog {
  /** False when the mode, AI_ENABLED or AI_CLI_BACKGROUND_SLOTS rule it out: every step is `off`. */
  readonly enabled: boolean;
  /** The release time (ISO) before which jobs were first seen that go after every newer one. */
  readonly since: string;
  /** One step now: at most one task started. Never rejects. The timers call it; so do tests. */
  tick(): Promise<BacklogStep>;
  /** Ends the timers (an async stop, as features' `start` returns). */
  stop(): Promise<void>;
}

/**
 * v35 INT-A (SP v35 PLAN.md H3 "a held imported job is not sent to the AI job analysis before it is approved", binding):
 * a job held from an admin's import waits for its approval, in both of IMPORT's and ADMIN's markings:
 *   - a read an import held for New jobs: its new_job review marked imported (job-reviews/new-jobs.ts holdNewJob origin
 *     `import`, noteImportedHold): NOT_IMPORT_HELD_SQL, in the candidates and in the admin's count;
 *   - a job made from an import's row, or reopened held for Couldn't verify: its note with no adder, origin `import`. The
 *     candidates leave it out already (jobs.ai_input false while held: jobs/add/import-jobs.ts); the admin's count, which
 *     reads no ai_input, adds NOT_IMPORT_NOTE_HELD_SQL.
 * A pending review holds its job (holdNewJob opens it with the hold; an approval ends both). v35 FIX-PIPE (data D5): a
 * rejected one holds it too: a New jobs rejection changes nothing on the job (job-reviews/decide.ts rejectReview; it
 * stays open and held, review-held.ts REVIEW_HELD_SQL), so a held job whose imported review is pending OR rejected waits
 * (H3: "nothing is spent on rejects"). Only a source TailorIT runs that lists the job ends that hold (ingest/store.ts
 * clearHoldIfListed, which supersedes pending reviews only): published so, its rejected review no longer keeps it out
 * (the held check, read for the few rejected imported reviews alone). Approval decides the review and clears the hold (a
 * write on `jobs`: migrations-pg 0007's mark moves), so the job is a candidate again. Held reads no import made keep
 * their behaviour (a candidate, as before v3.5).
 * The candidates' condition reads no column of the walked `jobs` row but its id, so the walk of idx_jobs_ai_backlog
 * stays an index-only scan (its INCLUDE has content_hash, not held_since: a heap read a job tips the saved mode to a scan
 * of jobs), and the waiting imported reviews are read once a query (a hashed subplan over idx_job_reviews_queue's kind
 * and state): job-analysis-backlog-perf.test.ts checks the plan.
 */
export const NOT_IMPORT_HELD_SQL =
  "j.id NOT IN (SELECT hr.job_id FROM job_reviews hr WHERE hr.kind = 'new_job' AND hr.state IN ('pending', 'rejected') AND hr.imported " +
  "AND (hr.state = 'pending' OR EXISTS (SELECT 1 FROM jobs hj WHERE hj.id = hr.job_id AND hj.held_since IS NOT NULL)))";
/** v35 INT-A: a job made from an admin import's row, held for Couldn't verify (see NOT_IMPORT_HELD_SQL). */
export const NOT_IMPORT_NOTE_HELD_SQL =
  "NOT (j.held_since IS NOT NULL AND j.id IN (SELECT hv.job_id FROM job_verifications hv WHERE hv.user_id IS NULL AND hv.origin = 'import'))";

/**
 * The candidates first seen since the release (`newer`) or before it (`older`), in the backlog's order: newest
 * first_seen_at first, the highest id first among jobs seen at the same time, each with its text's hash. Live jobs with
 * at least MIN_TEXT_FOR_AI characters of text (job_texts.text_chars) whose text has no Claude analysis of the current
 * prompt version and is not backing off in job_ai_attempts; in `saved` mode, only jobs someone has saved. Exported so a
 * test can check its query plan (the admin count, admin-ai/router.ts jobBacklogSql, counts the same jobs).
 *
 * Shaped to stay fast with 50,000 jobs: its WHERE and ORDER BY are idx_jobs_ai_backlog's (`active` its predicate,
 * `first_seen_at DESC, id DESC` its keys), so with @limit the planner walks the index in order and stops; the index
 * holds `content_hash`, so the lookups (the saved entry, the two readings, the backoff) are index probes, and the
 * text's length is the job's job_texts row, read by its key.
 */
export function backlogCandidatesSql(
  part: 'newer' | 'older',
  savedOnly: boolean,
  olderReadings: 'include' | 'exclude' = 'include',
): string {
  return (
    `SELECT j.id, j.content_hash FROM jobs j ${jobTextJoin('j', 'jt')} ` +
    // v30 INT-3 (S1-API edit C, 12 §9.7): never a job whose host's robots.txt says ai-input=no.
    `WHERE j.active AND j.ai_input AND j.first_seen_at ${part === 'newer' ? '>=' : '<'} @since ` +
    // v35 INT-A (H3): never a job held from an admin's import before its approval.
    `AND ${NOT_IMPORT_HELD_SQL} ` +
    (savedOnly ? 'AND EXISTS (SELECT 1 FROM applications p WHERE p.job_id = j.id AND p.current_status = 1 AND p.archived_at IS NULL) ' : '') +
    "AND NOT EXISTS (SELECT 1 FROM job_analyses a WHERE a.content_hash = j.content_hash AND a.source = 'ai' AND a.version = @version) " +
    // v2.0: a text Claude read at an older version is read again only as JOB_ANALYSIS_V2_REREAD says (backlogRereadSql).
    (olderReadings === 'exclude'
      ? "AND NOT EXISTS (SELECT 1 FROM job_analyses o WHERE o.content_hash = j.content_hash AND o.source = 'ai' AND o.version < @version) "
      : '') +
    'AND NOT EXISTS (SELECT 1 FROM job_ai_attempts t WHERE t.content_hash = j.content_hash AND t.version = @version ' +
    'AND t.next_attempt_at > @now) ' +
    'AND jt.text_chars >= @minText ' +
    'ORDER BY j.first_seen_at DESC, j.id DESC LIMIT @limit'
  );
}

/**
 * v2.0 (06, "Reading jobs again for v2"; JOB_ANALYSIS_V2_REREAD `saved`): the live jobs someone has at Saved whose text
 * Claude read at an older prompt version and not at this one, oldest saved first, the text's backoff and length
 * checked as above. It walks the Saved entries (idx_app_saved_job, a partial index of them alone), never the lake.
 */
export function backlogRereadSql(): string {
  return (
    'SELECT j.id, j.content_hash FROM (SELECT p.job_id, min(p.created_at) AS saved_at FROM applications p ' +
    'WHERE p.current_status = 1 AND p.archived_at IS NULL AND p.job_id IS NOT NULL GROUP BY p.job_id) s ' +
    `JOIN jobs j ON j.id = s.job_id ${jobTextJoin('j', 'jt')} ` +
    // v30 INT-3 (S1-API edit C): never a job whose host's robots.txt says ai-input=no.
    'WHERE j.active AND j.ai_input ' +
    "AND EXISTS (SELECT 1 FROM job_analyses o WHERE o.content_hash = j.content_hash AND o.source = 'ai' AND o.version < @version) " +
    "AND NOT EXISTS (SELECT 1 FROM job_analyses a WHERE a.content_hash = j.content_hash AND a.source = 'ai' AND a.version = @version) " +
    'AND NOT EXISTS (SELECT 1 FROM job_ai_attempts t WHERE t.content_hash = j.content_hash AND t.version = @version ' +
    'AND t.next_attempt_at > @now) ' +
    'AND jt.text_chars >= @minText ' +
    'ORDER BY s.saved_at, j.id LIMIT @limit'
  );
}

/** JOB_ANALYSIS_V2_REREAD: which jobs Claude read at an older version the backlog reads again. */
export type RereadScope = 'saved' | 'all' | 'off';

export function rereadScopeOf(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): RereadScope {
  const value = constantsOf(deps).get('JOB_ANALYSIS_V2_REREAD');
  return value === 'all' || value === 'off' ? value : 'saved';
}

/** The release time, recorded the first time this release starts and kept from then on. */
async function backlogSince(deps: Pick<AppDeps, 'db' | 'now'>): Promise<string> {
  const now = nowIso(deps);
  await deps.db.run(deps.db.dialect.insertOrIgnore('app_settings(key, value, updated_at) VALUES (?, ?, ?)'), [
    BACKLOG_SINCE_KEY,
    JSON.stringify(now),
    now,
  ]);
  const row = await deps.db.one<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [BACKLOG_SINCE_KEY]);
  try {
    const value: unknown = JSON.parse(row?.value ?? 'null');
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  } catch {
    /* unreadable: read as now (and leave the stored value alone) */
  }
  return now;
}

/** The SQL a step reads (the candidates' statements are built once per mode). */
const STEP_SQL = {
  tasks:
    "SELECT count(*) AS pending, coalesce(sum(CASE WHEN user_id IS NULL AND priority = 0 THEN 1 ELSE 0 END), 0) AS own " +
    "FROM ai_tasks WHERE kind = 'job_analysis' AND status IN ('queued', 'running')",
  resumeTasks: "SELECT 1 AS found FROM ai_tasks WHERE kind = 'resume_analysis' AND status IN ('queued', 'running') LIMIT 1",
  // A row the resume backlog has queued whose task has not finished (or is unknown: it is about to reconcile it).
  resumeQueued:
    "SELECT 1 AS found FROM resume_analysis_backlog b JOIN users u ON u.id = b.user_id WHERE b.state = 'queued' " +
    'AND u.disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM ai_tasks t WHERE t.id = b.task_id ' +
    "AND t.status IN ('succeeded', 'failed', 'cancelled')) LIMIT 1",
  // A row the resume backlog would start now: waiting (or failed, and its day's wait over), of the current reading
  // version, of an account that is not disabled (it skips those).
  resumeDue:
    "SELECT 1 AS found FROM resume_analysis_backlog b JOIN users u ON u.id = b.user_id WHERE b.state IN ('waiting', 'failed') " +
    'AND b.next_attempt_at <= ? AND b.version = ? AND u.disabled_at IS NULL LIMIT 1',
  resumeStarted: "SELECT count(*) AS n FROM ai_tasks WHERE kind = 'resume_analysis' AND created_at > ?",
  // The write mark (migrations-pg 0007): the sequence every statement on a table the candidates read bumps (ingest
  // adding, rewriting or reopening a job, its text, a save, a reading or a failure stored), with the transaction ids of
  // this database's writers still open. A write the candidates missed because it had not committed yet leaves that
  // list when it commits, so the mark moves then too. Free to read, where no jobs column tells every such change
  // cheaply (max(updated_at) has no index, and a reopened job keeps its id). v3.0 PG-F: SQLite's total_changes() and
  // pragma_data_version before.
  writes:
    "SELECT w.last_value || '.' || w.is_called || ':' || coalesce((SELECT string_agg(a.backend_xid::text, ',' " +
    'ORDER BY a.backend_xid::text) FROM pg_stat_activity a WHERE a.datname = current_database() ' +
    "AND a.backend_type = 'client backend' AND a.backend_xid IS NOT NULL), '') AS mark FROM job_ai_backlog_writes w",
  // When the first backoff ends: its text may be a candidate again.
  backoffEnd: 'SELECT min(next_attempt_at) AS at FROM job_ai_attempts WHERE version = ? AND next_attempt_at > ?',
  // v30 FIX-B (Q13): the backlog's own tasks (system-owned, background, charged to no one: a Prepare's forced reading is
  // the person's) started since today's reset (idx_ai_kind_created).
  ownToday:
    "SELECT count(*) AS n FROM ai_tasks WHERE kind = 'job_analysis' AND user_id IS NULL AND priority = 0 " +
    'AND charge_user_id IS NULL AND created_at >= ?',
} as const;

/** v30 FIX-B: when today's day key began (the last daily reset at or before `at`); a day is 23 to 25 hours long. */
export function dayStartAt(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, at: Date): Date {
  const today = dayKeyAt(deps, at);
  let start = nextDailyResetAt(deps, new Date(at.getTime() - 26 * HOUR_MS));
  while (dayKeyAt(deps, start) !== today && start.getTime() < at.getTime()) start = nextDailyResetAt(deps, start);
  return start;
}

/** The backlog without timers: `tick` runs one step. `startJobAnalysisBacklog` is the one the server runs. */
export function createJobAnalysisBacklog(
  deps: AppDeps,
  service: Pick<JobAnalysisServiceInternals, 'enqueueTask'>,
): Promise<JobAnalysisBacklog> {
  return backlog(deps, service, false);
}

/** The backlog with its timers (the feature's `start`); returns at once when it is off. */
export function startJobAnalysisBacklog(
  deps: AppDeps,
  service: Pick<JobAnalysisServiceInternals, 'enqueueTask'>,
): Promise<JobAnalysisBacklog> {
  return backlog(deps, service, true);
}

async function backlog(
  deps: AppDeps,
  service: Pick<JobAnalysisServiceInternals, 'enqueueTask'>,
  timers: boolean,
): Promise<JobAnalysisBacklog> {
  const { log, config, db } = deps;
  const mode = config.ai.jobAnalysis;
  const offBecause =
    mode !== 'ingest' && mode !== 'saved'
      ? null
      : !config.ai.enabled
        ? 'AI is turned off (AI_ENABLED=false)'
        : config.ai.backgroundSlots <= 0
          ? 'background AI work is turned off (AI_CLI_BACKGROUND_SLOTS=0)'
          : !deps.services.ai
            ? 'AI is not set up on this server'
            : '';
  const enabled = offBecause === '';
  const since = await backlogSince(deps);
  const gate = createBackgroundGate(deps);
  const budget = createHourlyBudget(config.ai.jobAnalysisPerHour, () => deps.now().getTime());
  let refusedUntil = 0;
  /** Its last task (until its outcome is read), and the rest that outcome calls for. */
  let lastTaskId: string | null = null;
  let restUntil = 0;
  let restReason = '';
  let failuresInARow = 0;
  let stopped = false;
  let lastState = '';
  /**
   * After a step that found nothing: the write mark it saw (`writes`), the reread scope it read the candidates in,
   * whether the daily cap held it to saved jobs (`capped`), and when the first backoff then running ends.
   */
  let emptyScan: { writes: string; scope: RereadScope; capped: boolean; untilMs: number } | null = null;
  /** v30 FIX-B: whether the last step was held to saved jobs by AI_JOB_ANALYSIS_INGEST_MAX_PER_DAY (logged on a change). */
  let lastCapped = false;

  const savedOnly = mode === 'saved';
  /** The candidates' statements: the older readings included (`all`) or left out (`saved`, `off`). */
  const statements = (onlySaved: boolean) => ({
    include: { newer: backlogCandidatesSql('newer', onlySaved, 'include'), older: backlogCandidatesSql('older', onlySaved, 'include') },
    exclude: { newer: backlogCandidatesSql('newer', onlySaved, 'exclude'), older: backlogCandidatesSql('older', onlySaved, 'exclude') },
  });
  const candidateSql = statements(savedOnly);
  /** v30 FIX-B (Q13): `ingest` past its daily cap reads as `saved` does. */
  const cappedSql = savedOnly ? candidateSql : statements(true);
  const rereadSql = backlogRereadSql();

  const waiting = (reason: BacklogWait, retryAtMs?: number, detail?: string): BacklogStep => ({
    status: 'waiting',
    reason,
    ...(retryAtMs !== undefined ? { retryAtMs } : {}),
    ...(detail ? { detail } : {}),
  });

  /** Whether a resume reading should have the background slot first: one is queued, running, or due to start. */
  async function resumeReadingFirst(nowMs: number): Promise<boolean> {
    if (await db.one(STEP_SQL.resumeTasks)) return true;
    // With resume reading off, its backlog rows wait for nothing the background slot could do.
    if (config.ai.resumeAnalysis !== 'auto') return false;
    if (await db.one(STEP_SQL.resumeQueued)) return true;
    if (!(await db.one(STEP_SQL.resumeDue, [new Date(nowMs).toISOString(), RESUME_ANALYSIS_VERSION]))) return false;
    // A due row counts while the resume backlog may start one: not past AI_RESUME_ANALYSIS_PER_HOUR.
    const perHour = config.ai.resumeAnalysisPerHour;
    if (perHour <= 0) return true;
    return ((await db.one<{ n: number }>(STEP_SQL.resumeStarted, [new Date(nowMs - HOUR_MS).toISOString()]))?.n ?? 0) < perHour;
  }

  /**
   * Reads how its last task ended, once it has: Claude unavailable rests the backlog AI_OUTAGE_WAIT_MS (the outage is
   * the seat's, not the text's), FAILURE_STREAK failures in a row rest it half an hour, a success ends a streak.
   */
  async function readLastTask(nowMs: number): Promise<void> {
    if (lastTaskId === null) return;
    const task = (await deps.services.ai?.getTask(lastTaskId, null)) ?? null;
    if (task && (task.status === 'queued' || task.status === 'running')) return;
    lastTaskId = null;
    if (!task) return;
    const endedMs = task.finishedAt ? Date.parse(task.finishedAt) : nowMs;
    const rest = (until: number, reason: string) => {
      if (until <= restUntil) return;
      restUntil = until;
      restReason = reason;
    };
    if (task.status === 'succeeded') failuresInARow = 0;
    else if (task.error?.code === 'ai_unavailable') {
      rest(endedMs + AI_OUTAGE_WAIT_MS, `Claude was unavailable: ${task.error.message}`);
    } else if (task.error?.code === 'ai_failed') {
      failuresInARow += 1;
      if (failuresInARow >= FAILURE_STREAK) {
        failuresInARow = 0;
        const reason = `Claude's analysis failed for ${FAILURE_STREAK} jobs in a row`;
        rest(endedMs + FAILURE_STREAK_WAIT_MS, reason);
        log.warn(`[job-analysis] AI backlog: ${reason}; resting for 30 minutes`);
      }
    }
  }

  /**
   * The first candidate Claude can read, and the texts before it too short for that once trimmed. The candidates come
   * in the backlog's order, CANDIDATES_PER_STEP at most: the jobs first seen since the release, then older ones in the
   * room left (what one query over both would answer); the older ones are read only when the newer ones leave the step
   * without a task.
   */
  async function firstReadable(now: string, scope: RereadScope, capped: boolean): Promise<{ jobId: number | null; tooShort: string[] }> {
    const tooShort: string[] = [];
    let room = CANDIDATES_PER_STEP;
    const params = { minText: MIN_TEXT_FOR_AI, version: JOB_ANALYSIS_PROMPT_VERSION, now };
    // v2.0: JOB_ANALYSIS_V2_REREAD (read at each step by `step`: an admin may change it). `saved`: the Saved jobs read at
    // an older version go first (there are few of them, and Prepare and the filters read them), then the new jobs;
    // `all`: every job read at an older version is a candidate in the backlog's own order; `off`: none of them is.
    const queries = (capped ? cappedSql : candidateSql)[scope === 'all' ? 'include' : 'exclude'];
    type Candidate = { id: number; content_hash: string };
    const reads: Array<(limit: number) => Promise<Candidate[]>> = [];
    if (scope === 'saved') reads.push((limit) => db.all<Candidate>(rereadSql, { ...params, limit }));
    for (const query of [queries.newer, queries.older]) reads.push((limit) => db.all<Candidate>(query, { ...params, since, limit }));
    for (const read of reads) {
      if (room <= 0) break;
      const rows = await read(room);
      room -= rows.length;
      for (const row of rows) {
        // v3.0 PG-F: the text through features/jobs/text.ts; text_chars let it through, readableForAi decides.
        if (readableForAi((await readJobText(db, row.id))?.text ?? '')) return { jobId: row.id, tooShort };
        tooShort.push(row.content_hash);
      }
    }
    return { jobId: null, tooShort };
  }

  /**
   * v30 FIX-B (Q13): whether `ingest` has read AI_JOB_ANALYSIS_INGEST_MAX_PER_DAY jobs since today's reset, so this step
   * reads saved jobs only (`saved` mode reads them anyway).
   */
  async function ingestCapped(nowMs: number): Promise<boolean> {
    if (savedOnly) return false;
    const cap = constantsOf(deps).get('AI_JOB_ANALYSIS_INGEST_MAX_PER_DAY');
    const since = dayStartAt(deps, new Date(nowMs)).toISOString();
    const started = (await db.one<{ n: number }>(STEP_SQL.ownToday, [since]))?.n ?? 0;
    const capped = started >= cap;
    if (capped !== lastCapped) {
      lastCapped = capped;
      if (capped) log.info(`[job-analysis] AI backlog: ${started} new job(s) read today (AI_JOB_ANALYSIS_INGEST_MAX_PER_DAY); saved jobs only until the daily reset`);
    }
    return capped;
  }

  async function step(): Promise<BacklogStep> {
    const nowMs = deps.now().getTime();
    const tasks = (await db.one<{ pending: number; own: number }>(STEP_SQL.tasks)) ?? { pending: 0, own: 0 };
    if (tasks.own > 0) return waiting('in_flight');
    if (tasks.pending >= MAX_PENDING_ANALYSES) return waiting('pending_limit');
    await readLastTask(nowMs);
    const gateAnswer = gate.allowed();
    if (!gateAnswer.ok) return waiting('paused', gateAnswer.retryAtMs, gateAnswer.reason);
    if (restUntil > nowMs) return waiting('unavailable', restUntil, restReason);
    const nextAt = budget.nextAtMs(nowMs);
    if (nextAt > nowMs) return waiting('hourly_cap', nextAt);
    if (refusedUntil > nowMs) return waiting('refused', refusedUntil);
    if (await resumeReadingFirst(nowMs)) return waiting('resume_first');

    // Nothing written since a step found nothing, the reread scope the same, and no backoff over since: this one would
    // find nothing either. The mark is read before the candidates, so a write that lands meanwhile makes the next step
    // look again.
    const writes = (await db.one<{ mark: string }>(STEP_SQL.writes))?.mark ?? null;
    const scope = rereadScopeOf(deps);
    const capped = await ingestCapped(nowMs);
    if (emptyScan && emptyScan.writes === writes && emptyScan.scope === scope && emptyScan.capped === capped && nowMs < emptyScan.untilMs) {
      return waiting('none');
    }
    emptyScan = null;
    const now = new Date(nowMs).toISOString();
    // Texts too short for Claude leave the candidates as a round meets them, so the next round reads past them. Setting
    // them aside moves the write mark: a step that stops at SET_ASIDE_ROUNDS leaves the next one to look again.
    for (let round = 0; round < SET_ASIDE_ROUNDS; round += 1) {
      const { jobId, tooShort } = await firstReadable(now, scope, capped);
      await setAsideAiTexts(db, { contentHashes: tooShort, version: JOB_ANALYSIS_PROMPT_VERSION, message: TOO_SHORT, now: new Date(nowMs) });
      if (jobId !== null) {
        const accepted = await service.enqueueTask(jobId, 'background');
        if (!accepted) {
          refusedUntil = nowMs + REFUSED_WAIT_MS;
          return waiting('refused', refusedUntil);
        }
        if (!accepted.deduped) budget.take();
        lastTaskId = accepted.taskId;
        return { status: 'queued', jobId, ...accepted };
      }
      if (tooShort.length === 0) break;
    }
    if (writes !== null) {
      const backoffEnd = (await db.one<{ at: string | null }>(STEP_SQL.backoffEnd, [JOB_ANALYSIS_PROMPT_VERSION, now]))?.at;
      emptyScan = { writes, scope, capped, untilMs: backoffEnd ? Date.parse(backoffEnd) : Number.POSITIVE_INFINITY };
    }
    return waiting('none');
  }

  /** Logs what changed: a pause or a cap at info level, routine steps at debug. */
  function report(result: BacklogStep): void {
    const state = result.status === 'waiting' ? result.reason : result.status;
    if (result.status === 'queued') {
      log.debug(`[job-analysis] AI backlog: queued job ${result.jobId}${result.deduped ? ' (already queued)' : ''}`);
    } else if (state !== lastState && result.status === 'waiting') {
      if (result.reason === 'paused' || result.reason === 'unavailable') {
        log.info(`[job-analysis] AI backlog paused: ${result.detail ?? 'AI is resting'}`);
      } else if (result.reason === 'hourly_cap') {
        log.info(`[job-analysis] AI backlog: ${config.ai.jobAnalysisPerHour} job(s) this hour (AI_JOB_ANALYSIS_PER_HOUR); waiting`);
      } else log.debug(`[job-analysis] AI backlog waiting: ${result.reason}`);
    }
    lastState = state;
  }

  /** One step at a time: a tick while one runs answers that one's step. */
  let running: Promise<BacklogStep> | null = null;
  const tick = (): Promise<BacklogStep> => {
    running ??= stepOnce().finally(() => {
      running = null;
    });
    return running;
  };
  const stepOnce = async (): Promise<BacklogStep> => {
    if (!enabled || stopped) return { status: 'off' };
    try {
      const result = await step();
      report(result);
      return result;
    } catch (error) {
      log.warn('[job-analysis] an AI backlog step failed; the next one tries again', error);
      return waiting('error');
    }
  };

  if (!timers) return { enabled, since, tick, stop: async () => void (stopped = true) };
  if (!enabled) {
    if (offBecause) log.info(`[job-analysis] AI backlog is off: ${offBecause}`);
    return { enabled, since, tick, stop: async () => void (stopped = true) };
  }

  let soon: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    void tick()
      .then((result) => {
        // Its task finishing is what starts the next one, at once, so the background slot is not left idle.
        if (result.status === 'queued') void deps.services.ai?.waitFor(result.taskId).then(nudge, nudge);
      })
      .catch((error: unknown) => log.warn('[job-analysis] the AI backlog timer failed; it carries on', error));
  };
  const nudge = () => {
    if (stopped || soon) return;
    soon = setTimeout(() => {
      soon = null;
      run();
    }, NUDGE_MS);
    soon.unref?.();
  };
  const interval = setInterval(run, BACKLOG_TICK_MS);
  interval.unref?.();
  nudge();
  log.info(
    `[job-analysis] AI backlog: Claude reads each ${mode === 'saved' ? 'saved' : 'added'} job once, newest first` +
      (config.ai.jobAnalysisPerHour > 0 ? `, at most ${config.ai.jobAnalysisPerHour} an hour` : ''),
  );
  return {
    enabled,
    since,
    tick,
    async stop() {
      stopped = true;
      clearInterval(interval);
      if (soon) clearTimeout(soon);
      soon = null;
    },
  };
}
