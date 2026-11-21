import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isSharePermission, PROFILE_STATE_ENDED, PROFILE_STATE_HEADER } from '@tailorit/shared/sharing'; // v33 INT-1: isSharePermission
import { actingPermissionOf, actingRuleOf, isActingTable, type ActingMethod, type ActingPolicy, type ActingSpec } from '../feature'; // v33 INT-1: actingPermissionOf
import type { AppError } from '../http/errors';
import type { Logger } from '../log';
import { trackActingRequest } from '../../features/sharing/activity'; // v33 INT-B (SHARE-2's edit 1)
import { actingContextOf, badProfile, ownProfileOnly, profileEnded, profileNotShared } from './grants';

// v33 SHARE-1 (PLAN F9 "Acting"; SP v33 PLAN-sharing.md §4 "The route guard"): the second step of acting on a shared
// profile. Every mounted route declares what it does when a request names a profile (Feature.routes' `acting`, from an
// acting.ts beside its router: core/feature.ts ActingSpec). At mount time createApp hands each feature router to
// RoutePolicies.guard, which walks the router's stack as routeRejectionsToNext does (Express 4 keeps its Layer type
// private) and wraps the FIRST handler of each method of each route with the guard, so the guard decides before any of
// the route's own middleware (a rate limit, a body check) runs. HEAD runs the GET handlers, so the GET guard covers it.
//
// The guard decides, in this order (decideActing):
//   1. the request names no profile (no req.actingCandidate): it passes, as before;
//   2. a `self` route: it serves the signed-in person (req.acting = null); when the named key is not live the answer
//      carries X-TailorIT-Profile-State: ended (the web then returns the tab to the person's own profile);
//   3. the key is not live (unknown, someone else's, the owner's own, ended): 403 profile_ended, no name and no id;
//   4. a `never` route: 403 own_profile_only;
//   5. the grant lacks the route's permission (v33 INT-1: or, for an `anyOf` policy, every box of its list): 403
//      profile_not_shared;
//   6. the key came in the query form (?profile=) and the route does not take it (`query: true`): 400;
//   7. otherwise req.acting = the grant's ActingContext: userOf is the owner (role `user`), payerOf the grantee.
// A route with no policy is `never` (default deny). createApp logs how many there are at boot, and the coverage report
// (actingCoverageOf) lists every route with its policy and where it came from: apps/api/test/structure/
// structure-acting.test.ts compares it with a reviewed snapshot and fails on a table key that names no route, a nested
// router under a table (it needs one whole-mount value), and an undeclared route outside the features still pending.
//
// The guard decides again on every route a request reaches (a handler that calls next() to the next route gets that
// route's decision, never the previous one's); until a route decides, userOf and payerOf throw own_profile_only, so
// router-level code that reads the account fails closed.

/** The part of an Express 4 layer the guard reads and wraps. */
interface PolicyLayer {
  handle: ((...args: unknown[]) => unknown) & { stack?: PolicyLayer[] };
  route?: { path: unknown; stack: PolicyLayer[] };
  /** A route layer's method, lower case; undefined for `route.all` (every method). */
  method?: string;
  /** A `router.use(path, ...)` layer's path, as Express 4 compiled it. */
  regexp?: RegExp & { fast_slash?: boolean };
}

/** A rule expanded: the policy and whether the query form is taken. */
export interface ActingDecisionRule {
  policy: ActingPolicy;
  query: boolean;
}

/** A route with no policy: refused while acting. */
export const DEFAULT_ACTING_RULE: Readonly<ActingDecisionRule> = Object.freeze({ policy: 'never', query: false });

/** What the guard needs to count a request it let act on a shared profile (features/sharing/activity.ts). */
export type ActingTrackDeps = Parameters<typeof trackActingRequest>[0];

/** The responses already counted: a request that reaches a second acting route (next()) is counted once. */
const TRACKED = new WeakSet<Response>();

/**
 * The guard's decision for a request at a route with `rule` (the order in the comment at the top). Sets req.acting when
 * the request names a profile and the route serves it; answers the refusal to pass to next(), else null. With `deps`
 * (createApp's), a request let act is counted in the profile's activity (v33 INT-B: SHARE-2's trackActingRequest:
 * a read once an hour per area, every write, only when it succeeds).
 */
export function decideActing(req: Request, res: Response, rule: ActingDecisionRule, deps?: ActingTrackDeps): AppError | null {
  const candidate = req.actingCandidate;
  if (!candidate) return null;
  if (rule.policy === 'self') {
    req.acting = null;
    if (!candidate.grant) res.setHeader(PROFILE_STATE_HEADER, PROFILE_STATE_ENDED);
    return null;
  }
  // Undecided again until this route allows it: a previous route's decision never carries over.
  req.acting = undefined;
  if (!candidate.grant) return profileEnded();
  if (rule.policy === 'never') return ownProfileOnly();
  // v33 INT-1: the route's permission, or the first box of an `anyOf` list the grant holds.
  const perm = actingPermissionOf(rule.policy, candidate.grant.permissions);
  if (perm === null) return profileNotShared();
  if (candidate.via === 'query' && !rule.query) return badProfile();
  req.acting = actingContextOf(candidate.grant, perm);
  // v33 INT-B (SHARE-2's edit 1): what B does on A's profile is counted (profile_activity), once per request.
  if (deps && !TRACKED.has(res)) {
    TRACKED.add(res);
    trackActingRequest(deps, req, res);
  }
  return null;
}

