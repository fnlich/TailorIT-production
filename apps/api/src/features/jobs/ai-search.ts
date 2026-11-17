import { Router } from 'express';
import { z } from 'zod';
import {
  AI_SEARCH_TEXT_CEILING,
  AiJobSearchBodySchema,
  AiJobSearchResultSchema,
  ERROR_CODES,
  type AiJobSearchResult,
  type AiTaskView,
  type ErrorCode,
} from '@tailorit/shared';
import { requireAi, sendAccepted, type AiTaskContext } from '../../ai/index';
import { jobSearchPrompt, type JobSearchAnswer } from '../../ai/prompts/jobs/ai-search';
import { defineAiTask } from '../../ai/task';
import { assertFeature } from '../../core/accounts/entitlements';
import { requireUser, userOf } from '../../core/auth/guards';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { AppError, notFound, validationFailed } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { parseInput } from '../../core/http/validate';
import { assertServerAi } from '../../ai/gate';
import type { AiSearchService } from '../../core/seams';

// v2.0 (A16; docs/design/v2.0/04-accounts-limits.md §4): AI job search, Paid only. The person writes what they are
// looking for in a sentence; TailorIT's AI (the `job_search` task, Haiku by default, charged to the person) turns it
// into the classic search's filters, and the classic search runs them, so the person can change every filter by hand.
//   POST /api/jobs/ai-search {text} → 202 {taskId}. The page polls GET /api/ai/tasks/:id, whose result is an
//   AiJobSearchResult, then puts the query in the URL.
// The checks, in order: the plan (assertFeature 'ai_job_search': a Free account gets 403 paid_feature with
// MSG_PAID_AI_SEARCH and Subscribe, and no task); the sentence's length (AI_SEARCH_TEXT_MAX_CHARS); the AI gate
// (ai_unavailable, ai_usage_exhausted), which the AI queue's enqueue applies again. MCP's ai_search_jobs runs the same
// service (deps.services.aiSearch), waits for the answer and runs the classic search itself (07-mcp.md).
// v30 ST3: the prompt is ai/prompts/jobs/ai-search.ts. v3.0 D2-C: the route and the seam's start (core/seams.ts, MCP's)
// both run startAiSearch (async).

// ------------------------------------------------------------------------------------------------- the answer

/** Filters the model cannot know (company ids) or that belong to the page (its list's cursor): never taken. */
const NOT_FROM_AI = new Set(['companies', 'cursor']);
const EXPLANATION_MAX = 300;

/** The sentence as one line: spaces and line breaks folded, trimmed. */
export function searchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** At most `max` characters, cut at a word when one ends near the end. */
function cutAtWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max - 40 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '').trim();
}

/**
 * The answer as the classic search's query: each filter read with the URL parser's rules (normalizeJobsQuery, through
 * AiJobSearchResultSchema), so an unknown value is dropped and the rest kept; company ids and a cursor are never taken.
 */
export function finishJobSearch(answer: JobSearchAnswer): AiJobSearchResult {
  const query = Object.fromEntries(Object.entries(answer.query).filter(([key]) => !NOT_FROM_AI.has(key)));
  const explanation = cutAtWord(searchText(answer.explanation ?? ''), EXPLANATION_MAX);
  return AiJobSearchResultSchema.parse({ query, explanation });
}

const TaskInputSchema = z.object({ text: z.string().min(1).max(AI_SEARCH_TEXT_CEILING) });

/** The `job_search` task: the person's sentence in, the classic search's query and one line out. Nothing is stored. */
export async function runJobSearch(input: z.infer<typeof TaskInputSchema>, ctx: AiTaskContext): Promise<AiJobSearchResult> {
  return finishJobSearch(await ctx.runPrompt(jobSearchPrompt, { text: input.text }));
}

/**
 * v30 ST3: the `job_search` task kind (defineAiTask), listed on jobsFeature.aiTasks: queued by the service below with
 * the person who asked, who pays (charge 'person'); Haiku by default (config/models.ts).
 */
export const jobSearchTask = defineAiTask({
  kind: 'job_search',
  prompts: [jobSearchPrompt],
  parse: TaskInputSchema,
  charge: 'person',
  defaultModel: 'haiku',
  run: (_deps, input, ctx) => runJobSearch(input, ctx),
});

// ------------------------------------------------------------------------------------------------- the service

const SEARCH_NOT_FOUND = 'That AI search';
const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/**
 * A finished task's failure as the error the caller answers (an unknown code reads as ai_failed). v20 FIX-A (REQ-3):
 * a failure with no words of its own says MSG_AI_SEARCH_FAILED.
 */
function taskError(deps: AppDeps, view: AiTaskView): AppError {
  const code = view.error?.code;
  const errorCode = code && ERROR_CODE_SET.has(code) ? (code as ErrorCode) : 'ai_failed';
  return view.error?.message ? new AppError(errorCode, view.error.message) : refuse(deps, errorCode, 'MSG_AI_SEARCH_FAILED');
}

/** The sentence as the task takes it, after its checks (empty, too long). */
function checkedText(deps: AppDeps, rawText: string): string {
  const text = searchText(rawText);
  if (!text) throw validationFailed('Say what jobs you are looking for.', { text: 'empty' });
  const max = constantsOf(deps).get('AI_SEARCH_TEXT_MAX_CHARS');
  if (Array.from(text).length > max) {
    throw refuse(deps, 'validation_failed', 'MSG_TEXT_TOO_LONG', { max }, { fields: { text: 'too_long' } });
  }
  return text;
}

/**
 * assertFeature('ai_job_search'), the sentence's checks, then the AI gate; queues a `job_search` task charged to the
 * person (the seam's `start`, async).
 */
export async function startAiSearch(deps: AppDeps, userId: string, rawText: string): Promise<{ taskId: string }> {
  // Free: 403 paid_feature with Subscribe, before anything else (no task is made).
  await assertFeature(deps, userId, 'ai_job_search');
  const text = checkedText(deps, rawText);
  requireAi(deps);
  // The AI gate, before the task is queued (the queue's enqueue checks it again, in its transaction).
  await assertServerAi(deps, userId);
  const { taskId } = await jobSearchTask.enqueue(deps, { userId, input: { text } });
  return { taskId };
}

/** deps.services.aiSearch (core/seams.ts), set by the jobs feature. */
export function createAiSearchService(deps: AppDeps): AiSearchService {
  return {
    start: (userId, text) => startAiSearch(deps, userId, text),

    async result(userId, taskId, waitMs) {
      const ai = requireAi(deps);
      let view = await ai.getTask(taskId, userId);
      if (!view || view.kind !== 'job_search') throw notFound(SEARCH_NOT_FOUND);
      if (view.status === 'queued' || view.status === 'running') {
        try {
          view = await ai.waitFor(taskId, waitMs);
        } catch {
          // Nobody will read a later answer: the task is stopped, so it spends nothing more.
          await ai.cancel(taskId, userId);
          throw refuse(deps, 'ai_failed', 'MSG_AI_SEARCH_TIMEOUT');
        }
      }
      if (view.status === 'succeeded') return AiJobSearchResultSchema.parse(view.result);
      throw taskError(deps, view);
    },
  };
}

// --------------------------------------------------------------------------------------------------- the route

/** Mounted at /api/jobs/ai-search (before /api/jobs, as Save all is). */
export function createAiSearchRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  router.post('/', async (req, res) => {
    const { text } = parseInput(AiJobSearchBodySchema, req.body ?? {});
    sendAccepted(res, await startAiSearch(deps, userOf(req).id, text));
  });

  return router;
}
