import { CONSTANTS, type ErrorCode } from '@tailorit/shared';
import { AppError } from '../core/http/errors';
import type { AiUsage } from './usage';

/**
 * What went wrong with an AI call, so callers react in the right direction: a signed-out CLI is not fixed by retrying,
 * a spent usage window is not fixed by another prompt. Each kind maps to `ai_unavailable` (503: the server cannot do
 * AI right now) or `ai_failed` (502: this one request went wrong; trying again may work).
 *
 * v2.0 (docs/design/v2.0/03-ai-usage.md, "Messages, and what people never see"): every `ai_unavailable` a person sees
 * says MSG_AI_UNAVAILABLE and nothing else: no reason (signed out, rate limited, restarting, a busy slot) and no retry
 * time, which would tell them about the server. The reason stays in `detail`, for the log and the admin's test.
 */
export const AI_ERROR_KINDS = [
  'auth',
  'rateLimited',
  'modelUnavailable',
  'unavailable',
  'failed',
  'timeout',
  'stalled',
  'truncated',
  'malformed',
  'cancelled',
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

const UNAVAILABLE: ReadonlySet<AiErrorKind> = new Set([
  'auth',
  'rateLimited',
  'modelUnavailable',
  'unavailable',
  'stalled',
]);

/**
 * v2.0: MSG_AI_UNAVAILABLE's shipped text, where no constants service is at hand (the provider). The queue, the gate and
 * requireAi say the resolved constant instead (an admin may change it at runtime).
 */
export const AI_UNAVAILABLE_TEXT: string = CONSTANTS.MSG_AI_UNAVAILABLE.default;

/** v2.0: what each kind means, for the log and the admin's test only (an unavailable AiError's `detail` starts with it). */
export const AI_ERROR_DETAILS: Record<AiErrorKind, string> = {
  auth:
    'AI is unavailable because the Claude sign-in on this server is missing or has expired. ' +
    'Sign the Claude CLI in again.',
  rateLimited: 'The Claude usage limit has been reached for now.',
  modelUnavailable: 'The AI model configured on this server is not available. Check the model setting.',
  unavailable: 'AI is not available on this server right now.',
  failed: 'The AI request failed.',
  timeout: 'The AI took too long to answer.',
  stalled: 'The Claude CLI gave no output in time (what a spent usage window looks like).',
  truncated: 'The AI answer was cut off before it finished.',
  malformed: 'The AI reply could not be understood.',
  cancelled: 'The AI request was cancelled.',
};

/** The sentence a person sees for each kind: every unavailable kind says MSG_AI_UNAVAILABLE (v2.0). */
export const AI_ERROR_MESSAGES: Record<AiErrorKind, string> = {
  auth: AI_UNAVAILABLE_TEXT,
  rateLimited: AI_UNAVAILABLE_TEXT,
  modelUnavailable: AI_UNAVAILABLE_TEXT,
  unavailable: AI_UNAVAILABLE_TEXT,
  failed: 'The AI request failed. Please try again.',
  timeout: 'The AI took too long to answer. Please try again.',
  stalled: AI_UNAVAILABLE_TEXT,
  truncated: 'The AI answer was cut off before it finished. Please try again with less text.',
  malformed: 'The AI reply could not be understood. Please try again.',
  cancelled: 'The AI request was cancelled.',
};

/** v2.0: the technical sentences of cases that share a kind, for the log and the admin's test (`detail`). */
export const AI_DETAILS = {
  apiKey:
    'AI was stopped because the Claude CLI on this server is using an API key, which is billed per request. ' +
    'Sign it in with a Claude subscription instead.',
  binaryMissing: 'The Claude CLI is not installed on this server.',
  disabled: 'AI features are turned off on this server (AI_ENABLED=false).',
  notSetUp: 'AI is not set up on this server.',
  noHandler: 'This AI feature is not available on this server.',
  noBackground: 'Background AI work is turned off on this server (AI_CLI_BACKGROUND_SLOTS=0).',
  stopping: 'The server is restarting.',
  // v34 AIKEY: AI_BILLING=api-key while the CLI runs on its own sign-in.
  subscriptionBilled:
    'AI was stopped because AI_BILLING=api-key, but the Claude CLI on this server is using its Claude subscription ' +
    "instead of the API key. Check that ANTHROPIC_API_KEY is set for this server, then run Admin › AI's test.",
  // v34 AIKEY (review fix L1): AI_BILLING=api-key while the CLI names no credential source.
  keySourceUnknown:
    'AI was stopped because AI_BILLING=api-key, but the Claude CLI on this server did not say which sign-in pays for ' +
    "its calls, so TailorIT cannot tell that the API key does. Update the Claude CLI, then run Admin › AI's test.",
} as const;

/** The sentences a person sees for those cases: v2.0, MSG_AI_UNAVAILABLE for each (the reason is in AI_DETAILS). */
export const AI_MESSAGES = {
  apiKey: AI_UNAVAILABLE_TEXT,
  binaryMissing: AI_UNAVAILABLE_TEXT,
  disabled: AI_UNAVAILABLE_TEXT,
  subscriptionBilled: AI_UNAVAILABLE_TEXT, // v34 AIKEY
  keySourceUnknown: AI_UNAVAILABLE_TEXT, // v34 AIKEY (review fix L1)
} as const;

export function aiErrorCode(kind: AiErrorKind): ErrorCode {
  return UNAVAILABLE.has(kind) ? 'ai_unavailable' : 'ai_failed';
}

/**
 * An AppError (so routes and the task queue handle it like any other) that also says which kind of AI failure.
 *
 * v2.0: an unavailable kind's message is always MSG_AI_UNAVAILABLE (`text`: the resolved constant; default its shipped
 * text) and it carries no retry time; a specific `message` given for it goes to the start of `detail` instead.
 */
export class AiError extends AppError {
  readonly kind: AiErrorKind;
  /** Technical reason (CLI output, exit code...). Logged and shown to administrators, never to end users. */
  readonly detail: string;
  /** v1.3 C: what the failed call used, when the CLI reported it (a turn that ended in an error still may). */
  usage: AiUsage | null = null;

  constructor(
    kind: AiErrorKind,
    options: { message?: string; text?: string; detail?: string; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    const code = aiErrorCode(kind);
    const unavailable = code === 'ai_unavailable';
    super(code, unavailable ? (options.text ?? AI_UNAVAILABLE_TEXT) : (options.message ?? AI_ERROR_MESSAGES[kind]), {
      retryAfterSeconds: unavailable ? undefined : options.retryAfterSeconds,
      cause: options.cause,
    });
    this.name = 'AiError';
    this.kind = kind;
    this.detail = unavailable
      ? [options.message ?? AI_ERROR_DETAILS[kind], options.detail].filter((part) => part && part.trim()).join(' ')
      : (options.detail ?? '');
  }
}

/** "about 1 minute" / "about 7 minutes" for hold messages. */
export function aboutMinutes(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * The fail-fast error for a call turned away by an active hold (see ProviderHold). v2.0: a person reads only
 * MSG_AI_UNAVAILABLE (`text`), never how long the pause lasts; the pause and its reason are in `detail`.
 */
export function holdError(hold: { until: number; kind: AiErrorKind; reason: string }, nowMs: number, text?: string): AiError {
  const left = Math.max(0, hold.until - nowMs);
  return new AiError(hold.kind, {
    text,
    detail: `Paused for ${aboutMinutes(left)}: ${hold.reason}.`,
    retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)),
  });
}
