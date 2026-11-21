import type { Request, RequestHandler } from 'express';
import { HOUR_MS } from '@tailorit/shared'; // v33 SHARE-0
import type { ExtensionScope } from '@tailorit/shared/autofill';
import type { SharePermission } from '@tailorit/shared/sharing'; // v33 SHARE-0
import type { SessionUser } from '../context';
import { adminOnly, notSignedIn } from '../http/errors';
import { ownProfileOnly } from './grants'; // v33 SHARE-0

/** Route guard: 401 unless a session cookie identified an account (see session.ts). */
export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(notSignedIn());
  next();
};

/** Route guard: 401 when signed out, 403 when signed in without the admin role. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(notSignedIn());
  if (req.user.role !== 'admin') return next(adminOnly());
  next();
};

/**
 * The account whose data the request touches, for a request already behind `requireUser`: the signed-in account, or,
 * v33 SHARE-0, while the request acts on a profile shared with them (req.acting), that profile's owner with the role
 * `user` (no admin power reaches anyone's data through a shared profile). While a named profile is not decided yet
 * (req.actingCandidate set, req.acting undefined: code before the route guard) it throws own_profile_only: it fails
 * closed. A request that names no profile reads as before.
 */
export function userOf(req: Request): SessionUser {
  if (!req.user) throw notSignedIn();
  // v33 SHARE-0
  if (req.acting) return req.acting.owner;
  if (req.actingCandidate && req.acting === undefined) throw ownProfileOnly();
  // end v33 SHARE-0
  return req.user;
}

// v33 SHARE-0 (PLAN F9; SP v33 PLAN-sharing.md §4 "Helpers", §5): the other two roles of a request, and the checks that
// used to assume a session means the profile's owner.

/** Who acts: the signed-in account (B on a shared profile), with their own role. Never the profile's owner. */
export function actorOf(req: Request): SessionUser {
  if (!req.user) throw notSignedIn();
  return req.user;
}

/** Who pays for the request's AI work: B under the grant while acting, else the signed-in account (accounts/payer.ts). */
export { payerOf } from '../accounts/payer';

/** Whether the request acts on a profile shared with the signed-in person (the route guard let it). */
export const isActing = (req: Request): boolean => Boolean(req.acting);

/**
 * Whether the request may do what `perm` guards, in place of `req.authVia !== 'token' || <the token holds scope>`:
 * - an extension token (always its owner's own profile): when it holds `scope` (none given: refused);
 * - a session acting on a shared profile: when the grant holds `perm`;
 * - a session on its own profile (none named, or a `self` route decided the request is the person's own): always;
 * - a session whose named profile is not decided yet: never (fails closed).
 */
export function holds(req: Request, perm: SharePermission, scope?: ExtensionScope): boolean {
  if (!req.user) return false;
  if (req.authVia === 'token') return scope !== undefined && req.extensionToken?.scopes.includes(scope) === true;
  if (req.acting) return req.acting.permissions.includes(perm);
  return !(req.actingCandidate && req.acting === undefined); // v33 SHARE-1: a `self` route decided the own profile
}

/** Windows shorter than this count the actor on each profile apart (anti-flood); longer ones count the actor once. */
export const RATE_KEY_PAIR_BELOW_MS = HOUR_MS;

/**
 * The person part of a rate limit's key, for a window of `windowMs`: `<actor>` for an hour or more (a person's hourly
 * and daily limits are never multiplied by the profiles they work on), `<actor>><owner>` for a shorter window while
 * acting (an anti-flood limit per profile). A request that acts on no profile gets `<actor>`, the key it had before.
 */
export function rateKeyOf(req: Request, windowMs: number): string {
  const actor = actorOf(req).id;
  const owner = req.acting ? req.acting.owner.id : null;
  return owner !== null && owner !== actor && windowMs < RATE_KEY_PAIR_BELOW_MS ? `${actor}>${owner}` : actor;
}
// end v33 SHARE-0
