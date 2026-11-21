import { RESUME_ANALYSIS_VERSION, type AiTaskView } from '@tailorit/shared';
import { createBackgroundGate, createHourlyBudget } from '../../../ai/background';
import type { AiService } from '../../../ai/queue';
import { constantsOf } from '../../../core/constants/service';
import { nextDailyResetAt } from '../../../core/constants/day';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { BACKLOG_PAYER_SQL, backlogPayerOf, isAccessEnded } from '../backlog-payer'; // v33 SHARE-3
import { BACKLOG_ACCESS_ENDED } from '../end-grant'; // v33 SHARE-3
import type { ResumeAnalysisBackfill } from './backfill';
import { resumeAnalysisEnabled, reuseAiReading } from './store';
import type { ResumeAnalysisTaskInput, ResumeAnalysisTaskResult } from './task';

// Claude's reading of uploads (the `resume_analysis` task), from the durable backlog in resume_analysis_backlog. The
// worker keeps ONE task in flight server-wide, on the background slot and owned by the uploader (dedupe key
// resume_analysis:<resumeId>:<hash>:<version>), so uploads never wait on Claude and never fail with "AI busy".
//   - Order: the account served least recently first (fairness across people), then the oldest upload.
//   - Reuse: when the account already has Claude's reading of the same text (a duplicate, a re-upload), it is copied.
//   - Pauses: the background gate (any AI hold, a usage warning) and the hourly budget (AI_RESUME_ANALYSIS_PER_HOUR);
//     disabled accounts wait.
//   - Attempts: only a failed reading counts (3, with 30 and 60 minutes between, then 'failed', tried again after
//     24 h). An outage (ai_unavailable) waits for the hold to end, at least 5 minutes, without counting; a restart
//     (interrupted) or a cancel does not count either.
//   - v2.0: a reading is charged to the uploader. When their daily AI usage and extra credit are used up (the AI queue
//     answers ai_usage_exhausted, at the start or as the task was about to run), that person's uploads wait until the
//     daily reset, uncounted; the next person's upload is read meanwhile.
// Off when AI is off, AI_RESUME_ANALYSIS=off or AI_CLI_BACKGROUND_SLOTS=0; uploads then keep the rules' reading. The
// task handler stays registered either way. No timer runs before start(). v3.0 D2: every step reads and writes through
// the async client, and the timer runs one step at a time.
// v33 SHARE-3 (PLAN F9 "Who pays"; SP v33 PLAN-sharing.md §5 "Resume backlogs"): a row names who pays for its reading
// (charge_user_id, grant_id: B for an upload B made on A's profile; NULL the owner). The reading is charged to that
// payer, and fairness, the usage deferral and the "used up" set read the payer (coalesce(charge_user_id, user_id)):
// B's uploads on 10 profiles get one person's share, and B's spent budget never holds A's own uploads (nor the
// reverse). A row whose grant ended (or lost documents:edit) is skipped with why (endGrant's `backlogs` step does it
// for the rows waiting; the queue refuses the rest at enqueue and at run).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Failed readings before an upload is marked 'failed'. */
export const RESUME_ANALYSIS_ATTEMPTS = 3;
/** The wait after the first and second failed reading. */
const RETRY_AFTER_MS = [30 * MINUTE, 60 * MINUTE];
/** A 'failed' upload is tried once more after this long. */
export const FAILED_RETRY_MS = 24 * HOUR;
/** An outage waits at least this long (or until the hold ends). */
export const UNAVAILABLE_WAIT_MS = 5 * MINUTE;
const BUSY_WAIT_MS = MINUTE;
const CANCELLED_WAIT_MS = 5 * MINUTE;
const OTHER_WAIT_MS = 5 * MINUTE;
const CANDIDATES = 25;
const FIRST_TICK_MS = 2_000;
const POLL_MS = 15_000;
const NUDGE_MS = 500;

