import { z } from 'zod';
import { IsoDateTime } from './list';

/**
 * Every non-2xx API response has this body. `code` is machine-readable and stable; `message` is a sentence a person
 * can act on, shown as-is in the UI.
 */
export const ERROR_CODES = [
  'not_signed_in',
  'forbidden',
  'not_found',
  'validation_failed',
  'conflict',
  /** A save made from an older revision of a document than the one stored (another tab saved in between). */
  'revision_conflict',
  'cooldown',
  'rate_limited',
  'file_too_large',
  'unsupported_file',
  'ai_unavailable',
  'ai_busy',
  'ai_failed',
  'render_failed',
  'browser_unavailable',
  /** The Google Sheet import cannot run: no usable service account key, the Sheets API is off, or Google is down. */
  'sheets_unavailable',
  /** An address TailorIT cannot add a job from (the extension's Add job: not a Greenhouse or Lever posting it reads). */
  'unsupported',
  /** A job board answered with something TailorIT cannot read. */
  'ats_failed',
  /** A job board could not be reached in time (down, slow or rate limiting). */
  'ats_unavailable',
  'system_template_read_only',
  'sign_in_unavailable',
  'account_disabled',
  'bad_origin',
  'internal',
  // v1.4 D: tailoring from an uploaded resume that has no editable copy yet (make one in Documents first).
  'needs_editable_copy',
  // end v1.4 D
  // v2.0 (docs/design/v2.0/03-ai-usage.md, 04-accounts-limits.md): the account limits.
  /** The person's daily AI budget and extra credit are used up (MSG_AI_USAGE_EXHAUSTED; `buyCredit`, `retryAfterSeconds`). */
  'ai_usage_exhausted',
  /** A Free account at its resume limit (MSG_LIMIT_RESUMES; `subscribe`). */
  'resume_limit_reached',
  /** A Paid-only feature asked by a Free account: AI job search, batch resume download (`subscribe`). */
  'paid_feature',
  // end v2.0
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  not_signed_in: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  revision_conflict: 409,
  cooldown: 429,
  rate_limited: 429,
  file_too_large: 413,
  unsupported_file: 415,
  ai_unavailable: 503,
  ai_busy: 409,
  ai_failed: 502,
  render_failed: 500,
  browser_unavailable: 503,
  sheets_unavailable: 503,
  unsupported: 400,
  ats_failed: 502,
  ats_unavailable: 503,
  system_template_read_only: 403,
  sign_in_unavailable: 503,
  account_disabled: 403,
  bad_origin: 403,
  internal: 500,
  // v1.4 D
  needs_editable_copy: 409,
  // end v1.4 D
  // v2.0
  ai_usage_exhausted: 429,
  resume_limit_reached: 403,
  paid_feature: 403,
  // end v2.0
};

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    /** Per-field messages for form validation, keyed by the request field path (e.g. "name", "salary.min"). */
    fields: z.record(z.string(), z.string()).optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
    requestId: z.string().optional(),
    // v2.0: which buttons a limit message shows (the web's LimitNotice), never anything about the server.
    /** Show the Subscribe button: a plan-limit message to a Free account. */
    subscribe: z.boolean().optional(),
    /** Show "Get extra credit" (ai_usage_exhausted). */
    buyCredit: z.boolean().optional(),
    /** When a daily limit resets (auto-apply, AI usage). */
    resetAt: IsoDateTime.optional(),
    // end v2.0
  }),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
