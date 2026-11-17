import { randomUUID } from 'node:crypto';
import { AI_TASK_KINDS, DAY_MS, type AiHealth, type AiTaskKind, type AiTaskStatus, type AiTaskView } from '@tailorit/shared';
import type { AppConfig } from '../config/env';
import { AI_KIND_MODEL_CONSTANTS } from '../config/models';
import { chargeAi } from '../core/accounts/money';
import { dayKeyAt } from '../core/constants/day';
import { constantsOf } from '../core/constants/service';
import type { AppDeps } from '../core/context';
import type { Dialect } from '../core/db/dialect';
import type { DbQueries } from '../core/db/types';
import { AppError } from '../core/http/errors';
import { capacityOf } from './capacity';
import { AI_DETAILS, AI_ERROR_MESSAGES, AiError, aboutMinutes, holdError } from './errors';
import { capacityOrBudgetRefusal, refusalError } from './gate';
import { createClaudeCliProvider } from './provider/claudeCli';
import { isSubscriptionSignIn, type CliStatus } from './provider/health';
import type { AiProvider, ProviderHold } from './provider/types';
import { ECHO_USER, EchoOutput, echoPrompt } from './prompts/system/echo';
// v30 D5L: the inputs and results in ai_task_payloads (ai/payloads.ts).
import { ensureTaskPartition, insertTask, succeedTask, taskInputSql, taskRowSql } from './payloads';
import { pruneResultCache } from './resultCache';
import { buildSystemText, completeJson, createRunPrompt, type PromptCallInfo, type RunPrompt } from './runPrompt';
import { PrioritySemaphore, type AiPriority } from './semaphore';
import { microsOf, pruneUsage, recordUsage } from './usage';

// The AI task queue. Every AI endpoint answers 202 {taskId} and the page polls GET /api/ai/tasks/:id, because a CLI
// call can take minutes. Tasks live in `ai_tasks`, their input and result (JSON) in `ai_task_payloads` (v30 D5L:
// ai/payloads.ts); the worker runs in this process.

export interface AiTaskContext {
  /** Aborted when the owner cancels the task or the server stops. ctx.runPrompt already listens to it. */
  signal: AbortSignal;
  /** runPrompt bound to this task: its CLI calls are recorded on the task and stop when the task is cancelled. */
  runPrompt: RunPrompt;
  userId: string | null;
  taskId: string;
  /**
   * v5 (the autofill stream): publishes one item of the result before the task finishes, for its stream's watchers
   * (watch). Only an item the finished result will hold unchanged may be published. Kept in memory while the task runs.
   * The queue always gives it; a handler run outside the queue (a test) may have none, and then streams nothing.
   */
  publish?(item: unknown): void;
}

/** What a task's watcher hears (v5, the streamed view): each item published, then the finished task. */
export type AiTaskEvent = { type: 'item'; item: unknown } | { type: 'task'; view: AiTaskView };

/** Turns a task's input into its result (any JSON value). Throw AppError for failures a person can act on. */
export type AiTaskHandler = (input: unknown, ctx: AiTaskContext) => Promise<unknown>;

export interface EnqueueOptions {
  kind: AiTaskKind;
  /** The owner. Null = system work (e.g. lazy job analysis): only internal callers (getTask(id, null)) can read it. */
  userId: string | null;
  /** Stored as JSON; the handler receives it parsed back from JSON (the same after a restart). */
  input: unknown;
  priority?: AiPriority;
  /** While a task with this key and the same owner is queued or running, enqueue returns it instead. */
  dedupeKey?: string;
  /**
   * v2.0 (03-ai-usage.md, "Attribution"): whose daily budget and extra credit this task's prompt runs are charged to.
   * Absent: `userId` (null for system work, a server cost never charged). A job analysis that Prepare forces names the
   * person. A task joined through its dedupe key charges whoever the existing task names.
   */
  chargeTo?: string | null;
}

export interface AiTestResult {
  ok: boolean;
  model: string;
  ms: number;
  answer: string | null;
  error?: { code: string; message: string; detail: string };
}

/** The accepted answer of enqueue. */
export interface AiTaskAcceptedIds {
  taskId: string;
  deduped: boolean;
}

