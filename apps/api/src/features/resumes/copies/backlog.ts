import { ResumeImportTaskResultSchema, resolveTemplateId, type AiTaskView, type ResumeCopyState } from '@tailorit/shared';
import { createBackgroundGate, WARNING_PAUSE_MS } from '../../../ai/background';
import { AI_ERROR_MESSAGES, MAX_ACTIVE_PER_USER_KIND, type AiService } from '../../../ai/index';
import type { RateLimitReading } from '../../../ai/provider/types';
import { taskInputSql } from '../../../ai/payloads';
import { constantsOf } from '../../../core/constants/service';
import { nextDailyResetAt } from '../../../core/constants/day';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { BACKLOG_PAYER_SQL, backlogPayerOf, isAccessEnded } from '../backlog-payer'; // v33 SHARE-3
import { assertRoomForResumes } from '../repository';
import { copiesOffMessage, isNoRoom, type CopyErrorCode } from './store';

// The copy line: the editable copies asked for with several uploads at once (the Upload dialog's "Make an editable
// copy with AI" for many files), from the durable rows of resume_copy_backlog (./store.ts writes one with each upload).
// Each copy is the `resume_import` task a copy asked for alone runs too (interactive priority, owned by the uploader,
// dedupe key resume_import:<uploadId>), started under these rules:
//   - One at a time per account: a copy starts only while the account has no `resume_import` task queued or running,
//     so of its MAX_ACTIVE_PER_USER_KIND places, a copy asked for alone always finds one.
//   - At most half the AI slots server-wide (AI_CLI_CONCURRENCY / 2, at least one), counted from the line's own tasks
//     (their input is marked copyLine), so a copy whose upload is deleted while it is made holds its slot until its
//     task ends. The account served least recently first (its last `resume_import` task, which neither Dismiss nor a
//     deleted upload removes), then the oldest copy; disabled accounts wait.
//   - Only while the background gate is open (any AI hold, or a usage warning, shuts it), so a run of copies never
//     spends the shared seat's last room. "Make editable copy" on an upload makes that one at once; its row follows it.
//   - An AI pause only holds a copy until it ends, uncounted. A restart (interrupted) puts it back in line, and so does
//     an outage with no pause (5 minutes later); the third time, it fails with the reason and can be tried again.
//   - A copy the account has no room to keep (the resume limit: the plan's, or the safety cap) fails before any AI call.
//   - v2.0: a copy is charged to its person. When their daily AI usage and extra credit are used up (the AI queue
//     answers ai_usage_exhausted, at the start or when the task was about to run), that person's copies wait until
//     the daily reset, uncounted, marked error_code 'usage', and their view says why (pause reason `usage`). Other
//     people's copies are unaffected.
// Off when AI is off or the server has no AI service: the rows then wait (GET /api/resumes/copies says why). While AI
// is off, the timer still settles the copies a previous run left being made: made, or failed with the AI-off sentence
// (Try again once AI is on). No timer runs before start().
// v33 SHARE-3 (PLAN F9 "Who pays"; SP v33 PLAN-sharing.md §5 "Resume backlogs"): each row names who pays for its copy
// (charge_user_id, grant_id; NULL: the owner). "Per account" above is per payer: one copy at a time per payer, the payer
// served least recently first (B's copies on 10 profiles are one person's turn), and a spent budget holds only the
// rows that payer pays for (B's on every profile; never A's own). A copy B pays for never takes A's last resume places
// (SHARING_RESUME_RESERVE). A row whose grant ended, or lost documents:edit, is stopped (endGrant's `backlogs` step
// stops those waiting; the queue refuses the rest at enqueue and at run). Its owner may Try again, at their own cost.