/** The methods a coverage entry names: an HTTP method, or ALL for a `route.all` handler. */
export type ActingCoveredMethod = ActingMethod | 'ALL';

/** One route of the coverage report. */
export interface ActingRouteCoverage {
  /** The feature that mounts it (Feature.name). */
  feature: string;
  /** The mount's path (Feature.routes' `path`). */
  mount: string;
  method: ActingCoveredMethod;
  /** The full path: the mount's, then the route's ('/api/me' + '/tracker-lanes'). */
  path: string;
  policy: ActingPolicy;
  /** Whether the route takes the profile from ?profile= (GET and HEAD). */
  query: boolean;
  /** Where the policy came from: the mount's table, the mount's one value, or none (`never`, default deny). */
  source: 'route' | 'mount' | 'default';
  /** The route is in a router nested inside the mount's router. */
  nested: boolean;
}

/** What createApp mounted, and what the guard made of it. */
export interface ActingCoverage {
  routes: ActingRouteCoverage[];
  /** Table keys that name no route of their mount (a typo, or a route that moved). */
  unknownKeys: Array<{ feature: string; mount: string; key: string }>;
  /** Nested routers inside a mount that has a table: they need one whole-mount value. */
  nestedUnderTable: Array<{ feature: string; mount: string; path: string }>;
  /** Mounted handlers the guard could not walk (not an Express router): every request there that names a profile is
   *  refused (own_profile_only). */
  unwalkable: Array<{ feature: string; mount: string }>;
  /** Routes whose handler was already guarded: one router mounted twice keeps its first mount's policy. */
  alreadyGuarded: Array<{ feature: string; mount: string; path: string }>;
  /** Routers mounted before the session (Feature.earlyRoutes: MCP, OAuth): no profile is ever named there. */
  early: Array<{ feature: string; mount: string }>;
}

/** The mount a router is guarded for. */
export interface ActingMount {
  feature: string;
  path: string;
}

/** A route path as declared (a string; an array or a pattern is shown as written). */
function routePathOf(path: unknown): string {
  if (typeof path === 'string') return path;
  if (Array.isArray(path)) return path.map(routePathOf).join('|');
  return String(path);
}

/** A `router.use(path, nestedRouter)` layer's path, from the pattern Express 4 compiled ('/sheets'). */
function usePathOf(layer: PolicyLayer): string {
  const pattern = layer.regexp;
  if (!pattern || pattern.fast_slash) return '';
  return pattern.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
}

/** Each method of a route with its first handler that is not an error handler, in stack order ('_all' for all). */
function firstHandlers(stack: readonly PolicyLayer[]): Map<string, PolicyLayer> {
  const first = new Map<string, PolicyLayer>();
  for (const layer of stack) {
    const method = layer.method ?? '_all';
    if (first.has(method) || layer.handle.length > 3) continue;
    first.set(method, layer);
  }
  return first;
}

const GUARDED = Symbol('tailorit.actingGuard');

/** Wraps a route handler with the guard (arity 3 kept; the handler's own answer, a promise included, passes through). */
function guardLayer(layer: PolicyLayer, rule: ActingDecisionRule, deps: ActingTrackDeps | undefined): boolean {
  const handle = layer.handle as ((req: Request, res: Response, next: NextFunction) => unknown) & { [GUARDED]?: true };
  if (handle[GUARDED]) return false;
  const guarded = function actingGuard(req: Request, res: Response, next: NextFunction) {
    const refusal = decideActing(req, res, rule, deps);
    if (refusal) return next(refusal);
    return handle(req, res, next);
  };
  Object.defineProperty(guarded, GUARDED, { value: true });
  layer.handle = guarded as unknown as PolicyLayer['handle'];
  return true;
}

/** The coverage reports of the apps createApp built (the structure test reads it). */
const COVERAGE = new WeakMap<object, ActingCoverage>();

/** The coverage report of an app createApp built (undefined for anything else). */
export const actingCoverageOf = (app: object): ActingCoverage | undefined => COVERAGE.get(app);

/** createApp's helper: guards each feature router as it is mounted, then keeps the coverage report with the app. */
export class RoutePolicies {
  /** `deps`: createApp's, so the guard counts what a request does on a shared profile (v33 INT-B); none, nothing counted. */
  constructor(private readonly deps?: ActingTrackDeps) {}

  readonly coverage: ActingCoverage = {
    routes: [],
    unknownKeys: [],
    nestedUnderTable: [],
    unwalkable: [],
    alreadyGuarded: [],
    early: [],
  };

