import { Router, type Request, type RequestHandler } from 'express';
import type { AiTaskKind } from '@tailorit/shared';
import { AUTOFILL_AI_STREAM_HEARTBEAT_MS, AUTOFILL_TASK_KINDS, AutofillTaskStreamEventSchema } from '@tailorit/shared/autofill';
import { requireAi, type AiTaskEvent } from '../../ai/index';
import { userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { AppError, notFound } from '../../core/http/errors';
import { allow, perAccountLimit } from '../autofill/auth';

// AI task polling. Owned by work package F4 (see docs/ARCHITECTURE.md §9). A task is visible to its owner only;
// anyone else gets the same 404 as for a task that does not exist. The TailorIT Autofill extension's token
// (core/auth/extension-tokens.ts) needs the `ai:run` scope here and sees only the autofill kinds: any other task
// answers it that same 404, and it never cancels one.

/** The kinds a token may see: the autofill tasks' (the contract's AUTOFILL_TASK_KINDS). */
const TOKEN_TASK_KINDS: readonly AiTaskKind[] = AUTOFILL_TASK_KINDS;

/** Polls and cancels per account a minute, for a token: the extension polls every 1.5 s, a few tasks at a time. */
export const TOKEN_TASK_REQUESTS_PER_MINUTE = 300;

const tokenMaySee = (req: Request, kind: AiTaskKind) => req.authVia !== 'token' || TOKEN_TASK_KINDS.includes(kind);

/**
 * v5 (Jobright parity, Phase 2): how long one task's stream stays open at most. Past it the stream ends without its
 * `task` event and the caller polls; the task itself goes on. The review's security 6a: the extension gives a task
 * 120 s, so a stream never stays past STREAM_MAX_MS, nor past twice the CLI's timeout and a minute (waitFor's).
 */
export const STREAM_MAX_MS = 150_000;
export const streamCapMs = (timeoutMs: number) => Math.min(STREAM_MAX_MS, 2 * timeoutMs + 60_000);
/** The review's security 6a: the streams one account may hold open at once, and one task. Past either, 429
 *  `rate_limited`: the extension then polls the task, as it does where TailorIT has no stream. */
export const STREAMS_PER_ACCOUNT = 6;
export const STREAMS_PER_TASK = 2;

/** One server-sent event: its type as the event's name, its JSON as its one data line (JSON has no line breaks). */
const sse = <E extends { type: string }>(event: E) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** Mounted at /api/ai/tasks. */
export function createAiTasksRouter(deps: AppDeps): Router {
  const router = Router();
  // A session as before; a token only with `ai:run` (403 without it), and within its own rate limit.
  const tokenLimit = perAccountLimit('autofill-ai-tasks', TOKEN_TASK_REQUESTS_PER_MINUTE, 60_000);
  const limitTokens: RequestHandler = (req, res, next) =>
    req.authVia === 'token' ? tokenLimit(req, res, next) : next();
  router.use(allow('either', 'ai:run'), limitTokens);

  /** GET /api/ai/tasks/:id → AiTaskView. */
  router.get('/:id', async (req, res) => {
    const task = await requireAi(deps).getTask(req.params.id, userOf(req).id);
    if (!task || !tokenMaySee(req, task.kind)) throw notFound('That AI task');
    res.json(task);
  });

  /**
   * GET /api/ai/tasks/:id/stream → text/event-stream (v5, the contract's AutofillTaskStreamEvent): the items the task
   * published so far and each one as it is published, then the finished task, then the end. A comment line every
   * AUTOFILL_AI_STREAM_HEARTBEAT_MS while nothing comes; the stream ends at its cap (streamCapMs) or when the caller
   * goes. A token sees the autofill kinds only (the same 404 otherwise), and an autofill item is checked against the
   * contract before it is sent; anything else a task publishes is not sent to a token. `no-transform` keeps a proxy's
   * compression (Next's rewrite) from holding the events back. The log names the task and counts only.
   */
  /** The streams open now, by account and by task (security 6a). */
  const openByAccount = new Map<string, number>();
  const openByTask = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string, by: number) => {
    const next = (map.get(key) ?? 0) + by;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  };
  router.get('/:id/stream', async (req, res) => {
    const ai = requireAi(deps);
    const userId = userOf(req).id;
    const task = await ai.getTask(req.params.id, userId);
    if (!task || !tokenMaySee(req, task.kind)) throw notFound('That AI task');
    if ((openByAccount.get(userId) ?? 0) >= STREAMS_PER_ACCOUNT || (openByTask.get(task.id) ?? 0) >= STREAMS_PER_TASK) {
      throw new AppError('rate_limited', 'Too many streams are open. Read the task by its id instead.',
        { retryAfterSeconds: 5 });
    }
    bump(openByAccount, userId, 1);
    bump(openByTask, task.id, 1);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let ended = false;
    let sent = 0;
    let stop: (() => void) | null = null;
    const ping = setInterval(() => {
      if (!ended) res.write(': ping\n\n');
    }, AUTOFILL_AI_STREAM_HEARTBEAT_MS);
    ping.unref?.();
    const end = () => {
      if (ended) return;
      ended = true;
      bump(openByAccount, userId, -1);
      bump(openByTask, task.id, -1);
      clearInterval(ping);
      clearTimeout(cap);
      stop?.();
      res.end();
      deps.log.debug(`[ai] task ${task.id} stream ended after ${sent} item(s)`);
    };
    const cap = setTimeout(end, streamCapMs(deps.config.ai.timeoutMs));
    cap.unref?.();
    req.on('close', end);
    const stopper = await ai.watch(task.id, userId, (event: AiTaskEvent) => {
      if (ended) return;
      if (event.type === 'task') {
        res.write(sse({ type: 'task', task: event.view }));
        end();
        return;
      }
      // Only the contract's answers and drafts are sent (the autofill kinds publish nothing else).
      const parsed = AutofillTaskStreamEventSchema.safeParse(event.item);
      if (!parsed.success || parsed.data.type === 'task') return;
      sent += 1;
      res.write(sse(parsed.data));
    });
    // v3.0 D2: the caller may have gone while the task was read.
    if (ended) stopper?.();
    else if (stopper === null) end();
    else stop = stopper;
  });

  /** DELETE /api/ai/tasks/:id → AiTaskView after cancelling (a finished task is returned unchanged). */
  router.delete('/:id', async (req, res) => {
    const ai = requireAi(deps);
    const userId = userOf(req).id;
    // The kind is checked before anything is cancelled: a token never stops a task it may not see.
    const before = await ai.getTask(req.params.id, userId);
    if (!before || !tokenMaySee(req, before.kind)) throw notFound('That AI task');
    await ai.cancel(req.params.id, userId);
    res.json((await ai.getTask(req.params.id, userId)) ?? before);
  });

  return router;
}
