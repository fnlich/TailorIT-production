import type { AppDeps } from './context';
import type { DailyStep, Feature } from './feature';

// v30 ST0: the loops that run the Feature hooks of the bases (core/feature.ts): `aiTasks` (registered by setupServices
// after each feature's services hook), `daily` (the daily housekeeping: one pass after start, then every 24 hours)
// and `worker` (background work of the worker process; in the API process until wave 2 gives it its own). app.ts
// calls them; a feature only declares its hooks.

/** How often the daily housekeeping runs (a technical constant beside its code, as v2.0's HOUSEKEEPING_EVERY_MS). */
export const DAILY_EVERY_MS = 24 * 60 * 60_000;

/** Registers a feature's AI task kinds on the AI queue (nothing without one). Called right after its `services`. */
export function registerAiTasks(deps: AppDeps, feature: Feature): void {
  for (const task of feature.aiTasks ?? []) task.register(deps);
}

/** Every feature's daily steps, each named `<feature>.<step>`. Throws when two steps share a name. */
export function dailyStepsOf(features: readonly Feature[]): Array<{ name: string; step: DailyStep }> {
  const steps: Array<{ name: string; step: DailyStep }> = [];
  const names = new Set<string>();
  for (const feature of features) {
    for (const step of feature.daily ?? []) {
      const name = `${feature.name}.${step.name}`;
      if (names.has(name)) throw new Error(`Two daily steps are named "${name}".`);
      names.add(name);
      steps.push({ name, step });
    }
  }
  return steps;
}

export interface DailyResult {
  /** Rows each step changed, by `<feature>.<step>` (0 for a step that failed). */
  changed: Record<string, number>;
  /** The steps that threw (logged; the others still ran). */
  failed: string[];
}

/**
 * One pass of every daily step, in feature order, each on its own: a step that throws is logged and counted as failed,
 * and the next one runs. Logs one line with what changed (`[housekeeping] <step> <n>, ...`), none when nothing did.
 */
export async function runDaily(deps: AppDeps, features: readonly Feature[]): Promise<DailyResult> {
  const result: DailyResult = { changed: {}, failed: [] };
  for (const { name, step } of dailyStepsOf(features)) {
    try {
      result.changed[name] = await step.run(deps);
    } catch (error) {
      result.changed[name] = 0;
      result.failed.push(name);
      deps.log.error(`[housekeeping] ${name} failed; it runs again at the next pass`, error);
    }
  }
  const changed = Object.entries(result.changed).filter(([, count]) => count > 0);
  if (changed.length > 0) deps.log.info(`[housekeeping] ${changed.map(([name, count]) => `${name} ${count}`).join(', ')}`);
  return result;
}

/**
 * Starts the daily housekeeping: one pass now, then one every `everyMs`. Nothing (and no timer) when no feature has a
 * daily step. Answers the stop; a pass still running finishes on its own.
 */
export function startDaily(deps: AppDeps, features: readonly Feature[], everyMs = DAILY_EVERY_MS): () => void {
  if (dailyStepsOf(features).length === 0) return () => undefined;
  let running = false;
  const pass = () => {
    // A pass that outlasts the interval is never run twice at once.
    if (running) return;
    running = true;
    runDaily(deps, features)
      .catch((error: unknown) => deps.log.error('[housekeeping] the daily pass failed', error))
      .finally(() => {
        running = false;
      });
  };
  pass();
  const timer = setInterval(pass, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Starts every feature's worker hook, in feature order; answers one stop for them all (reverse order). */
export function startWorkers(deps: AppDeps, features: readonly Feature[]): () => Promise<void> {
  const stops: Array<() => void | Promise<void>> = [];
  for (const feature of features) {
    const stop = feature.worker?.(deps);
    if (typeof stop === 'function') stops.push(stop);
  }
  return async () => {
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch (error) {
        deps.log.error('[worker] a feature failed to stop cleanly', error);
      }
    }
  };
}
