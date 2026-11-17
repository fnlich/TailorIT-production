import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';
import { normalizeJobsQuery } from './query';

// v2.0 (A16; docs/design/v2.0/04-accounts-limits.md §4): AI job search, Paid only. TailorIT's AI (task kind
// `job_search`, Haiku by default, charged to the person) turns a sentence into the classic search's filters; the
// classic search then runs them, and the person can adjust every filter by hand.
//   POST /api/jobs/ai-search   AiJobSearchBody → 202 {taskId} (AiTaskAccepted). A Free account gets 403
//                              `paid_feature` (MSG_PAID_AI_SEARCH, subscribe); the AI gate may refuse with
//                              `ai_unavailable` or `ai_usage_exhausted`. The page polls GET /api/ai/tasks/:id, whose
//                              result is an AiJobSearchResult, then puts the query in the URL.
// MCP's ai_search_jobs runs the same task and the classic search itself (07-mcp.md).

/** The sentence's technical ceiling; the route checks AI_SEARCH_TEXT_MAX_CHARS (300 by default), at most this. */
export const AI_SEARCH_TEXT_CEILING = PUBLIC_CONSTANT_SPECS.AI_SEARCH_TEXT_MAX_CHARS.max;

export const AiJobSearchBodySchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Say what jobs you are looking for')
    .max(AI_SEARCH_TEXT_CEILING, messageError('MSG_TEXT_TOO_LONG', { max: AI_SEARCH_TEXT_CEILING })),
});
export type AiJobSearchBody = z.infer<typeof AiJobSearchBodySchema>;

/**
 * A finished `job_search` task's result: the classic search's query, read with normalizeJobsQuery (JobsQuerySchema,
 * with each value it does not know dropped one by one, as the URL parser drops them), and one line saying how the
 * sentence was read.
 */
export const AiJobSearchResultSchema = z.object({
  query: z.unknown().transform((value) => normalizeJobsQuery(value)),
  explanation: z.string().max(300),
});
export type AiJobSearchResult = z.infer<typeof AiJobSearchResultSchema>;
