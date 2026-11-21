import type { Response } from 'express';
import type { AiTaskAccepted } from '@tailorit/shared';
import type { AppDeps } from '../core/context';
import { AI_DETAILS, AiError } from './errors';
import type { AiService } from './queue';

// Public surface of the AI layer for feature packages. Prompt modules live with their feature; handlers are
// registered in the feature's `services` hook (ai-tasks runs before every feature that uses AI).

export {
  AI_DETAILS,
  AI_ERROR_DETAILS,
  AI_ERROR_KINDS,
  AI_ERROR_MESSAGES,
  AI_MESSAGES,
  AI_UNAVAILABLE_TEXT,
  AiError,
  aiErrorCode,
  type AiErrorKind,
} from './errors';
// v2.0: the gate (03-ai-usage.md) and the seat's capacity readings.
export { assertServerAi, serverAiRefusal, type AiRefusal } from './gate';
export { capacityOf, type AiCapacityService, type CapacityState } from './capacity';
export { extractJSON, JSON_BEGIN, JSON_END, JsonExtractError, repairJson } from './json';
export {
  buildSystemText,
  jsonInstruction,
  promptTexts,
  type PromptCallInfo,
  type PromptModule,
  type RunPrompt,
  type RunPromptOptions,
} from './runPrompt';
export {
  createAiService,
  describeHealth,
  MAX_ACTIVE_PER_USER_KIND,
  type AiService,
  type AiTaskContext,
  type AiTaskEvent,
  type AiTaskHandler,
  type AiTestResult,
  type EnqueueOptions,
  type TaskViewer, // v33 SHARE-3
} from './queue';
export { taskViewerOf } from './viewer'; // v33 SHARE-3
export type { AiPriority } from './semaphore';
export type { AiProvider, CompletionRequest, CompletionResult, ProviderHold } from './provider/types';
// v1.3 C: usage (decision 8) and the result cache (decision 11).
export { microsOf, readUsageSummary, recordCachedItems, type AiCostSource, type AiUsage } from './usage';
export { createResultCache, itemHash, type ResultCache } from './resultCache';

/** The AI service, or a 503 a person can read when this server was built without it (v2.0: MSG_AI_UNAVAILABLE). */
export function requireAi(deps: Pick<AppDeps, 'services'>): AiService {
  const ai = deps.services.ai;
  if (!ai) {
    const text = deps.services.constants?.message('MSG_AI_UNAVAILABLE');
    throw new AiError('unavailable', { text, message: AI_DETAILS.notSetUp });
  }
  return ai;
}

/** Answers an AI endpoint: 202 { taskId }. The page then polls GET /api/ai/tasks/:id. */
export function sendAccepted(res: Response, accepted: { taskId: string }): void {
  const body: AiTaskAccepted = { taskId: accepted.taskId };
  res.status(202).json(body);
}