export interface ResumeAnalysisBacklog {
  /** Whether this server has Claude read uploads (see the header). */
  readonly enabled: boolean;
  /**
   * One step now (the timer calls it; tests too): settles finished tasks, then starts the next reading when nothing
   * is in flight and the gate and the budget allow. Returns the task started, or null.
   */
  tick(): Promise<string | null>;
  /**
   * Whether a reading is in flight, or one could start now (an upload is due and the hourly budget has room). Other
   * background AI work (the job backlog) yields while it is true: resume readings go first.
   */
  pending(): Promise<boolean>;
  /** A step soon (after an upload, or when a reading finished). Only once started. */
  nudge(): void;
  /** Starts the timer; returns the stop function. */
  start(): () => Promise<void>;
}

/** Both resume-reading workers (work package WP3): the rules' backfill and Claude's backlog. */
export interface ResumeAnalysisService {
  readonly backlog: ResumeAnalysisBacklog;
  readonly backfill: ResumeAnalysisBackfill;
}

declare module '../../../core/context' {
  interface AppServices {
    /** What TailorIT reads from resumes: the backfill of rule-based readings and Claude's backlog for uploads. */
    resumeAnalysis?: ResumeAnalysisService;
  }
}

interface QueuedRow {
  resume_id: string;
  content_hash: string;
  version: number;
  attempts: number;
  task_id: string | null;
  /** v33 SHARE-3: whose upload, and who pays for its reading (NULL: the owner). */
  user_id: string;
  charge_user_id: string | null;
}

