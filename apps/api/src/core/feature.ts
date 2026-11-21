import type { Router } from 'express';
import type { SharePermission } from '@tailorit/shared/sharing'; // v33 SHARE-0
import type { AiTask } from '../ai/task';
import type { AppDeps } from './context';

/**
 * A feature registers everything it contributes through its own `features/<name>/index.ts`. The central list
 * (features/index.ts) and app.ts never change when a feature grows, so work packages own disjoint files.
 *
 * Order of use: `services` of every feature (list order) -> routers are built and mounted -> server listens ->
 * `start` of every feature (schedulers, workers). `stop` functions run on shutdown in reverse order.
 */
export interface Feature {
  name: string;
  /**
   * Create shared services and put them on `deps.services` (typed by module augmentation of AppServices). v3.0 D2: may
   * be async (setupServices awaits it), for a service that reads the database when it is made.
   */
  services?: (deps: AppDeps) => void | Promise<void>;
  /**
   * Routers to mount; several features may share a prefix (e.g. /api/admin/...). v33 SHARE-0: `acting`, what each route
   * does on a shared profile (ActingSpec below). Optional in the type; the strict structure test (structure-acting)
   * fails the build for any route without one.
   */
  routes?: Array<{ path: string; router: (deps: AppDeps) => Router; acting?: ActingSpec }>;
  // v1.5 M
  /**
   * Routers mounted before the app's cookie, bearer token, JSON body and Origin middleware (after helmet and the
   * request id): a route that authenticates and reads its body itself, and never by a session (the MCP endpoint).
   */
  earlyRoutes?: Array<{ path: string; router: (deps: AppDeps) => Router }>;
  // end v1.5 M
  /** Background work after listen. Return a stop function. v3.0 D2: may be async (startFeatures awaits it). */
  start?: (deps: AppDeps) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  /** Maintenance commands for `npm run <name>` / `tsx src/cli.ts <name> [...args]`. */
  commands?: Record<string, (deps: AppDeps, args: string[]) => Promise<void> | void>;
  // v30 ST0: the bases' hooks (core/feature-hooks.ts runs them; docs/DEVELOPMENT.md, "Feature layout").
  /**
   * The AI task kinds this feature runs (ai/task.ts defineAiTask): setupServices registers each on the AI queue right
   * after this feature's `services` hook (nothing when the server has no AI queue). Never call registerHandler.
   */
  aiTasks?: ReadonlyArray<AiTask<any, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /**
   * Steps of the daily housekeeping: run once after start, then every 24 hours, each on its own (one that throws is
   * logged and the others still run). A step answers how many rows it changed (logged when more than 0).
   */
  daily?: readonly DailyStep[];
  /**
   * Background work of the worker process (ingest's schedule, the enrichment queue: docs/design/part2/12-job-sourcing.md
   * §9.2). Until that process exists (wave 2, S1-API) startFeatures runs it in the API process. Return a stop function.
   */
  worker?: (deps: AppDeps) => void | (() => void | Promise<void>);
  // end v30 ST0
}

// v33 SHARE-0 (PLAN F9; SP v33 PLAN-sharing.md §4 "The route guard"): every mounted route declares what it does when the
// request names a shared profile (X-TailorIT-Profile, ?profile=). SHARE-1's guard reads it; a route with none counts as
// `never` and fails the structure test (a reviewed snapshot). Policies live in an `acting.ts` beside each router.
//
//   routes: [{ path: '/api/applications', router: createApplicationsRouter, acting: APPLICATIONS_ACTING }]
//   // features/applications/acting.ts
//   export const APPLICATIONS_ACTING: ActingTable = {
//     'GET /': 'tracker:view',
//     'PUT /:id/status': 'tracker:edit',
//     'GET /export.csv': { policy: 'exports', query: true },
//     'GET /lanes': 'self',
//   };
//   // a whole mount: acting: 'never'

/**
 * What a route does on a shared profile:
 * - `self`: it always serves the signed-in person (sign-in, the header, notifications, tracker lanes, sharing's reads);
 * - `never`: refused while acting (own_profile_only): account security, sharing's writes, admin, dev routes;
 * - a permission: allowed when the grant holds it (else profile_not_shared); userOf is the owner, payerOf the grantee.
 */
export type ActingPolicy = 'self' | 'never' | SharePermission | ActingAnyOf;

/**
 * v33 INT-1: allowed when the grant holds any one of these boxes (else profile_not_shared): for a mount that serves
 * several areas and checks each answer's own box itself (the AI tasks: getTaskFor reads a task only with its kind's box,
 * and answers any other as an unknown task). The request acts under the first box of the list the grant holds.
 */
export interface ActingAnyOf {
  readonly anyOf: readonly SharePermission[];
}

/** A policy with options: `query: true` also takes the profile from ?profile= (GET and HEAD only: browser-loaded URLs). */
export interface ActingRoutePolicy {
  policy: ActingPolicy;
  query?: true;
}

/** One route's rule: a policy, or a policy with options. */
export type ActingRule = ActingPolicy | ActingRoutePolicy;

/**
 * The routes of one mount, keyed `'<METHOD> <path>'` as the router declares them ('GET /', 'PUT /:id/status'); HEAD
 * follows GET. A key that names no route fails the structure test.
 */
export type ActingTable = { readonly [route: `${ActingMethod} /${string}`]: ActingRule };

/** A mount's `acting`: one rule for every route of the mount (a nested router needs this), or a table per route. */
export type ActingSpec = ActingRule | ActingTable;

/** The HTTP methods a table key may name. */
export const ACTING_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ActingMethod = (typeof ACTING_METHODS)[number];

/** Whether `spec` is a table per route (else one rule for the whole mount). */
export function isActingTable(spec: ActingSpec): spec is ActingTable {
  return typeof spec === 'object' && spec !== null && !('policy' in spec) && !('anyOf' in spec);
}

/** A rule's policy and options, the short form expanded. */
export function actingRuleOf(rule: ActingRule): { policy: ActingPolicy; query: boolean } {
  return typeof rule === 'string' || 'anyOf' in rule ? { policy: rule, query: false } : { policy: rule.policy, query: rule.query === true };
}

/**
 * v33 INT-1: the box a grant holding `permissions` acts under at a route whose policy is a permission or an `anyOf`: the
 * permission itself, or the first of the list the grant holds; null when it holds none (profile_not_shared).
 */
export function actingPermissionOf(policy: SharePermission | ActingAnyOf, permissions: readonly SharePermission[]): SharePermission | null {
  if (typeof policy === 'string') return permissions.includes(policy) ? policy : null;
  return policy.anyOf.find((perm) => permissions.includes(perm)) ?? null;
}

/** v33 INT-1: a policy as the coverage report and its snapshot print it (`any of a|b` for an anyOf). */
export const actingPolicyLabel = (policy: ActingPolicy): string => (typeof policy === 'string' ? policy : `any of ${policy.anyOf.join('|')}`);
// end v33 SHARE-0

// v30 ST0
/** One step of the daily housekeeping (Feature.daily). */
export interface DailyStep {
  /** Unique within its feature; the log and the result name it `<feature>.<name>`. */
  name: string;
  /** One pass: answers how many rows it changed. */
  run: (deps: AppDeps) => number | Promise<number>;
}
// end v30 ST0
