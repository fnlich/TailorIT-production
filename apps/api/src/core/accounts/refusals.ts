import { constantsOf } from '../constants/service';
import { nextDailyResetAt } from '../constants/day';
import type { AppDeps } from '../context';
import type { AppError } from '../http/errors';
import { refuse } from '../http/refuse';

// v2.0: the account limits' refusals, built one way for every path (docs/design/v2.0/03-ai-usage.md, "Messages, and
// what people never see"; 04-accounts-limits.md). Each message is the constant's, rendered by the server. None says
// anything about the server: ai_unavailable carries no retry time, which would reveal the server's state. v30 ST4: each
// is a refuse() (core/http/refuse.ts): one error code, one constant, rendered at the moment of the refusal.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** 503 ai_unavailable, MSG_AI_UNAVAILABLE: AI off, not set up, held, or the capacity block. */
export function aiUnavailableError(deps: Deps): AppError {
  return refuse(deps, 'ai_unavailable', 'MSG_AI_UNAVAILABLE');
}

/** 429 ai_usage_exhausted, MSG_AI_USAGE_EXHAUSTED, "Get extra credit", until the next daily reset. */
export function aiUsageExhaustedError(deps: Deps): AppError {
  const resetAt = nextDailyResetAt(deps);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - deps.now().getTime()) / 1000));
  return refuse(deps, 'ai_usage_exhausted', 'MSG_AI_USAGE_EXHAUSTED', undefined, {
    buyCredit: true,
    retryAfterSeconds,
    resetAt: resetAt.toISOString(),
  });
}

/**
 * 403 resume_limit_reached with the limit: MSG_LIMIT_RESUMES and Subscribe for a Free account; v20 FIX-A (INT-open)
 * MSG_LIMIT_RESUMES_ACCOUNT for any other account an admin gave a finite limit (no "Free", no Subscribe).
 */
export function resumeLimitError(deps: Deps, limit: number, options: { free: boolean }): AppError {
  const key = options.free ? 'MSG_LIMIT_RESUMES' : 'MSG_LIMIT_RESUMES_ACCOUNT';
  return refuse(deps, 'resume_limit_reached', key, { limit }, options.free ? { subscribe: true } : {});
}

/**
 * v20 FIX-A (INT-open): the auto-apply limit's words, {reset_time} filled: MSG_LIMIT_AUTO_APPLY (it says Subscribe) for
 * a Free account, MSG_LIMIT_AUTO_APPLY_ACCOUNT for any other account an admin gave a finite limit.
 */
export function autoApplyLimitMessage(deps: Deps, limit: number, options: { free: boolean }): string {
  return constantsOf(deps).message(options.free ? 'MSG_LIMIT_AUTO_APPLY' : 'MSG_LIMIT_AUTO_APPLY_ACCOUNT', { limit });
}