const MINUTE = 60_000;
/** A restart or an outage with no AI pause puts a copy back in line; the third time, it fails. */
export const COPY_TRIES = 3;
/** A restart cut off the third try. The tries before it may have met an outage instead, so it names only this one. */
export const COPY_INTERRUPTED = 'The server restarted while this copy was being made, on its third try. Try again.';
/** An outage with no AI pause: the copy is tried again this much later. */
const OUTAGE_WAIT_MS = 5 * MINUTE;
/** The AI queue turned the copy away (the server is stopping, say): it asks again at least this much later. */
const REFUSED_WAIT_MS = MINUTE;
const OTHER_WAIT_MS = 5 * MINUTE;
const CANDIDATES = 25;
const FIRST_TICK_MS = 2_000;
const POLL_MS = 15_000;
const NUDGE_MS = 500;

/**
 * Why the copies in line wait, as the server knows it: AI off, a spent usage window ('limit'), another AI pause
 * ('hold'), a usage warning, or (v2.0) the person's own AI usage used up ('usage'), and until when. For the log and
 * admin views only: a person is told personPause of it (store.ts), never the server's state.
 */
export interface CopyLineWait {
  reason: 'off' | 'limit' | 'hold' | 'warning' | 'usage';
  until: string | null;
}

export interface ResumeCopyBacklog {
  /** Whether this server makes the copies: AI on, with an AI service. */
  readonly enabled: boolean;
  /**
   * One step now (the timer calls it; tests too): settles the copies whose task finished, then starts what the rules
   * allow (nothing while the line is off: it only settles). Returns the tasks started.
   */
  tick(): Promise<string[]>;
  /**
   * Why the copies in line wait now (AI off, an AI pause, a usage warning; v2.0, with `userId`: that person's own AI
   * usage used up), and until when; null when they do not.
   */
  waitReason(userId?: string): Promise<CopyLineWait | null>;
  /** A step soon (a copy put in line or tried again, a copy finished). Only once started. */
  nudge(): void;
  /** Starts the timer (while AI is off, one that only settles); returns the stop function. */
  start(): () => Promise<void>;
}

declare module '../../../core/context' {
  interface AppServices {
    /** The line of editable copies of several uploads (resume_copy_backlog). */
    resumeCopies?: ResumeCopyBacklog;
  }
}

interface MakingRow {
  id: string;
  user_id: string;
  task_id: string | null;
  retries: number;
  /** v33 SHARE-3: who pays (NULL: the owner). */
  charge_user_id: string | null;
}

interface CandidateRow {
  id: string;
  user_id: string;
  source_resume_id: string;
  template_id: string | null;
  /** v33 SHARE-3: who pays (NULL: the owner) and under which grant. */
  charge_user_id: string | null;
  grant_id: string | null;
}

/** v33 SHARE-3: who pays for a row's copy (its charge_user_id, else its owner). */
const payerIdOf = (row: { user_id: string; charge_user_id: string | null }) => row.charge_user_id ?? row.user_id;