export interface AiService {
  /** One handler per kind, registered by the owning feature in its `services` hook. */
  registerHandler(kind: AiTaskKind, handler: AiTaskHandler): void;
  /**
   * Throws AppError: `ai_unavailable` (off, paused, no handler, the capacity block; always MSG_AI_UNAVAILABLE),
   * v2.0 `ai_usage_exhausted` (the charged person's budget and credit are used up), `ai_busy` (2 of this kind already
   * queued/running). v3.0 D2: async, in one transaction of its own (refused inside another: queue after the tx).
   */
  enqueue(options: EnqueueOptions): Promise<AiTaskAcceptedIds>;
  /** Owner-only: null when the task does not exist or belongs to someone else. `userId` null reads any task. */
  getTask(taskId: string, userId: string | null): Promise<AiTaskView | null>;
  /** Resolves when the task has finished (tests and internal callers). Rejects after `timeoutMs`. */
  waitFor(taskId: string, timeoutMs?: number): Promise<AiTaskView>;
  /** True when a queued/running task of this owner (`null`: anyone's) was cancelled; its CLI child is stopped. */
  cancel(taskId: string, userId: string | null): Promise<boolean>;
  /**
   * v5 (the streamed view): `listener` hears the items the task published so far, then each one as it is published,
   * then the finished task (at once for a finished task), after which it is dropped. Null when the task does not exist
   * or belongs to someone else (`userId` null: anyone's). Answers the function that stops listening.
   */
  watch(taskId: string, userId: string | null, listener: (event: AiTaskEvent) => void): Promise<(() => void) | null>;
  /** CLI version and sign-in, cached for 60 s unless `force`. */
  health(force?: boolean): Promise<AiHealth>;
  /** The admin connectivity test: one tiny JSON echo, outside the queue but inside the concurrency limit. */
  test(options?: { model?: string }): Promise<AiTestResult>;
  /** Marks tasks a previous run left running as interrupted and resumes queued ones. Returns the stop function. */
  start(): Promise<() => Promise<void>>;
  readonly provider: AiProvider;
}

declare module '../core/context' {
  interface AppServices {
    /** The AI task queue (work package F4), created by the ai-tasks feature before any feature that uses it. */
    ai?: AiService;
  }
}

const PRIORITY: Record<AiPriority, number> = { interactive: 1, background: 0 };
/** Exported: the copy line leaves an account's second place to copies asked for alone. */
export const MAX_ACTIVE_PER_USER_KIND = 2;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
const TEST_TIMEOUT_MS = 90_000;
const TEST_SLOT_WAIT_MS = 30_000;
const TERMINAL: ReadonlySet<AiTaskStatus> = new Set(['succeeded', 'failed', 'cancelled']);

// v2.0: noHandler, noBackground and stopping are ai_unavailable, so a person reads MSG_AI_UNAVAILABLE instead
// (03-ai-usage.md); their sentences are in AI_DETAILS, for the log.
// v30 ST0: the busy, interrupted and cancelled words are the constants MSG_AI_BUSY, MSG_AI_INTERRUPTED and
// MSG_AI_CANCELLED, read when they are written (an admin's change reaches the next task).
const MESSAGES = {
  slotsBusy: 'Every AI slot is busy right now. Try the test again in a minute.',
};

// v30 ST0: the connectivity test's words live in the prompt catalogue (ai/prompts/system/echo.ts).

