import type { ErrorCode, MessageKey, MessageParams } from '@tailorit/shared';
import { constantsOf } from '../constants/service';
import type { AppDeps } from '../context';
import { AppError, type AppErrorLimitFields } from './errors';

// v30 ST0: the refusal base (PLAN §6, "Refusals"). A refusal a person reads is one error code and one MSG_* constant,
// rendered by the constants service at the moment of the refusal (an admin's override in Admin › Constants reaches it
// at once; {contact_email} and {reset_time} fill themselves). A feature never builds such an AppError with words of its
// own: it throws refuse(...). The status comes from the code (ERROR_STATUS), as for every AppError.
//
//   throw refuse(deps, 'conflict', 'MSG_SAVED_SEARCHES_MAX', { max });
//   throw refuse(deps, 'validation_failed', 'MSG_FANOUT_TOO_MANY_JOBS', { max }, { fields: { jobIds: words } });
//   throw refuse(deps, 'resume_limit_reached', 'MSG_LIMIT_RESUMES', { limit }, { subscribe: true });
//
// core/accounts/refusals.ts keeps the account limits' refusals (they add the reset time and the buttons); they are
// built on this too once ST4 moves them.

export interface RefuseOptions extends AppErrorLimitFields {
  /** Per-field words for a form (validation_failed). */
  fields?: Record<string, string>;
  /** Sets Retry-After and the body's retryAfterSeconds (a 429). */
  retryAfterSeconds?: number;
  /** Only where a code's usual status does not fit (rare: ERROR_STATUS decides otherwise). */
  status?: number;
  /** The underlying error, for the log of a 5xx. */
  cause?: unknown;
}

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The AppError of one refusal: `code`, the constant `key`'s words with `params` filled, and the options. */
export function refuse(deps: Deps, code: ErrorCode, key: MessageKey, params?: MessageParams, options: RefuseOptions = {}): AppError {
  return new AppError(code, constantsOf(deps).message(key, params), options);
}
