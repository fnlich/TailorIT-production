import type { Request, RequestHandler } from 'express';
import { isProfileKey, PROFILE_HEADER, PROFILE_QUERY, PROFILE_SELF, type ProfileKey } from '@tailorit/shared/sharing';
import type { AppDeps } from '../context';
import { badProfile, ownProfileOnly, resolveGrant } from './grants';

// v33 SHARE-1 (PLAN F9 "Acting"; SP v33 PLAN-sharing.md §4 "attachActing"): the first of the two steps that let a request
// act on a profile someone shared with the signed-in person (core/context.ts names both). It runs after attachUser and
// tokenScope (app.ts) and only READS which profile the request names; the route guard (route-policy.ts) decides what the
// route does with it. Nothing is stored in the session and nothing is cached: every request reads its grant again.
//
// A request names a profile with the header X-TailorIT-Profile: <key> (every API request of an acting tab), or, on GET
// and HEAD only, with ?profile=<key> (a URL the browser loads itself: an image, a download). `me` names the signed-in
// person's own profile, the same as naming none. Then:
//   - signed out: the names are ignored, so signing in still works from a tab that was acting;
//   - an extension token: 403 own_profile_only (a token is always its owner's own; API 9 never names one);
//   - a malformed key, a query form on a write, or a header and a query that disagree: 400 validation_failed;
//   - otherwise req.actingCandidate = { key, via, grant }, grant = resolveGrant(the signed-in person, key): the live
//     grant, or null for a key that is unknown, someone else's (the owner's own key included) or ended. The guard
//     answers all three alike (profile_ended, with no name and no id).
// The query parameter is taken off req.query once read: it names the profile, it is never a route's input.

/** The methods the query form is read on: the browser loads those URLs itself (the header needs a script). */
const QUERY_FORM_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** What one form (header or query) names: nothing, the person's own profile, a key, or something malformed. */
type Named = { kind: 'none' } | { kind: 'self' } | { kind: 'key'; key: ProfileKey } | { kind: 'malformed' };

function namedBy(value: unknown): Named {
  if (value === undefined) return { kind: 'none' };
  if (typeof value !== 'string') return { kind: 'malformed' }; // ?profile=a&profile=b, ?profile[x]=...
  const text = value.trim();
  if (text === PROFILE_SELF) return { kind: 'self' };
  return isProfileKey(text) ? { kind: 'key', key: text } : { kind: 'malformed' };
}

const sameName = (a: Named, b: Named): boolean =>
  a.kind === b.kind && (a.kind !== 'key' || (b.kind === 'key' && a.key === b.key));

/** The query form's raw value, taken off req.query (undefined when the request has none). */
function takeQueryForm(req: Request): unknown {
  const query = req.query as Record<string, unknown> | undefined;
  if (!query || !Object.prototype.hasOwnProperty.call(query, PROFILE_QUERY)) return undefined;
  const value = query[PROFILE_QUERY];
  delete query[PROFILE_QUERY];
  return value;
}

/**
 * The profile named by a header value and a query value (either undefined when absent) on a request of `method`: null
 * for none or `me`, else the key and the form it came in. Throws badProfile (400) for a malformed name, the query form
 * on a write, or two forms that disagree. Exported for the unit tests.
 */
export function profileNamed(
  method: string,
  headerValue: unknown,
  queryValue: unknown,
): { key: ProfileKey; via: 'header' | 'query' } | null {
  const header = namedBy(headerValue);
  const query = namedBy(queryValue);
  if (header.kind === 'none' && query.kind === 'none') return null;
  // A write never takes the profile from its address: refused, never quietly done on the person's own profile.
  if (query.kind !== 'none' && !QUERY_FORM_METHODS.has(method.toUpperCase())) throw badProfile();
  if (header.kind === 'malformed' || query.kind === 'malformed') throw badProfile();
  if (header.kind !== 'none' && query.kind !== 'none' && !sameName(header, query)) throw badProfile();
  if (header.kind === 'key') return { key: header.key, via: 'header' };
  if (query.kind === 'key') return { key: query.key, via: 'query' };
  return null; // `me`
}

/**
 * The middleware (app.ts, after tokenScope): sets req.actingCandidate on a signed-in request that names a profile. See
 * the comment at the top for every case. One primary-key read per acting request (resolveGrant).
 */
export function attachActing(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    const headerValue = req.get(PROFILE_HEADER);
    const queryValue = takeQueryForm(req);
    if (headerValue === undefined && queryValue === undefined) return next();
    // Signed out: ignored (sign-in, and the sign-in page's own reads, from a tab that was acting).
    if (!req.user) return next();
    // An extension token is always its owner's own profile.
    if (req.authVia === 'token') return next(ownProfileOnly());
    try {
      const named = profileNamed(req.method, headerValue, queryValue);
      if (!named) return next();
      const grant = await resolveGrant(deps, req.user.id, named.key);
      req.actingCandidate = { key: named.key, via: named.via, grant };
      next();
    } catch (error) {
      // A bad name (400), or the grant could not be read (500): refused, never served as the person's own profile.
      next(error);
    }
  };
}