interface TaskRow {
  id: string;
  user_id: string | null;
  kind: AiTaskKind;
  status: AiTaskStatus;
  priority: number;
  /** v30 D5L: from ai_task_payloads (null once its day's partition is dropped). */
  input: string | null;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  model: string | null;
  attempts: number;
  /** v2.0: whose budget the task's runs are charged to; null: a server cost. */
  charge_user_id: string | null;
  dedupe_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toView(row: TaskRow): AiTaskView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    result: row.status === 'succeeded' && row.result !== null ? JSON.parse(row.result) : null,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const plan = (type: string | null) =>
  type ? `a Claude ${type[0]!.toUpperCase()}${type.slice(1)} subscription` : 'a Claude subscription';

/**
 * v30 INT-4: each kind's model as Admin › AI shows it: the configured one, or for a kind whose model is an admin constant
 * (config/models.ts AI_KIND_MODEL_CONSTANTS: company summaries' COMPANY_AI_MODEL) that constant when set.
 */
function modelsByKind(deps: AppDeps, ai: AppConfig['ai']): AiHealth['models'] {
  const constants = constantsOf(deps);
  return Object.fromEntries(
    AI_TASK_KINDS.map((kind) => {
      const key = AI_KIND_MODEL_CONSTANTS[kind];
      const set = key ? String(constants.get(key) ?? '').trim() : '';
      return [kind, set || ai.features[kind].model];
    }),
  ) as AiHealth['models'];
}

/** AiHealth from the CLI status and the active holds. Pure. */
export function describeHealth(status: CliStatus, holds: ProviderHold[], ai: AppConfig['ai'], nowMs: number): AiHealth {
  let available = false;
  let message: string;
  if (status.problem || !status.found) {
    message = status.problem ?? 'The Claude CLI could not be found.';
  } else if (!status.loggedIn) {
    message = 'The Claude CLI is installed but not signed in. Run "claude auth login" as the user this server runs as.';
  } else if (!isSubscriptionSignIn(status)) {
    const keyed = status.apiKeySource && status.apiKeySource !== 'none';
    const key = keyed ? ` and apiKeySource "${status.apiKeySource}"` : '';
    message =
      `The Claude CLI is signed in with authMethod "${status.authMethod ?? 'unknown'}"${key}, which is billed per ` +
      'request. TailorIT only runs on a Claude subscription: run "claude auth login" and sign in with your Claude ' +
      'account.';
  } else {
    available = true;
    message = `Claude CLI ${status.version ?? '(unknown version)'} is signed in on ${plan(status.subscriptionType)}.`;
  }
  for (const hold of holds) {
    const what = hold.scope === '*' ? 'All AI requests are' : `AI requests for "${hold.scope}" are`;
    message += ` ${what} paused for ${aboutMinutes(hold.until - nowMs)}: ${hold.reason}.`;
    if (hold.scope === '*') available = false;
  }
  return {
    enabled: true,
    available,
    cliVersion: status.version,
    loggedIn: status.loggedIn,
    authMethod: status.authMethod,
    subscriptionType: status.subscriptionType,
    defaultModel: ai.model,
    models: Object.fromEntries(AI_TASK_KINDS.map((kind) => [kind, ai.features[kind].model])),
    message,
    checkedAt: status.checkedAt,
  };
}

/** v2.0: whom a task's prompt runs are charged to, read once when it starts (03-ai-usage.md, "Charging"). */
interface ChargeTarget {
  /** ai_tasks.charge_user_id: null for a server cost. */
  userId: string | null;
  /** The Prepare it works for (its input's `prepare.id`), whose cost_micros adds up its runs. */
  prepareId: string | null;
}

/** The Prepare a task works for: its input's `prepare.id` (05-prepare-flow.md; the tailor service marks it so). */
function prepareIdOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const prepare = (input as { prepare?: unknown }).prepare;
  if (typeof prepare !== 'object' || prepare === null) return null;
  const id = (prepare as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : null;
}

/** The queue's SQL (v3.0 D2: one text per statement). */
const SQL = {
  // v30 D5L: the row with its payload (ai/payloads.ts).
  get: (d: Dialect) => `${taskRowSql(d)} WHERE t.id = ?`,
  findDedupe: "SELECT id FROM ai_tasks WHERE dedupe_key = ? AND status IN ('queued', 'running')",
  countActive: "SELECT count(*) AS n FROM ai_tasks WHERE user_id = ? AND kind = ? AND status IN ('queued', 'running')",
  // v30 D5L: the insert (ON CONFLICT DO NOTHING on idx_ai_dedupe) and the success are ai/payloads.ts's.
  // v2.0: what a task's runs were charged, and its Prepare's sum of them.
  charged: 'UPDATE ai_tasks SET charged_micros = charged_micros + ? WHERE id = ?',
  prepareCost: 'UPDATE prepare_jobs SET cost_micros = cost_micros + ? WHERE id = ?',
  markRunning: "UPDATE ai_tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
  fail:
    "UPDATE ai_tasks SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? " +
    "WHERE id = ? AND status IN ('queued', 'running')",
  cancel:
    "UPDATE ai_tasks SET status = 'cancelled', error_code = 'cancelled', error_message = ?, finished_at = ? " +
    "WHERE id = ? AND status IN ('queued', 'running')",
  record: 'UPDATE ai_tasks SET model = ?, attempts = attempts + ? WHERE id = ?',
  // v1.3 C (decision 8): what a task's prompt runs used, added up (a task may run more than one prompt).
  recordUsage:
    'UPDATE ai_tasks SET input_tokens = coalesce(input_tokens, 0) + @input, ' +
    'output_tokens = coalesce(output_tokens, 0) + @output, ' +
    'cache_read_tokens = coalesce(cache_read_tokens, 0) + @cacheRead, ' +
    'cache_write_tokens = coalesce(cache_write_tokens, 0) + @cacheWrite, cost_usd = coalesce(cost_usd, 0) + @cost ' +
    'WHERE id = @id',
  running: "SELECT id FROM ai_tasks WHERE status = 'running'",
  // v3.0 PG-0: the insert order breaks ties (SQLite's rowid, the baseline's ai_tasks.seq).
  queued: (d: Dialect) =>
    `SELECT id, kind, priority, user_id FROM ai_tasks WHERE status = 'queued' ORDER BY priority DESC, created_at, ${d.seq()}`,
  prune: "DELETE FROM ai_tasks WHERE status IN ('succeeded', 'failed', 'cancelled') AND finished_at < ?",
} as const;

export function createAiService(deps: AppDeps, options: { provider?: AiProvider } = {}): AiService {
  const { db, log } = deps;
  const ai = deps.config.ai;
  // v2.0: the seat's usage readings (the capacity block), which every CLI call reports to.
  const capacity = capacityOf(deps);
  const provider =
    options.provider ??
    createClaudeCliProvider({
      ai,
      dataDir: deps.config.dataDir,
      log,
      now: deps.now,
      capacity,
      prices: () => constantsOf(deps).get('AI_PRICES'),
    });
  /**
   * v2.0: an ai_unavailable for a person: the resolved MSG_AI_UNAVAILABLE and nothing about the server (no reason, no
   * retry time); the reason is kept in `detail` for the log.
   */
  const unavailable = (detail: string, cause?: unknown) =>
    new AiError('unavailable', { text: constantsOf(deps).message('MSG_AI_UNAVAILABLE'), message: detail, cause });
  /** A hold's fail-fast error, in the resolved MSG_AI_UNAVAILABLE. */
  const held = (hold: ProviderHold) => holdError(hold, deps.now().getTime(), constantsOf(deps).message('MSG_AI_UNAVAILABLE'));
  const backgroundSlots = Math.min(ai.backgroundSlots, ai.concurrency);
  const semaphore = new PrioritySemaphore(ai.concurrency, backgroundSlots);
  /** v5: each account's own line (AI_CLI_PER_ACCOUNT interactive processes at once, by default the whole seat), taken
   *  before a slot of the seat's, so one account's tasks never hold every slot; dropped once nobody holds or waits for
   *  it. The review's M2 and security 6b: background work never takes an account place (it is held to the seat's
   *  AI_CLI_BACKGROUND_SLOTS alone), so a background task waiting for that slot never keeps the account's interactive
   *  work (the autofill's answers) from running. */
  const accounts = new Map<string, { semaphore: PrioritySemaphore; users: number }>();
  const perAccount = Math.max(1, Math.min(ai.perAccount ?? ai.concurrency, ai.concurrency));
  /** Takes the account's place (none for system work), then the seat's slot; answers the one release of both. */
  async function acquireFor(userId: string | null, priority: AiPriority, signal: AbortSignal): Promise<() => void> {
    if (userId === null || priority === 'background') return semaphore.acquire(priority, signal);
    let line = accounts.get(userId);
    if (!line) {
      line = { semaphore: new PrioritySemaphore(perAccount, perAccount), users: 0 };
      accounts.set(userId, line);
    }
    line.users += 1;
    const own = line;
    const leave = () => {
      own.users -= 1;
      if (own.users === 0 && accounts.get(userId) === own) accounts.delete(userId);
    };
    // A free place is taken in this same tick, so the seat's line keeps the order tasks were enqueued in.
    let releaseOwn = own.semaphore.tryAcquire(priority);
    if (releaseOwn === null) {
      try {
        releaseOwn = await own.semaphore.acquire(priority, signal);
      } catch (error) {
        leave();
        throw error;
      }
    }
    const ownRelease = releaseOwn;
    try {
      const releaseSeat = await semaphore.acquire(priority, signal);
      return () => {
        releaseSeat();
        ownRelease();
        leave();
      };
    } catch (error) {
      ownRelease();
      leave();
      throw error;
    }
  }
  const handlers = new Map<AiTaskKind, AiTaskHandler>();
  /** Tasks this process has dispatched: waiting for a slot or running. */
  const live = new Map<string, AbortController>();
  const waiters = new Map<string, Set<(view: AiTaskView) => void>>();
  /** v5: the items each running task published (memory only, dropped when it finishes), and its stream's watchers. */
  const partials = new Map<string, unknown[]>();
  const watchers = new Map<string, Set<(event: AiTaskEvent) => void>>();
  /** v3.0 D2: each task's run notes still being written (noteRun is told synchronously, writes asynchronously). */
  const notes = new Map<string, Set<Promise<void>>>();
  let stopping = false;
  const nowIso = () => deps.now().toISOString();
  const rowOf = (taskId: string, q: DbQueries = db) => q.one<TaskRow>(SQL.get(q.dialect), [taskId]); // v30 D5L

  /**
   * v1.3 C (decision 8): one prompt run's cost, on its task's row (when it has one) and in the hourly ledger
   * (ai/usage.ts), which outlives the rows (autofill tasks go an hour after they finish). Never fails the task.
   * v2.0: then charges the run to the task's `charge` target (03-ai-usage.md, "Charging, at noteRun").
   * v3.0 D2: runPrompt tells it synchronously; the writes are kept with the task, and the task's end waits for them.
   */
  function noteRun(kind: string, info: PromptCallInfo, taskId: string | null, target?: ChargeTarget): Promise<void> {
    const writing = (async () => {
      try {
        if (taskId !== null) {
          await db.run(SQL.record, [info.model, info.calls, taskId]);
          const used = info.usage;
          if (used) {
            await db.run(SQL.recordUsage, {
              id: taskId,
              input: used.inputTokens,
              output: used.outputTokens,
              cacheRead: used.cacheReadTokens,
              cacheWrite: used.cacheWriteTokens,
              cost: used.costUsd,
            });
          }
        }
        const atMs = deps.now().getTime();
        await recordUsage(db, { atMs, kind, model: info.model, calls: info.calls, reportedCalls: info.reportedCalls, usage: info.usage });
      } catch (error) {
        log.warn(`[ai] could not record what a ${kind} call used`, error);
      }
      if (taskId !== null && target) await charge(kind, info, taskId, target);
    })();
    const key = taskId ?? '';
    const kept = notes.get(key) ?? new Set();
    notes.set(key, kept);
    kept.add(writing);
    void writing.finally(() => {
      kept.delete(writing);
      if (kept.size === 0 && notes.get(key) === kept) notes.delete(key);
    });
    return writing;
  }

  /** Waits for every run note of a task (or of the admin's test: null) still being written. */
  async function notesWritten(taskId: string | null): Promise<void> {
    const kept = notes.get(taskId ?? '');
    if (kept) await Promise.all([...kept]);
  }

  /**
   * v2.0 (A7, A8): one prompt run's actual cost, in whole micro-dollars rounded up once per run, charged to the person
   * the task names: the day's budget first, then extra credit down to 0, the rest written off (core/accounts/money.ts),
   * in one transaction with the task's charged_micros and its Prepare's cost_micros. A server task (no target person)
   * is never charged. A run that reported no usage charges 0 and is still counted. Never fails the task: a charge that
   * cannot land is logged, and the run's cost stays on the task row for the admin.
   */
  async function charge(kind: string, info: PromptCallInfo, taskId: string, target: ChargeTarget): Promise<void> {
    if (target.userId === null) return;
    const userId = target.userId;
    try {
      const micros = microsOf(info.usage?.costUsd ?? 0);
      if (!info.usage) log.info(`[ai] task ${taskId} (${kind}): the CLI reported no usage for a run; it is counted, charged 0`);
      await db.tx(
        async (t) => {
          // chargeAi takes the person's lock first and joins this transaction.
          await chargeAi(deps, { userId, micros, dayKey: dayKeyAt(deps), taskId });
          if (micros > 0) {
            await t.run(SQL.charged, [micros, taskId]);
            if (target.prepareId) await t.run(SQL.prepareCost, [micros, target.prepareId]);
          }
        },
        { label: 'ai charge' },
      );
    } catch (error) {
      log.error(`[ai] could not charge a run of task ${taskId} (${kind})`, error);
    }
  }

  async function notify(taskId: string): Promise<void> {
    const listeners = waiters.get(taskId);
    const watching = watchers.get(taskId);
    if (!listeners && !watching && !partials.has(taskId)) return;
    const row = await rowOf(taskId);
    if (row && !TERMINAL.has(row.status)) return;
    // The listeners as they are now (one added while the row was read is told too).
    const told = waiters.get(taskId);
    const watched = watchers.get(taskId);
    waiters.delete(taskId);
    watchers.delete(taskId);
    partials.delete(taskId);
    if (!row) return;
    const view = toView(row);
    for (const listener of told ?? []) listener(view);
    for (const watcher of watched ?? []) tell(watcher, { type: 'task', view });
  }

  /** notify, never rejecting (the database may be closed at shutdown: nobody is left waiting). */
  const notifyQuietly = (taskId: string) => {
    notify(taskId).catch(() => undefined);
  };

  /** One watcher's event: a watcher that throws loses only its own stream. */
  function tell(watcher: (event: AiTaskEvent) => void, event: AiTaskEvent): void {
    try {
      watcher(event);
    } catch (error) {
      log.warn('[ai] a task stream could not take an event', error);
    }
  }

  /**
   * v5: an item a running task published, kept for later watchers and told to those watching now. v3.0 D2: "running"
   * is this process's own record (dispatched and not cancelled), so publishing reads nothing.
   */
  function publish(taskId: string, item: unknown): void {
    const controller = live.get(taskId);
    if (!controller || controller.signal.aborted) return;
    const kept = partials.get(taskId) ?? [];
    kept.push(item);
    partials.set(taskId, kept);
    // A watcher that joins while this one is told has had it replayed already.
    for (const watcher of [...(watchers.get(taskId) ?? [])]) tell(watcher, { type: 'item', item });
  }

  async function fail(taskId: string, error: unknown): Promise<void> {
    const row = await rowOf(taskId);
    // Cancelled by its owner, or marked interrupted by stop(): that status stands.
    if (!row || TERMINAL.has(row.status)) return;
    if (error instanceof AppError) {
      const detail = error instanceof AiError && error.detail ? ` (${error.detail})` : '';
      log.info(`[ai] task ${taskId} (${row.kind}) failed: ${error.code}: ${error.message}${detail}`);
      // v2.0: whatever a handler threw, a person polling the task reads MSG_AI_UNAVAILABLE for any ai_unavailable.
      const message = error.code === 'ai_unavailable' ? constantsOf(deps).message('MSG_AI_UNAVAILABLE') : error.message;
      await db.run(SQL.fail, [error.code, message, nowIso(), taskId]);
    } else {
      log.error(`[ai] task ${taskId} (${row.kind}) failed`, error);
      await db.run(SQL.fail, ['ai_failed', AI_ERROR_MESSAGES.failed, nowIso(), taskId]);
    }
  }

  async function runTask(taskId: string, controller: AbortController): Promise<void> {
    if (controller.signal.aborted || (await db.run(SQL.markRunning, [nowIso(), taskId])).changes === 0) return;
    const row = (await rowOf(taskId))!;
    const handler = handlers.get(row.kind);
    if (!handler) throw unavailable(AI_DETAILS.noHandler);
    const hold = provider.holdFor(row.kind);
    if (hold) throw held(hold);
    // v2.0 (A8): the gate again, for a task that waited in line: the capacity block may have come, or the person's
    // budget and credit run out, since it was queued. From here on the task runs to its end.
    const refusal = await capacityOrBudgetRefusal(deps, row.charge_user_id);
    if (refusal) throw refusalError(deps, refusal);
    // v30 D5L: a queued task's payload day is kept (11 §8.2); none means it was lost.
    if (row.input === null) throw new Error(`AI task ${taskId} has no stored input.`);
    const input: unknown = JSON.parse(row.input);
    const target: ChargeTarget = { userId: row.charge_user_id, prepareId: prepareIdOf(input) };
    // v3.0 D2: runPrompt waits for the run's notes (usage, charge) before the handler goes on.
    const bound = createRunPrompt(provider, ai, (info) => noteRun(info.tag, info, taskId, target));
    const ctx: AiTaskContext = {
      signal: controller.signal,
      userId: row.user_id,
      taskId,
      publish: (item) => publish(taskId, item),
      runPrompt: (module, input, opts = {}) =>
        bound(module, input, {
          ...opts,
          signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
        }),
    };
    const result = await handler(input, ctx);
    await notesWritten(taskId);
    await succeedTask(db, { id: taskId, createdAt: row.created_at }, JSON.stringify(result ?? null), nowIso()); // v30 D5L
  }

  /** Never rejects: a failure is recorded on the task (or logged, when even that fails, e.g. at shutdown). */
  async function execute(taskId: string, controller: AbortController, release: () => void): Promise<void> {
    try {
      await runTask(taskId, controller);
    } catch (error) {
      try {
        await notesWritten(taskId);
        await fail(taskId, error);
      } catch (recordError) {
        log.error(`[ai] could not record the failure of AI task ${taskId}`, recordError);
      }
    } finally {
      release();
      settle(taskId);
    }
  }

  /** The task left this process's hands: wake waitFor() callers. */
  function settle(taskId: string): void {
    live.delete(taskId);
    notifyQuietly(taskId);
  }

  /** Takes a slot in priority/FIFO order (dispatch order is enqueue order), then runs the task. v5: its account's
   *  place first (AI_CLI_PER_ACCOUNT). */
  function dispatch(taskId: string, priority: AiPriority, userId: string | null): void {
    if (live.has(taskId)) return;
    const controller = new AbortController();
    live.set(taskId, controller);
    acquireFor(userId, priority, controller.signal).then(
      (release) => void execute(taskId, controller, release),
      // Cancelled or stopped while waiting: the row says which (a stop leaves it queued for the next start).
      () => settle(taskId),
    );
  }

  /** enqueue's refusals before the database is read (both versions). */
  function assertCanQueue(kind: AiTaskKind, priority: AiPriority): void {
    if (!ai.enabled) throw unavailable(AI_DETAILS.disabled);
    if (stopping) throw unavailable(AI_DETAILS.stopping);
    if (!handlers.has(kind)) throw unavailable(AI_DETAILS.noHandler);
    if (priority === 'background' && backgroundSlots === 0) throw unavailable(AI_DETAILS.noBackground);
  }

  const busy = () => new AppError('ai_busy', constantsOf(deps).message('MSG_AI_BUSY'));

  const service: AiService = {
    provider,

    registerHandler(kind, handler) {
      if (!AI_TASK_KINDS.includes(kind)) throw new Error(`Unknown AI task kind "${kind}".`);
      if (handlers.has(kind)) throw new Error(`An AI handler for "${kind}" is already registered.`);
      handlers.set(kind, handler);
    },

    async enqueue({ kind, userId, input, priority = 'interactive', dedupeKey, chargeTo }) {
      assertCanQueue(kind, priority);
      // Its own transaction: never inside a caller's (that would hold every request while the queue is asked).
      db.assertNoTx('the AI queue');
      const chargeUserId = chargeTo === undefined ? userId : chargeTo;
      // Scoped by owner, so one account's key never hands it another account's task.
      const key = dedupeKey ? `${userId ?? '-'}:${dedupeKey}` : null;
      const json = JSON.stringify(input ?? null);
      // v30 D5L: the input goes to its day's payload partition (made now when the clock is past the ones made ahead).
      const createdAt = nowIso();
      await ensureTaskPartition(db, createdAt);
      const accepted = await db.tx(
        async (t): Promise<AiTaskAcceptedIds> => {
          const existing = key ? await t.one<{ id: string }>(SQL.findDedupe, [key]) : undefined;
          if (existing) return { taskId: existing.id, deduped: true };
          const hold = provider.holdFor(kind);
          if (hold) throw held(hold);
          // v2.0 (03, "Check points"): the capacity block, then the charged person's budget and credit.
          const refusal = await capacityOrBudgetRefusal(deps, chargeUserId);
          if (refusal) throw refusalError(deps, refusal);
          // v3.0 D2 (the concurrency audit): "at most MAX_ACTIVE_PER_USER_KIND of a kind per person" counts, then
          // inserts, behind the person's lock (a no-op on SQLite, whose writer is one; FOR UPDATE on PostgreSQL).
          if (userId !== null) {
            await t.lockPerson(userId);
            if (((await t.one<{ n: number }>(SQL.countActive, [userId, kind]))?.n ?? 0) >= MAX_ACTIVE_PER_USER_KIND) throw busy();
          }
          const taskId = randomUUID();
          const task = { id: taskId, userId, kind, priority: PRIORITY[priority], input: json, chargeUserId, dedupeKey: key, createdAt };
          if (await insertTask(t, task)) return { taskId, deduped: false }; // v30 D5L
          // The dedupe key's unique index (idx_ai_dedupe) refused it: a twin went live meanwhile; join it.
          const twin = key ? await t.one<{ id: string }>(SQL.findDedupe, [key]) : undefined;
          if (twin) return { taskId: twin.id, deduped: true };
          throw new Error(`AI task ${taskId} could not be queued.`);
        },
        { label: 'ai enqueue' },
      );
      if (!accepted.deduped) dispatch(accepted.taskId, priority, userId);
      return accepted;
    },

    async getTask(taskId, userId) {
      const row = await rowOf(taskId);
      if (!row || (userId !== null && row.user_id !== userId)) return null;
      return toView(row);
    },

    async waitFor(taskId, timeoutMs = 2 * ai.timeoutMs + 60_000) {
      const row = await rowOf(taskId);
      if (!row) throw new Error(`AI task ${taskId} does not exist.`);
      if (TERMINAL.has(row.status)) return toView(row);
      return new Promise((resolve, reject) => {
        const listeners = waiters.get(taskId) ?? new Set();
        waiters.set(taskId, listeners);
        const timer = setTimeout(() => {
          listeners.delete(done);
          reject(new Error(`AI task ${taskId} did not finish within ${timeoutMs} ms.`));
        }, timeoutMs);
        timer.unref?.();
        function done(view: AiTaskView) {
          clearTimeout(timer);
          resolve(view);
        }
        listeners.add(done);
        // v3.0 D2: it may have finished while its row was read; notify reads it again and tells the listeners.
        if (!live.has(taskId)) notifyQuietly(taskId);
      });
    },

    async cancel(taskId, userId) {
      const row = await rowOf(taskId);
      if (!row || (userId !== null && row.user_id !== userId)) return false;
      const { changes } = await db.run(SQL.cancel, [constantsOf(deps).message('MSG_AI_CANCELLED'), nowIso(), taskId]);
      if (changes === 0) return false;
      live.get(taskId)?.abort();
      notifyQuietly(taskId);
      return true;
    },

    async watch(taskId, userId, listener) {
      const row = await rowOf(taskId);
      if (!row || (userId !== null && row.user_id !== userId)) return null;
      if (TERMINAL.has(row.status)) {
        tell(listener, { type: 'task', view: toView(row) });
        return () => undefined;
      }
      for (const item of partials.get(taskId) ?? []) tell(listener, { type: 'item', item });
      const watching = watchers.get(taskId) ?? new Set();
      watchers.set(taskId, watching);
      watching.add(listener);
      // v3.0 D2: it may have finished while its row was read.
      if (!live.has(taskId)) notifyQuietly(taskId);
      return () => {
        watching.delete(listener);
        if (watching.size === 0 && watchers.get(taskId) === watching) watchers.delete(taskId);
      };
    },

    async health(force = false) {
      if (!ai.enabled) {
        return {
          enabled: false,
          available: false,
          cliVersion: null,
          loggedIn: false,
          authMethod: null,
          subscriptionType: null,
          defaultModel: ai.model,
          models: modelsByKind(deps, ai), // v30 INT-4
          message: 'AI features are turned off on this server (AI_ENABLED=false).',
          checkedAt: nowIso(),
        };
      }
      const status = await provider.status(force);
      const health = { ...describeHealth(status, provider.activeHolds(), ai, deps.now().getTime()), models: modelsByKind(deps, ai) }; // v30 INT-4
      // v2.0: during the capacity block no server-AI action starts (Admin › AI's Server AI status says more).
      if (!(await capacity.blocked())) return health;
      return { ...health, available: false, message: `${health.message} The server AI capacity block is on.` };
    },

    async test({ model } = {}) {
      const useModel = model?.trim() || ai.model;
      const startedAt = Date.now();
      const failure = (error: unknown): AiTestResult => {
        const app = error instanceof AppError ? error : new AiError('failed', { detail: String(error) });
        const detail = app instanceof AiError ? app.detail : '';
        const ms = Date.now() - startedAt;
        const { code, message } = app;
        return { ok: false, model: useModel, ms, answer: null, error: { code, message, detail } };
      };
      if (!ai.enabled) return failure(new AiError('unavailable', { message: AI_DETAILS.disabled }));
      let release: () => void;
      try {
        release = await semaphore.acquire('interactive', AbortSignal.timeout(TEST_SLOT_WAIT_MS));
      } catch {
        const detail = 'No free AI slot within 30 s.';
        return failure(new AiError('unavailable', { message: MESSAGES.slotsBusy, detail }));
      }
      try {
        const { value, info } = await completeJson(
          provider,
          {
            tag: 'echo',
            system: buildSystemText(echoPrompt.text(), 'echo'),
            user: ECHO_USER,
            output: EchoOutput,
            model: useModel,
            effort: ai.effort,
            timeoutMs: TEST_TIMEOUT_MS,
            ignoreHolds: true,
          },
          // v1.3 C: the admin test's calls count in Admin › AI usage too, as `echo`.
          (run) => noteRun('echo', run, null),
        );
        // A working call is the operator's proof that whatever caused a pause is fixed.
        provider.clearHolds();
        return { ok: true, model: info.model, ms: Date.now() - startedAt, answer: value.answer };
      } catch (error) {
        return failure(error);
      } finally {
        release();
        await notesWritten(null);
      }
    },

    async start() {
      // A previous process's CLI children died with it; their tasks cannot be resumed.
      let interrupted = 0;
      for (const { id } of await db.all<{ id: string }>(SQL.running)) {
        if (live.has(id)) continue;
        interrupted += (await db.run(SQL.fail, ['interrupted', constantsOf(deps).message('MSG_AI_INTERRUPTED'), nowIso(), id])).changes;
      }
      if (interrupted) log.warn(`[ai] marked ${interrupted} AI task(s) the previous run left running as interrupted`);
      // Finished tasks (inputs can be whole resumes) are kept AI_TASK_KEEP_DAYS (30 by default; v30 INT-0: the constant).
      const prune = async () => {
        try {
          await db.run(SQL.prune, [new Date(deps.now().getTime() - constantsOf(deps).get('AI_TASK_KEEP_DAYS') * DAY_MS).toISOString()]);
        } catch (error) {
          log.warn('[ai] could not delete old AI tasks', error);
        }
        // v1.3 C: the usage ledger past AI_USAGE_KEEP_DAYS (35 by default), and expired result-cache rows.
        try {
          await pruneUsage(db, deps.now().getTime(), constantsOf(deps).get('AI_USAGE_KEEP_DAYS'));
          await pruneResultCache(db, deps.now());
        } catch (error) {
          log.warn('[ai] could not prune the AI usage ledger and result cache', error);
        }
      };
      await prune();
      const pruneTimer = setInterval(() => void prune(), PRUNE_EVERY_MS);
      pruneTimer.unref?.();
      const queued = await db.all<{ id: string; kind: AiTaskKind; priority: number; user_id: string | null }>(SQL.queued(db.dialect));
      for (const row of queued) {
        if (live.has(row.id)) continue;
        const priority: AiPriority = row.priority > 0 ? 'interactive' : 'background';
        if (!ai.enabled) await fail(row.id, unavailable(AI_DETAILS.disabled));
        else if (!handlers.has(row.kind)) await fail(row.id, unavailable(AI_DETAILS.noHandler));
        else if (priority === 'background' && backgroundSlots === 0) await fail(row.id, unavailable(AI_DETAILS.noBackground));
        else dispatch(row.id, priority, row.user_id);
      }
      return async () => {
        stopping = true;
        clearInterval(pruneTimer);
        for (const [id, controller] of live) {
          try {
            if ((await rowOf(id))?.status === 'running') {
              await db.run(SQL.fail, ['interrupted', constantsOf(deps).message('MSG_AI_INTERRUPTED'), nowIso(), id]);
            }
          } catch (error) {
            log.warn(`[ai] could not mark AI task ${id} interrupted`, error);
          }
          controller.abort();
        }
      };
    },
  };
  return service;
}

/**
 * v2.0 FIX-B (BEH-5): the tasks of `kinds` still queued or running for a Prepare (their input's `prepare.id`, as
 * prepareIdOf reads it), oldest first, with their input. The Prepare runner, taking a Prepare up again after a restart,
 * waits for these (start() runs a previous process's queued tasks again) instead of starting the same work twice.
 */
export async function liveTasksOfPrepare(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  prepareId: string,
  kinds: readonly AiTaskKind[],
): Promise<Array<{ id: string; kind: AiTaskKind; input: unknown }>> {
  if (kinds.length === 0) return [];
  const d = deps.db.dialect;
  // v30 D5L: the input from ai_task_payloads (a live task's day is kept).
  const input = taskInputSql(d);
  const rows = await deps.db.all<{ id: string; kind: AiTaskKind; input: string | null }>(
    `SELECT id, kind, ${input} AS input FROM ai_tasks WHERE user_id = ? AND status IN ('queued', 'running')
       AND kind IN (${d.list(kinds.length)}) AND ${d.jsonText(input, '$.prepare.id')} = ?
     ORDER BY created_at, ${d.seq()}`,
    [userId, ...kinds, prepareId],
  );
  return rows.map((row) => ({ id: row.id, kind: row.kind, input: (row.input === null ? null : JSON.parse(row.input)) as unknown }));
}