  /** An early router (mounted before the session): listed, never guarded. */
  early(mount: ActingMount): void {
    this.coverage.early.push({ feature: mount.feature, mount: mount.path });
  }

  /**
   * Guards every route of `router` (a feature's, about to be mounted at `mount.path`) by `spec`, and answers what to
   * mount: the router itself; a handler the guard cannot walk (not an Express router) comes back wrapped so that every
   * request there that names a profile is refused (own_profile_only), whatever `spec` says.
   */
  guard<T>(router: T, spec: ActingSpec | undefined, mount: ActingMount): T | RequestHandler {
    const stack = (router as { stack?: unknown } | null)?.stack;
    if (!Array.isArray(stack)) {
      this.coverage.unwalkable.push({ feature: mount.feature, mount: mount.path });
      if (typeof router !== 'function') return router;
      const handler = router as unknown as RequestHandler;
      return (req, res, next) => (req.actingCandidate ? next(ownProfileOnly()) : handler(req, res, next));
    }
    const table = spec !== undefined && isActingTable(spec) ? spec : null;
    const whole = spec !== undefined && !isActingTable(spec) ? actingRuleOf(spec) : null;
    // v33 INT-1: an `anyOf` names at least one box, every one a box.
    for (const rule of [...(whole ? [whole] : []), ...Object.values(table ?? {}).map(actingRuleOf)]) {
      if (typeof rule.policy === 'object' && (rule.policy.anyOf.length === 0 || !rule.policy.anyOf.every(isSharePermission))) {
        throw new Error(`The acting policy of ${mount.feature} at ${mount.path} lists no box, or something that is no box.`);
      }
    }
    const used = new Set<string>();
    const walk = (layers: readonly PolicyLayer[], prefix: string, nested: boolean) => {
      for (const layer of layers) {
        if (layer.route) {
          const path = prefix + routePathOf(layer.route.path);
          for (const [method, handler] of firstHandlers(layer.route.stack)) {
            const covered: ActingCoveredMethod = method === '_all' ? 'ALL' : (method.toUpperCase() as ActingMethod);
            const key = `${covered} ${path}`;
            let rule: ActingDecisionRule = DEFAULT_ACTING_RULE;
            let source: ActingRouteCoverage['source'] = 'default';
            if (table && !nested && covered !== 'ALL' && Object.prototype.hasOwnProperty.call(table, key)) {
              rule = actingRuleOf(table[key as keyof typeof table]!);
              source = 'route';
              used.add(key);
            } else if (whole) {
              rule = whole;
              source = 'mount';
            }
            if (!guardLayer(handler, rule, this.deps)) {
              this.coverage.alreadyGuarded.push({ feature: mount.feature, mount: mount.path, path: joinPath(mount.path, path) });
            }
            this.coverage.routes.push({
              feature: mount.feature,
              mount: mount.path,
              method: covered,
              path: joinPath(mount.path, path),
              policy: rule.policy,
              query: rule.query,
              source,
              nested,
            });
          }
        } else if (Array.isArray(layer.handle.stack)) {
          const inner = prefix + usePathOf(layer);
          if (table) this.coverage.nestedUnderTable.push({ feature: mount.feature, mount: mount.path, path: joinPath(mount.path, inner) });
          walk(layer.handle.stack, inner, true);
        }
      }
    };
    walk(stack as PolicyLayer[], '', false);
    for (const key of Object.keys(table ?? {})) {
      if (!used.has(key)) this.coverage.unknownKeys.push({ feature: mount.feature, mount: mount.path, key });
    }
    return router;
  }

  /** Keeps the report with `app` and logs, at boot, how many routes declare no policy (refused while acting). */
  finish(app: object, log: Logger): ActingCoverage {
    COVERAGE.set(app, this.coverage);
    // The count only: the report (actingCoverageOf, the structure test's snapshot) names them. A list of features or paths
    // here would put words into every test's log that its own "logs no word of the request" checks look for.
    const undeclared = this.coverage.routes.filter((route) => route.source === 'default').length;
    if (undeclared > 0) log.info(`[acting] ${undeclared} routes have no acting policy (default deny)`);
    for (const problem of this.coverage.unknownKeys) {
      log.warn(`[acting] ${problem.feature}'s acting table names no route of ${problem.mount}: ${problem.key}`);
    }
    for (const problem of this.coverage.unwalkable) {
      log.warn(`[acting] ${problem.feature}'s handler at ${problem.mount} is not a router: refused on any shared profile`);
    }
    for (const problem of this.coverage.alreadyGuarded) {
      log.warn(`[acting] ${problem.path} is mounted twice (${problem.feature}): it keeps its first mount's policy`);
    }
    for (const problem of this.coverage.nestedUnderTable) {
      log.warn(`[acting] ${problem.feature} nests a router at ${problem.path}: its mount needs one acting value, not a table`);
    }
    return this.coverage;
  }
}

/** '/api/me' + '/tracker-lanes'; a route '/' is the mount itself ('/api/me/'). */
function joinPath(mount: string, path: string): string {
  if (path === '') return mount;
  return `${mount.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}
