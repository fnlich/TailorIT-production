import type { Role } from '@tailorit/shared';
import type { ExtensionScope } from '@tailorit/shared/autofill';
import type { ProfileKey, SharePermission } from '@tailorit/shared/sharing'; // v33 SHARE-0
import type { AppConfig } from '../config/env';
import type { LiveGrant } from './auth/grants'; // v33 SHARE-0
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

// v33 SHARE-0 (PLAN F9; SP v33 PLAN-sharing.md §4): a request that acts on someone else's profile. Three roles:
// userOf(req) is whose data (A, the profile's owner, as an ActingOwner), actorOf(req) who acts (B, req.user), payerOf(req)
// who pays (B, with the grant). Two steps set them (SHARE-1), after attachUser and tokenScope:
// 1. attachActing reads the profile a request names (PROFILE_HEADER, or PROFILE_QUERY on GET and HEAD), resolves its
//    grant for req.user (core/auth/grants.ts resolveGrant) and sets req.actingCandidate. A request that names none has
//    neither field; nothing is stored in the session.
// 2. The route guard reads the route's policy (Feature.routes' `acting`) and decides: req.acting = the ActingContext when
//    the route may act on the profile; req.acting = null when it serves the signed-in person (a `self` route); a refusal
//    otherwise (profile_ended, own_profile_only, profile_not_shared, a bad query form).
// While a candidate is set and req.acting is still undefined (not decided), userOf and payerOf throw own_profile_only:
// code that runs before the guard fails closed.

/** The profile's owner as a request acting on it reads them (userOf): their role is always `user`. */
export interface ActingOwner extends SessionUser {
  role: 'user';
}

/** The profile a request names, as attachActing read it, before the route guard decides. */
export interface ActingCandidate {
  /** The key as named (well-formed: a malformed one is refused before this is set). */
  key: ProfileKey;
  /** Where the request named it. */
  via: 'header' | 'query';
  /** Its grant when live for the signed-in person (resolveGrant); null: unknown, someone else's, or ended. */
  grant: LiveGrant | null;
}

/** The profile a request acts on, set by the route guard once the route's policy lets it act there. */
export interface ActingContext {
  /** The grant's id: the profile key. */
  grantId: ProfileKey;
  /** Whose data (userOf): the owner, role `user`. */
  owner: ActingOwner;
  /** The grant's boxes at this request (holds reads them). */
  permissions: readonly SharePermission[];
  /** The permission the route's policy named: the payer's `perm`, and the work it starts is stopped when it goes. */
  routePerm: SharePermission;
}
// end v33 SHARE-0

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
    // v33 SHARE-0 (see ActingContext above)
    /** The profile the request names, before the route guard decides; absent when it names none. */
    actingCandidate?: ActingCandidate;
    /** The guard's decision: the profile acted on; null: the signed-in person's own (no key, or a `self` route). */
    acting?: ActingContext | null;
    // end v33 SHARE-0
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