/** How a settled copy's row is written (the rest of it is left as it was). */
interface Outcome {
  next?: number;
  retries?: number;
  code?: CopyErrorCode;
  message?: string;
  resumeId?: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * What the seat's last usage reading says while it still shuts the background gate (the rule of ai/background.ts):
 * 'reached' for a spent window or paid overage, which outlasts the provider's own hold on it (at most 30 minutes),
 * 'warning' for a window nearly used up; null when it does not shut the gate.
 */
function readingNow(reading: RateLimitReading | null, nowMs: number): 'reached' | 'warning' | null {
  if (!reading || (!reading.usingOverage && (reading.status === '' || reading.status === 'allowed'))) return null;
  if ((reading.resetsAtMs ?? reading.seenAtMs + WARNING_PAUSE_MS) <= nowMs) return null;
  return !reading.usingOverage && reading.status === 'allowed_warning' ? 'warning' : 'reached';
}

export function createResumeCopyBacklog(deps: AppDeps): ResumeCopyBacklog {
  const { log, db } = deps;
  const d = db.dialect;
  const offMessage = copiesOffMessage(deps);
  const enabled = offMessage === null;
  const batchSlots = Math.max(1, Math.floor(deps.config.ai.concurrency / 2));
  const gate = createBackgroundGate(deps);
  let schedule: ((delayMs: number) => void) | null = null;
  let pausedFor = '';
  const nudge = () => schedule?.(NUDGE_MS);

  const sql = {
    making: "SELECT id, user_id, task_id, retries, charge_user_id FROM resume_copy_backlog WHERE state = 'making'",
    // The line's copies queued or running, from their tasks: one whose upload (and so its row) was deleted meanwhile
    // still runs, and still holds its slot. The mark is JSON true: 1 on SQLite, 'true' on PostgreSQL, as text.
    inFlight:
      "SELECT count(*) AS n FROM ai_tasks WHERE status IN ('queued', 'running') AND kind = 'resume_import' " +
      `AND CAST(${d.jsonText(taskInputSql(d), '$.copyLine')} AS TEXT) IN ('1', 'true')`,
    // Each account's oldest copy due; the account served least recently first (its last editable copy, from ai_tasks,
    // which the account cannot remove; never served: first), then the oldest copy. The insert order (`seq`, v3.0 PG-E:
    // SQLite's rowid) breaks a tie of created_at.
    // v33 SHARE-3: per payer (coalesce(charge_user_id, user_id)): each payer's oldest copy due, the payer served least
    // recently first (their last editable copy on any profile); both the owner and the payer enabled.
    candidates: `SELECT d.id, d.user_id, d.source_resume_id, d.template_id, d.charge_user_id, d.grant_id,
              (SELECT max(t.created_at) FROM ai_tasks t
                 WHERE coalesce(t.charge_user_id, t.user_id) = d.payer AND t.kind = 'resume_import') AS served
       FROM (
         SELECT b.id, b.user_id, b.source_resume_id, b.template_id, b.created_at, b.charge_user_id, b.grant_id,
                ${BACKLOG_PAYER_SQL('b')} AS payer,
                row_number() OVER (PARTITION BY ${BACKLOG_PAYER_SQL('b')} ORDER BY b.created_at, ${d.seq('b')}) AS place
         FROM resume_copy_backlog b WHERE b.state = 'waiting' AND b.next_attempt_at <= ?) d
       JOIN users u ON u.id = d.user_id
       JOIN users p ON p.id = d.payer
       WHERE d.place = 1 AND u.disabled_at IS NULL AND p.disabled_at IS NULL
       ORDER BY served NULLS FIRST, d.created_at, d.id
       LIMIT ${CANDIDATES}`,
    // The payer's editable copies queued or running: asked for alone, or from this line (v33 SHARE-3: by payer).
    userTasks:
      "SELECT count(*) AS n FROM ai_tasks WHERE coalesce(charge_user_id, user_id) = ? AND kind = 'resume_import' " +
      "AND status IN ('queued', 'running')",
    owned: 'SELECT 1 AS ok FROM resumes WHERE id = ? AND user_id = ?',
    // `IS NOT DISTINCT FROM`: the same task, or none on both sides (what SQLite's `IS` said; both engines read this).
    settle: `UPDATE resume_copy_backlog SET state = @state, retries = @retries, next_attempt_at = @next,
         resume_id = @resumeId, error_code = @code, error_message = @message, finished_at = @finished, updated_at = @now
       WHERE id = @id AND state = 'making' AND task_id IS NOT DISTINCT FROM @taskId`,
    started: `UPDATE resume_copy_backlog SET state = 'making', task_id = ?, started_at = ?, error_code = NULL, updated_at = ?
       WHERE id = ? AND state = 'waiting'`,
    // v2.0: the person's copies in line wait for the daily reset (their AI usage is used up); never sooner than a
    // later attempt already set. A CASE rather than SQLite's two-argument max(), which PostgreSQL spells greatest().
    // v33 SHARE-3: the copies that person pays for, on every profile (never the owner's own for someone else's budget).
    deferUsage: `UPDATE resume_copy_backlog
         SET next_attempt_at = CASE WHEN next_attempt_at > @until THEN next_attempt_at ELSE @until END,
           error_code = 'usage', updated_at = @now
       WHERE ${BACKLOG_PAYER_SQL('resume_copy_backlog')} = @userId AND state = 'waiting'`,
    usagePause: `SELECT min(next_attempt_at) AS until FROM resume_copy_backlog
       WHERE ${BACKLOG_PAYER_SQL('resume_copy_backlog')} = ? AND state = 'waiting' AND error_code = 'usage' AND next_attempt_at > ?`,
    // v33 SHARE-3: the grant the copy would be paid under ended (or lost documents:edit): the copy stops.
    accessEnded: `UPDATE resume_copy_backlog SET state = 'stopped', finished_at = ?, updated_at = ? WHERE id = ? AND state = 'waiting'`,
    noRoom: `UPDATE resume_copy_backlog SET state = 'failed', error_code = 'no_room', error_message = ?, finished_at = ?,
         updated_at = ?
       WHERE id = ? AND state = 'waiting'`,
    defer: "UPDATE resume_copy_backlog SET next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'waiting'",
  };

  /** v2.0: the person's AI usage is used up: their copies in line wait for the daily reset. Returns that reset. */
  async function deferForUsage(userId: string, nowMs: number): Promise<number> {
    const resetMs = nextDailyResetAt(deps, new Date(nowMs)).getTime();
    await db.run(sql.deferUsage, { until: iso(resetMs), now: iso(nowMs), userId });
    return resetMs;
  }

  /** What a finished task (or one that is gone) means for its copy's row. */
  async function settle(ai: AiService, row: MakingRow, task: AiTaskView | null, nowMs: number): Promise<void> {
    const update = async (state: ResumeCopyState, outcome: Outcome = {}): Promise<void> => {
      await db.run(sql.settle, {
        id: row.id,
        taskId: row.task_id,
        state,
        retries: outcome.retries ?? row.retries,
        next: iso(outcome.next ?? nowMs),
        resumeId: outcome.resumeId ?? null,
        code: outcome.code ?? null,
        message: outcome.message ?? null,
        finished: state === 'waiting' ? null : iso(nowMs),
        now: iso(nowMs),
      });
    };
    if (!task) {
      await update('waiting');
      return;
    }
    if (task.status === 'succeeded') {
      const result = ResumeImportTaskResultSchema.safeParse(task.result);
      // Linked while it is still the account's resume (it may have been deleted already).
      const resumeId =
        result.success && (await db.one(sql.owned, [result.data.resumeId, row.user_id])) ? result.data.resumeId : null;
      await update('ready', { resumeId });
      return;
    }
    if (task.status === 'cancelled') {
      await update('stopped');
      return;
    }
    const code = task.error?.code;
    const message = task.error?.message || AI_ERROR_MESSAGES.failed;
    // v33 SHARE-3: the grant the copy was paid under ended before it ran: stopped (its owner may Try again).
    if (code === 'profile_ended' || code === 'profile_not_shared') {
      await update('stopped');
      return;
    }
    // AI was turned off since the copy started (the restart cut off or turned away its task): it is not made while AI
    // is off, and Try again makes it once AI is on.
    if (offMessage && (code === 'interrupted' || code === 'ai_unavailable')) {
      await update('failed', { code: 'ai_off', message: offMessage });
      return;
    }
    const retries = row.retries + 1;
    switch (code) {
      case 'interrupted':
        if (retries >= COPY_TRIES) await update('failed', { retries, code: 'ai', message: COPY_INTERRUPTED });
        else await update('waiting', { retries, message });
        return;
      case 'ai_unavailable': {
        // An AI pause holds the copy until it ends, uncounted; an outage with no pause counts.
        const hold = ai.provider.holdFor('resume_import');
        if (hold) await update('waiting', { next: hold.until, message });
        else if (retries >= COPY_TRIES) await update('failed', { retries, code: 'ai', message });
        else await update('waiting', { retries, next: nowMs + OUTAGE_WAIT_MS, message });
        return;
      }
      case 'conflict':
      case 'resume_limit_reached':
        await update('failed', { code: 'no_room', message });
        return;
      case 'ai_usage_exhausted': {
        // v2.0: turned away as it was about to run (the person's usage ran out meanwhile): it waits for the daily
        // reset, uncounted, with the person's other copies. v33 SHARE-3: the payer's (B's full words stay B's).
        const resetMs = await deferForUsage(payerIdOf(row), nowMs);
        const words = payerIdOf(row) === row.user_id ? message : constantsOf(deps).message('MSG_RESUME_COPY_PAYER_LIMIT');
        await update('waiting', { next: resetMs, code: 'usage', message: words });
        return;
      }
      case 'validation_failed':
        await update('failed', { code: 'unreadable', message });
        return;
      case 'not_found':
        await update('failed', { code: 'gone', message });
        return;
      default:
        await update('failed', { code: 'ai', message });
    }
  }

  /** Settles every copy whose task finished (or is gone); one that cannot be settled is logged and left for later. */
  async function reconcile(ai: AiService, nowMs: number): Promise<void> {
    for (const row of await db.all<MakingRow>(sql.making)) {
      try {
        const task = row.task_id ? await ai.getTask(row.task_id, null) : null;
        if (task && (task.status === 'queued' || task.status === 'running')) continue;
        await settle(ai, row, task, nowMs);
      } catch (error) {
        log.warn(`[resume-copies] could not settle the copy ${row.id}`, error);
      }
    }
  }

  /**
   * Starts one copy: its task id, null to try the next account's, 'stop' when no copy can start now. v3.0 D2: the AI
   * queue answers in a transaction of its own (never inside another), so the task is queued first and the row moves to
   * 'making' right after. Should that move fail, the row still waits, and the next step joins the same task (its dedupe
   * key, resume_import:<uploadId>) instead of starting a second copy.
   */
  async function begin(ai: AiService, row: CandidateRow, nowMs: number): Promise<string | null | 'stop'> {
    const now = iso(nowMs);
    try {
      // v33 SHARE-3: who pays (B under the grant: the queue checks it is still live, at enqueue and at run).
      const payer = backlogPayerOf(row);
      // No AI call for a copy the account has no room to keep (v33 SHARE-3: nor one of A's last places for B's copy).
      await assertRoomForResumes(deps, row.user_id, 1, payer);
      const accepted = await ai.enqueue({
        kind: 'resume_import',
        userId: row.user_id,
        // copyLine: the mark the line counts its copies in flight by (the handler ignores it). Every copy is an
        // on-page editor resume: a batch's retired template id maps to its successor, none to the default.
        input: {
          sourceResumeId: row.source_resume_id,
          templateId: resolveTemplateId(row.template_id),
          copyLine: true,
        },
        dedupeKey: `resume_import:${row.source_resume_id}`,
        chargeTo: payer, // v33 SHARE-3
      });
      await db.run(sql.started, [accepted.taskId, now, now, row.id]);
      // Its end starts the account's next copy at once.
      if (schedule) void ai.waitFor(accepted.taskId).then(nudge, nudge);
      return accepted.taskId;
    } catch (error) {
      const app = error instanceof AppError ? error : null;
      if (app && isNoRoom(app)) {
        await db.run(sql.noRoom, [app.message, now, now, row.id]);
        return null;
      }
      if (app?.code === 'ai_usage_exhausted') {
        // v2.0: this person's copies wait for the daily reset; the next account's copy may start. v33 SHARE-3: the
        // payer's copies (on every profile).
        await deferForUsage(payerIdOf(row), nowMs);
        return null;
      }
      if (isAccessEnded(error)) {
        // v33 SHARE-3: the grant the copy would be paid under ended: it stops (its owner may Try again).
        await db.run(sql.accessEnded, [now, now, row.id]);
        return null;
      }
      if (app?.code === 'ai_busy') return null;
      if (app?.code === 'ai_unavailable') {
        await db.run(sql.defer, [iso(nowMs + Math.max(REFUSED_WAIT_MS, (app.retryAfterSeconds ?? 0) * 1000)), now, row.id]);
        return 'stop';
      }
      log.warn(`[resume-copies] could not start the copy ${row.id}`, error);
      await db.run(sql.defer, [iso(nowMs + OTHER_WAIT_MS), now, row.id]);
      return null;
    }
  }

  const count = async (query: string, params: string[] = []): Promise<number> =>
    (await db.one<{ n: number }>(query, params))?.n ?? 0;

  const tick = async (): Promise<string[]> => {
    const ai = deps.services.ai;
    if (!ai) return [];
    const nowMs = deps.now().getTime();
    // Settled even while the line is off, so a copy a previous run left being made never looks made forever.
    await reconcile(ai, nowMs);
    if (!enabled) return [];
    const gateAnswer = gate.allowed();
    if (!gateAnswer.ok) {
      if (gateAnswer.reason !== pausedFor) log.info(`[resume-copies] editable copies wait: ${gateAnswer.reason}`);
      pausedFor = gateAnswer.reason;
      return [];
    }
    pausedFor = '';
    const started: string[] = [];
    let free = batchSlots - (await count(sql.inFlight));
    if (free <= 0) return started;
    for (const row of await db.all<CandidateRow>(sql.candidates, [iso(nowMs)])) {
      // One at a time per account: its other place is left to a copy asked for alone. v33 SHARE-3: per payer.
      if ((await count(sql.userTasks, [payerIdOf(row)])) >= MAX_ACTIVE_PER_USER_KIND - 1) continue;
      const taskId = await begin(ai, row, nowMs);
      if (taskId === 'stop') break;
      if (!taskId) continue;
      started.push(taskId);
      free -= 1;
      if (free <= 0) break;
    }
    return started;
  };

  return {
    enabled,
    tick,
    async waitReason(userId) {
      if (!enabled) return { reason: 'off', until: null };
      // v2.0: the person's own pause first: it lasts until the daily reset, whatever the gate says.
      const usage = userId
        ? await db.one<{ until: string | null }>(sql.usagePause, [userId, iso(deps.now().getTime())])
        : undefined;
      if (usage?.until) return { reason: 'usage', until: usage.until };
      const answer = gate.allowed();
      if (answer.ok) return null;
      // The gate shuts on any hold, and on a usage reading that is not plain "allowed" until its window resets. A
      // spent window (or paid overage) is the limit after the provider's own hold on it has ended too; only a reading
      // of a window nearly used up, with no hold, is a warning.
      const provider = deps.services.ai?.provider;
      const holds = provider?.activeHolds() ?? [];
      const reading = readingNow(provider?.lastRateLimit?.() ?? null, deps.now().getTime());
      let reason: CopyLineWait['reason'] = 'hold';
      if (reading === 'reached' || holds.some((hold) => hold.kind === 'rateLimited')) reason = 'limit';
      else if (holds.length === 0 && reading === 'warning') reason = 'warning';
      return { reason, until: iso(answer.retryAtMs) };
    },
    nudge,
    start() {
      // While AI is off, the timer only settles; with no AI service, there are no tasks to read.
      if (!deps.services.ai) return async () => {};
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
            log.warn('[resume-copies] a step of the copy line failed', error);
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
      if (enabled) {
        log.info(
          '[resume-copies] editable copies of several uploads are made one at a time per account, ' +
            `at most ${batchSlots} at once`,
        );
      }
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
