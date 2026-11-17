import type { Role } from '@tailorit/shared';
import type { ExtensionScope } from '@tailorit/shared/autofill';
import type { AppConfig } from '../config/env';
import type { DbClient } from './db/types';
import type { Logger } from './log';

/** Everything a feature router needs, passed in explicitly (no module-level singletons), so tests can build an app
 *  over a temporary database and a fake clock. */
export interface AppDeps {
  /** v3.0 D2: the async data layer (core/db): one, all, run, tx, lockPerson and the dialect helpers. */
  db: DbClient;
  config: AppConfig;
  log: Logger;
  /** The clock. Tests freeze it. */
  now: () => Date;
  /** Services registered by work packages (AI queue, PDF pool, analysis...). Filled in by createServices(). */
  services: AppServices;
}

/**
 * Cross-feature services. Each is owned by one work package and created once at startup (see services.ts).
 * Everything is optional at the type level only until its package lands; features must handle a missing service
 * by answering 503 with a clear message.
 */
export interface AppServices {
  [name: string]: unknown;
}

/** The signed-in account attached to a request by the session middleware (work package F3). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    user?: SessionUser;
    /** sha256 of the session token that authenticated this request (for sign-out). */
    sessionTokenHash?: string;
    /** How `user` was identified. 'token' is set as soon as a request names an extension token, even one that
     *  fails, so it never falls back to the cookie (core/auth/extension-tokens.ts). */
    authVia?: 'session' | 'token';
    /** The extension token behind a token request: its id (not a secret) and its scopes. */
    extensionToken?: { id: string; scopes: readonly ExtensionScope[] };
  }
}

export const nowIso = (deps: Pick<AppDeps, 'now'>) => deps.now().toISOString();
/**
 * Today's calendar date, "YYYY-MM-DD", in the server's own time zone (audit D1). TailorIT's server runs on the person's
 * own machine, so its day is theirs: a job saved or applied to from the extension at 18:30 in California is dated that
 * day, never the next one (UTC's). The browser's own dates (occurredOn) are taken as sent.
 */
export const todayIso = (deps: Pick<AppDeps, 'now'>) => localDateIso(deps.now());

/** `at`'s calendar date in the server's time zone (the process's TZ), "YYYY-MM-DD". */
export function localDateIso(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(at.getFullYear()).padStart(4, '0')}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}