interface CandidateRow {
  resume_id: string;
  user_id: string;
  content_hash: string;
  version: number;
  /** v33 SHARE-3: who pays (NULL: the owner) and under which grant. */
  charge_user_id: string | null;
  grant_id: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** v33 SHARE-3: who pays for a row's reading (its charge_user_id, else its owner). */
const payerIdOf = (row: { user_id: string; charge_user_id: string | null }) => row.charge_user_id ?? row.user_id;

/** The dedupe key of an upload's reading (the queue scopes it by owner). */
export function resumeAnalysisDedupeKey(input: ResumeAnalysisTaskInput): string {
  return `resume_analysis:${input.resumeId}:${input.contentHash}:${input.version}`;
}

const SQL = {
  queued:
    "SELECT resume_id, content_hash, version, attempts, task_id, user_id, charge_user_id FROM resume_analysis_backlog WHERE state = 'queued'",
  active: "SELECT count(*) AS n FROM ai_tasks WHERE kind = 'resume_analysis' AND status IN ('queued', 'running')",
  // The payer served least recently first (never served: first), then the oldest upload. v33 SHARE-3: by payer (B's
  // uploads on every profile are one person's turn), and both the owner and the payer must be enabled.
  candidates: `SELECT b.resume_id, b.user_id, b.content_hash, b.version, b.charge_user_id, b.grant_id
       FROM resume_analysis_backlog b
       JOIN users u ON u.id = b.user_id
       JOIN users p ON p.id = ${BACKLOG_PAYER_SQL('b')}
       LEFT JOIN (SELECT ${BACKLOG_PAYER_SQL('r')} AS payer, max(r.started_at) AS served FROM resume_analysis_backlog r
                   GROUP BY ${BACKLOG_PAYER_SQL('r')}) s
         ON s.payer = ${BACKLOG_PAYER_SQL('b')}
       WHERE b.state IN ('waiting', 'failed') AND b.next_attempt_at <= ? AND b.version = ? AND u.disabled_at IS NULL
         AND p.disabled_at IS NULL
       ORDER BY s.served IS NOT NULL, s.served, b.created_at, b.resume_id
       LIMIT ${CANDIDATES}`,
  anyDue: `SELECT 1 AS ok FROM resume_analysis_backlog b JOIN users u ON u.id = b.user_id
       WHERE b.state IN ('waiting', 'failed') AND b.next_attempt_at <= ? AND b.version = ? AND u.disabled_at IS NULL
       LIMIT 1`,
  hasReading: "SELECT 1 AS ok FROM resume_analyses WHERE resume_id = ? AND source = 'ai' AND content_hash = ? AND version = ?",
  // `IS NOT DISTINCT FROM`: the same task, or none on both sides (what SQLite's `IS` said; both engines read this).
  settle: `UPDATE resume_analysis_backlog SET state = @state, attempts = @attempts, next_attempt_at = @next,
         last_error = @error, updated_at = @now
       WHERE resume_id = @resumeId AND state = 'queued' AND task_id IS NOT DISTINCT FROM @taskId`,
  defer: `UPDATE resume_analysis_backlog SET next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE resume_id = ? AND state IN ('waiting', 'failed')`,
  // v2.0: every upload of the person waits for the daily reset (never sooner than a later attempt already set). A CASE
  // rather than SQLite's two-argument max(), which PostgreSQL spells greatest(). v33 SHARE-3: every upload that person
  // pays for, on any profile (never the owner's own when someone else's budget ran out).
  deferUser: `UPDATE resume_analysis_backlog
         SET next_attempt_at = CASE WHEN next_attempt_at > @until THEN next_attempt_at ELSE @until END,
           last_error = @error, updated_at = @now
       WHERE ${BACKLOG_PAYER_SQL('resume_analysis_backlog')} = @userId AND state IN ('waiting', 'failed')`,
  // v33 SHARE-3: the grant the row's reading was paid under ended (or lost documents:edit): it is not read.
  accessEnded: `UPDATE resume_analysis_backlog SET state = 'skipped', last_error = ?, updated_at = ?
       WHERE resume_id = ? AND state IN ('waiting', 'failed')`,
  started: `UPDATE resume_analysis_backlog SET state = 'queued', task_id = ?, started_at = ?, updated_at = ?
       WHERE resume_id = ? AND content_hash = ? AND version = ?`,
};

export function createResumeAnalysisBacklog(deps: AppDeps): ResumeAnalysisBacklog {
  const { log, db } = deps;
  const enabled = resumeAnalysisEnabled(deps);
  const gate = createBackgroundGate(deps);
  const budget = createHourlyBudget(deps.config.ai.resumeAnalysisPerHour, () => deps.now().getTime());
  let schedule: ((delayMs: number) => void) | null = null;
  let pausedFor = '';

  /** Until when an outage keeps an upload waiting: the end of the hold that turns its call away, at least 5 minutes. */
  function outageUntil(ai: AiService, nowMs: number, retryAfterSeconds?: number): number {
    const hold = ai.provider.holdFor('resume_analysis');
    return Math.max(nowMs + UNAVAILABLE_WAIT_MS, hold?.until ?? 0, retryAfterSeconds ? nowMs + retryAfterSeconds * 1000 : 0);
  }

  /** v2.0: the daily reset after `nowMs`, when a person whose AI usage is used up may be read again. */
  const resetAfter = (nowMs: number) => nextDailyResetAt(deps, new Date(nowMs)).getTime();

  const activeTasks = async (): Promise<number> => (await db.one<{ n: number }>(SQL.active))?.n ?? 0;

  /** v33 SHARE-3: whether a row's reading is paid by someone other than the upload's owner. */
  const paidByOther = (row: { user_id: string; charge_user_id: string | null }) =>
    row.charge_user_id !== null && row.charge_user_id !== row.user_id;

  /** What a finished task means for its upload's row. */
  async function settle(ai: AiService, row: QueuedRow, task: AiTaskView | null, nowMs: number): Promise<void> {
    const base = { resumeId: row.resume_id, taskId: row.task_id, attempts: row.attempts, now: iso(nowMs) };
    const update = async (state: string, next: number, error: string | null, attempts = row.attempts): Promise<void> => {
      await db.run(SQL.settle, { ...base, state, attempts, next: iso(next), error });
    };
    if (!task) {
      await update('waiting', nowMs, 'Its AI task was not found; it is read again.');
      return;
    }
    if (task.status === 'succeeded') {
      if (await db.one(SQL.hasReading, [row.resume_id, row.content_hash, row.version])) {
        await update('done', nowMs, null);
        return;
      }
      const skipped = (task.result as ResumeAnalysisTaskResult | null)?.skipped;
      // A reading of another version (the server was updated meanwhile) is asked for again; anything else that
      // stored nothing (text that cannot be read) is not, so a reading never loops.
      if (skipped === 'outdated' || skipped === 'changed') await update('waiting', nowMs, null);
      else await update('skipped', nowMs, skipped === 'unreadable' ? 'Its text could not be read.' : 'Nothing was read.');
      return;
    }
    if (task.status === 'cancelled') {
      await update('waiting', nowMs + CANCELLED_WAIT_MS, task.error?.message ?? 'The reading was cancelled.');
      return;
    }
    const code = task.error?.code;
    const message = task.error?.message ?? 'The AI reading failed.';
    if (code === 'interrupted') {
      await update('waiting', nowMs, message);
    } else if (code === 'ai_unavailable') {
      await update('waiting', outageUntil(ai, nowMs), message);
    } else if (code === 'ai_usage_exhausted') {
      // v2.0: the person's usage ran out before the reading ran: it waits for the daily reset, uncounted. v33 SHARE-3:
      // the payer's usage; a row someone else pays for keeps their full refusal to them (payer_limit's words here).
      await update('waiting', resetAfter(nowMs), paidByOther(row) ? constantsOf(deps).message('MSG_AI_PAYER_LIMIT') : message);
    } else if (code === 'profile_ended' || code === 'profile_not_shared') {
      // v33 SHARE-3: the grant its reading was paid under ended before it ran: it is not read.
      await update('skipped', nowMs, BACKLOG_ACCESS_ENDED);
    } else {
      // A failed reading (ai_failed; an unexpected error is recorded as that too).
      const attempts = row.attempts + 1;
      if (attempts >= RESUME_ANALYSIS_ATTEMPTS) await update('failed', nowMs + FAILED_RETRY_MS, message, attempts);
      else await update('waiting', nowMs + RETRY_AFTER_MS[Math.min(attempts, RETRY_AFTER_MS.length) - 1]!, message, attempts);
    }
  }

  /** Settles every finished task; true while one is still queued or running. */
  async function reconcile(ai: AiService, nowMs: number): Promise<boolean> {
    let inFlight = false;
    for (const row of await db.all<QueuedRow>(SQL.queued)) {
      try {
        const task = row.task_id ? await ai.getTask(row.task_id, null) : null;
        if (task && (task.status === 'queued' || task.status === 'running')) {
          inFlight = true;
          continue;
        }
        await settle(ai, row, task, nowMs);
      } catch (error) {
        log.warn(`[resume-analysis] could not settle the reading of resume ${row.resume_id}`, error);
      }
    }
    return inFlight;
  }

  function pause(reason: string): null {
    if (reason !== pausedFor) log.info(`[resume-analysis] AI readings of uploads wait: ${reason}`);
    pausedFor = reason;
    return null;
  }

  /**
   * Starts one upload's reading: its task id, null to try the next upload, 'stop' when no upload can start now, or
   * 'user' (v2.0) when the uploader's AI usage is used up: their uploads wait, and the next person's may start.
   */
  async function begin(ai: AiService, row: CandidateRow, nowMs: number): Promise<string | null | 'stop' | 'user'> {
    const input: ResumeAnalysisTaskInput = { resumeId: row.resume_id, contentHash: row.content_hash, version: row.version };
    const now = iso(nowMs);
    try {
      const accepted = await ai.enqueue({
        kind: 'resume_analysis',
        userId: row.user_id,
        input,
        priority: 'background',
        dedupeKey: resumeAnalysisDedupeKey(input),
        chargeTo: backlogPayerOf(row), // v33 SHARE-3: who pays (B under the grant; the queue checks it is still live)
      });
      if (!accepted.deduped) budget.take();
      await db.run(SQL.started, [accepted.taskId, now, now, row.resume_id, row.content_hash, row.version]);
      return accepted.taskId;
    } catch (error) {
      const app = error instanceof AppError ? error : null;
      const message = app?.message ?? 'The AI reading could not be started.';
      if (app?.code === 'ai_busy') {
        await db.run(SQL.defer, [iso(nowMs + BUSY_WAIT_MS), message, now, row.resume_id]);
        return null;
      }
      if (app?.code === 'ai_unavailable') {
        await db.run(SQL.defer, [iso(outageUntil(ai, nowMs, app.retryAfterSeconds)), message, now, row.resume_id]);
        return 'stop';
      }
      if (app?.code === 'ai_usage_exhausted') {
        // v33 SHARE-3: the payer's uploads wait (B's on every profile; the owner's own are not held by B's budget).
        const error = paidByOther(row) ? constantsOf(deps).message('MSG_AI_PAYER_LIMIT') : message;
        await db.run(SQL.deferUser, { until: iso(resetAfter(nowMs)), error, now, userId: payerIdOf(row) });
        return 'user';
      }
      if (isAccessEnded(error)) {
        // v33 SHARE-3: the grant its reading would be paid under ended: the upload is not read (A may ask again).
        await db.run(SQL.accessEnded, [BACKLOG_ACCESS_ENDED, now, row.resume_id]);
        return null;
      }
      log.warn(`[resume-analysis] could not start the reading of resume ${row.resume_id}`, error);
      await db.run(SQL.defer, [iso(nowMs + OTHER_WAIT_MS), message, now, row.resume_id]);
      return null;
    }
  }

  const tick = async (): Promise<string | null> => {
    if (!enabled) return null;
    const ai = deps.services.ai;
    if (!ai) return null;
    const nowMs = deps.now().getTime();
    if ((await reconcile(ai, nowMs)) || (await activeTasks()) > 0) return null;
    const gateAnswer = gate.allowed();
    if (!gateAnswer.ok) return pause(gateAnswer.reason);
    if (budget.nextAtMs(nowMs) > nowMs) return pause('the hourly limit (AI_RESUME_ANALYSIS_PER_HOUR) is reached');
    pausedFor = '';
    /** v2.0: the people whose usage is used up, met in this step: their other uploads are not asked for again. */
    const usedUp = new Set<string>();
    for (const row of await db.all<CandidateRow>(SQL.candidates, [iso(nowMs), RESUME_ANALYSIS_VERSION])) {
      if (usedUp.has(payerIdOf(row))) continue; // v33 SHARE-3: by payer
      // Claude read this text for this account already: copied, nothing asked.
      if (await reuseAiReading(deps, { resumeId: row.resume_id, userId: row.user_id, contentHash: row.content_hash })) continue;
      const started = await begin(ai, row, nowMs);
      if (started === 'stop') return null;
      if (started === 'user') {
        usedUp.add(payerIdOf(row));
        continue;
      }
      if (started) return started;
    }
    return null;
  };

  return {
    enabled,
    tick,
    async pending() {
      if (!enabled) return false;
      try {
        if ((await activeTasks()) > 0) return true;
        const nowMs = deps.now().getTime();
        if (budget.nextAtMs(nowMs) > nowMs) return false;
        return Boolean(await db.one(SQL.anyDue, [iso(nowMs), RESUME_ANALYSIS_VERSION]));
      } catch (error) {
        log.warn('[resume-analysis] could not tell whether a reading is due', error);
        return false;
      }
    },
    nudge() {
      schedule?.(NUDGE_MS);
    },
    start() {
      if (!enabled) return async () => {};
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      let running: Promise<void> | null = null;
      const run = () => {
        timer = null;
        dueAt = Number.POSITIVE_INFINITY;
        if (stopped || running) return;
        // One step at a time: the next is scheduled once this one has ended.
        running = (async () => {
          try {
            await tick();
          } catch (error) {
            log.warn('[resume-analysis] a step of the AI reading backlog failed', error);
          } finally {
            running = null;
            schedule?.(POLL_MS);
          }
        })();
      };
      // Timers use the wall clock (the app's clock is frozen in tests); the logic reads deps.now().
      schedule = (delayMs) => {
        if (stopped) return;
        const at = Date.now() + delayMs;
        if (timer && dueAt <= at) return;
        if (timer) clearTimeout(timer);
        dueAt = at;
        timer = setTimeout(run, delayMs);
        timer.unref?.();
      };
      schedule(FIRST_TICK_MS);
      const perHour = deps.config.ai.resumeAnalysisPerHour;
      log.info(`[resume-analysis] Claude reads each upload, one at a time${perHour > 0 ? `, at most ${perHour} an hour` : ''}`);
      return async () => {
        stopped = true;
        schedule = null;
        if (timer) clearTimeout(timer);
        timer = null;
        await running;
      };
    },
  };
}
