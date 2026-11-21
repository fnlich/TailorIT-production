import express, { Router, type Express, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { attachActing } from './core/auth/acting'; // v33 SHARE-1
import { attachBearer, CONNECT_REDEEM_PATH, tokenScope } from './core/auth/extension-tokens';
import { RoutePolicies } from './core/auth/route-policy'; // v33 SHARE-1
import { attachUser } from './core/auth/session';
import { grantAdminsPaidOnce } from './core/accounts/admin-grant';
import { constantsOf, loadConstants } from './core/constants/index';
import type { AppDeps } from './core/context';
import type { Feature } from './core/feature';
import { registerAiTasks, startDaily, startWorkers } from './core/feature-hooks';
import { errorHandler, notFoundHandler } from './core/http/errors';
import { noStore, originCheck, requestId } from './core/http/middleware';
import { FEATURES } from './features/index';

/**
 * Creates the core services, then every feature's services on `deps.services`, in list order. v2.0: the constants
 * service (deps.services.constants) comes first, so every feature reads the resolved constants. v3.0 D2: async, as the
 * constants' stored overrides are read through deps.db (and a feature's `services` hook may be async).
 */
export async function setupServices(deps: AppDeps, features: Feature[] = FEATURES): Promise<void> {
  await loadConstants(deps);
  for (const feature of features) {
    await feature.services?.(deps);
    // v30 ST0: the feature's AI task kinds (Feature.aiTasks), registered on the AI queue its services may have made.
    registerAiTasks(deps, feature);
  }
}

// v3.0 D2: async route handlers everywhere.
/** The part of an Express layer this needs (Express 4 keeps its Layer type private). */
interface RouteLayer {
  handle: ((...args: unknown[]) => unknown) & { stack?: RouteLayer[] };
  route?: { stack: RouteLayer[] };
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

/**
 * v3.0 D2: Express 4 ignores the promise a handler returns, so an async handler (or middleware) that rejects would
 * leave its request hanging. Walks every layer the app mounted (routers inside routers, each route's handlers) and
 * wraps each handler so its rejection goes to next(error), and so to errorHandler. Arity is kept: Express tells an
 * error handler (4 arguments) from the others by it. A handler made with asyncHandler is wrapped too, harmlessly.
 */
export function routeRejectionsToNext(stack: RouteLayer[]): void {
  for (const layer of stack) {
    if (layer.route) {
      routeRejectionsToNext(layer.route.stack);
    } else if (Array.isArray(layer.handle.stack)) {
      routeRejectionsToNext(layer.handle.stack);
    } else {
      const handler = layer.handle;
      layer.handle = (
        handler.length === 4
          ? function (error: unknown, req: unknown, res: unknown, next: NextFunction) {
              const result = handler(error, req, res, next);
              if (isThenable(result)) result.then(undefined, next);
            }
          : function (req: unknown, res: unknown, next: NextFunction) {
              const result = handler(req, res, next);
              if (isThenable(result)) result.then(undefined, next);
            }
      ) as RouteLayer['handle'];
    }
  }
}
// end v3.0 D2

/** Builds the Express app. The browser reaches it only through Next's /api rewrite (same origin). */
export function createApp(deps: AppDeps, features: Feature[] = FEATURES): Express {
  const app = express();
  app.disable('x-powered-by');
  // Next's rewrite proxy runs on the same machine; trust its X-Forwarded-* so req.secure/req.ip are right.
  app.set('trust proxy', 'loopback');
  // Every answer is no-store (noStore below), so an ETag only repeats the body's hash: none, a password's least of all.
  app.set('etag', false);
  // Content-Security-Policy is set per response by the routes that return HTML (previews); JSON needs none.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } }));
  app.use(requestId);
  // v33 SHARE-1: every feature route is guarded for shared profiles as it is mounted (core/auth/route-policy.ts).
  const policies = new RoutePolicies(deps); // v33 INT-B: deps, so the guard counts the shared profiles' activity
  // v1.5 M: routes that read no cookie and no body parser's body (the MCP endpoint at /mcp, features/mcp): before the
  // cookie, the extension's bearer, the JSON body and the Origin check, none of which applies to them.
  for (const feature of features) {
    for (const route of feature.earlyRoutes ?? []) {
      policies.early({ feature: feature.name, path: route.path }); // v33 SHARE-1: no session there, so no profile named
      app.use(route.path, route.router(deps));
    }
  }
  // end v1.5 M
  app.use('/api', noStore);
  app.use(cookieParser());
  // An extension token (Authorization: Bearer tia_...) identifies its request on its own: the session cookie is never
  // read for it, the Origin check does not apply (no page can make a browser attach it), and it reaches only the
  // routes tokenScope lists, with the version header tokenScope checks. attachBearer comes before the body parser, so
  // a body that parser refuses is answered with the version header too. See core/auth/extension-tokens.ts.
  app.use(attachBearer(deps));
  app.use(express.json({ limit: '5mb' }));
  app.use(originCheck(deps.config.appOrigin, { cookieFree: [CONNECT_REDEEM_PATH] }));
  app.use(attachUser(deps));
  app.use(tokenScope);
  // v33 SHARE-1 (PLAN F9 "Acting"): which shared profile the request names (X-TailorIT-Profile, or ?profile= on GET and
  // HEAD), and its grant, read again on every request; each route's guard then decides (core/auth/route-policy.ts).
  app.use(attachActing(deps));

  // v33 SHARE-1: the health check is a router of its own, so the guard covers it too (`self`: no one's data).
  const health = Router();
  health.get('/', (_req, res) => {
    res.json({ ok: true, service: 'tailorit-api', time: deps.now().toISOString() });
  });
  app.use('/api/health', policies.guard(health, 'self', { feature: 'core', path: '/api/health' }));

  for (const feature of features) {
    for (const route of feature.routes ?? []) {
      // v33 SHARE-1: the guard wraps the first handler of each method of each route, by the mount's `acting`.
      app.use(route.path, policies.guard(route.router(deps), route.acting, { feature: feature.name, path: route.path }));
    }
  }
  policies.finish(app, deps.log); // v33 SHARE-1: the coverage report (actingCoverageOf) and the boot log line

  app.use('/api', notFoundHandler);
  app.use(errorHandler(deps.log));
  // v3.0 D2: a rejected async handler reaches errorHandler (Express 4 alone would leave the request open).
  routeRejectionsToNext((app as unknown as { _router: { stack: RouteLayer[] } })._router.stack);
  return app;
}

/**
 * Starts the core's work (v2.0: the constants' reload, and the admins' one-time Paid grant of the update), then every
 * feature's; returns one function that stops it all (reverse order). v30 ST0: then the daily housekeeping
 * (Feature.daily) and, unless `workers` is false (the worker process of wave 2 runs them itself), the worker hooks.
 * v3.0 D2: async (the admin grant writes through deps.db).
 */
export async function startFeatures(
  deps: AppDeps,
  features: Feature[] = FEATURES,
  options: { workers?: boolean } = {},
): Promise<() => Promise<void>> {
  const stops: Array<() => void | Promise<void>> = [constantsOf(deps).start()];
  try {
    await grantAdminsPaidOnce(deps);
  } catch (error) {
    deps.log.error('[accounts] the v2.0 admin grant failed; it runs again at the next start', error);
  }
  for (const feature of features) {
    const stop = await feature.start?.(deps);
    if (typeof stop === 'function') stops.push(stop);
  }
  // v30 ST0
  stops.push(startDaily(deps, features));
  if (options.workers !== false) stops.push(startWorkers(deps, features));
  // end v30 ST0
  return async () => {
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch (error) {
        deps.log.error('[api] a feature failed to stop cleanly', error);
      }
    }
  };
}
