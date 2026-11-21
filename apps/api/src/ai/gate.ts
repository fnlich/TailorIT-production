import { aiBudgetState } from '../core/accounts/money';
import { isPersonPayer, type Payer } from '../core/accounts/payer'; // v33 SHARE-3
import { aiUnavailableError, aiUsageExhaustedError } from '../core/accounts/refusals';
import type { AppDeps } from '../core/context';
import { AppError } from '../core/http/errors';
import { capacityOf } from './capacity';

// v2.0: the server-AI gate (docs/design/v2.0/03-ai-usage.md, "The gate: when server AI is refused"; A8, A10). It is
// asked before any server-AI work starts: by the AI queue's enqueue (inside its transaction, after the dedupe lookup)
// and its runTask (before the handler), and by a route before it starts work that will need AI (POST /api/prepare).
// It decides, in order:
//   1. AI is off or not set up: ai_unavailable (MSG_AI_UNAVAILABLE);
//   2. the capacity block is on (ai/capacity.ts): ai_unavailable, for every account; the admin's test is the only
//      exception (it never asks the gate);
//   3. `chargeTo` is a person whose daily remaining is at or below 0 and whose extra credit is 0: ai_usage_exhausted
//      (MSG_AI_USAGE_EXHAUSTED, "Get extra credit", the time to the next daily reset).
// `chargeTo` a server cost (serverCost: the background job analysis) is nobody's: only 1 and 2 apply. A task already running is never
// stopped here: its runs are charged after the fact and any overshoot is written off (core/accounts/money.ts).

export type AiRefusal = {
  code: 'ai_unavailable' | 'ai_usage_exhausted';
  message: string;
  retryAfterSeconds?: number;
};

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

// v33 SHARE-3 (PLAN F9 "Who pays"): the gate reads the budget of a Payer (B's on A's profile; serverCost: nobody).
// v33 INT-1: only a Payer (the v3.2 forms, an id or null, are gone).

/** Step 1 of the gate: AI on and the queue there; else the refusal. */
export function aiOffRefusal(deps: AppDeps): AiRefusal | null {
  return !deps.config.ai.enabled || !deps.services.ai ? refusalOf(aiUnavailableError(deps)) : null;
}

/** Null when a task charged to `chargeTo` may start now; a server cost is nobody's (the capacity block only). */
export async function serverAiRefusal(deps: AppDeps, chargeTo: Payer): Promise<AiRefusal | null> {
  return aiOffRefusal(deps) ?? capacityOrBudgetRefusal(deps, chargeTo);
}

/** Throws the refusal as an AppError (the API's error body, with buyCredit and the reset for ai_usage_exhausted). */
export async function assertServerAi(deps: AppDeps, chargeTo: Payer): Promise<void> {
  const refusal = await serverAiRefusal(deps, chargeTo);
  if (refusal) throw refusalError(deps, refusal);
}

/** Step 3's decision on a budget read (null: the account no longer exists, nothing to refuse). */
export function budgetRefusal(deps: Deps, exhausted: boolean | null): AiRefusal | null {
  return exhausted ? refusalOf(aiUsageExhaustedError(deps)) : null;
}

/** Step 2's decision. */
export function capacityRefusal(deps: Deps, blocked: boolean): AiRefusal | null {
  return blocked ? refusalOf(aiUnavailableError(deps)) : null;
}

/**
 * Steps 2 and 3 of the gate, for the AI queue itself (it is the AI service, so step 1 is its own: AI on, a handler).
 * A `chargeTo` account that no longer exists has nothing to refuse (its tasks are charged to nobody).
 */
export async function capacityOrBudgetRefusal(deps: Deps, chargeTo: Payer): Promise<AiRefusal | null> {
  const capacity = capacityRefusal(deps, await capacityOf(deps).blocked());
  if (capacity || !isPersonPayer(chargeTo)) return capacity; // v33 SHARE-3
  let exhausted: boolean | null;
  try {
    exhausted = (await aiBudgetState(deps, chargeTo)).exhausted;
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'not_found')) throw error;
    exhausted = null;
  }
  return budgetRefusal(deps, exhausted);
}

/** The AppError of a refusal, built one way for every path (core/accounts/refusals.ts). */
export function refusalError(deps: Deps, refusal: AiRefusal): AppError {
  return refusal.code === 'ai_usage_exhausted' ? aiUsageExhaustedError(deps) : aiUnavailableError(deps);
}

function refusalOf(error: AppError): AiRefusal {
  return {
    code: error.code === 'ai_usage_exhausted' ? 'ai_usage_exhausted' : 'ai_unavailable',
    message: error.message,
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}
