import type { Router } from 'express';
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
  /** Routers to mount; several features may share a prefix (e.g. /api/admin/...). */
  routes?: Array<{ path: string; router: (deps: AppDeps) => Router }>;
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

// v30 ST0
/** One step of the daily housekeeping (Feature.daily). */
export interface DailyStep {
  /** Unique within its feature; the log and the result name it `<feature>.<name>`. */
  name: string;
  /** One pass: answers how many rows it changed. */
  run: (deps: AppDeps) => number | Promise<number>;
}
// end v30 ST0
