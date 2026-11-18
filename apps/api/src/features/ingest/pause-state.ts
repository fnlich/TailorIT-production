import type { RunsPaused } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { IngestError, type RunTrigger } from './types';

// v31 RUNS: what a pause is, as every process reads it from the database (docs/design/v3.1/22-runs-pause.md). The admin
// actions are pause.ts; this file imports nothing of the service, so the service, the scheduler and the other workers
// (discovery, the review re-checks, the enrichment queue) read it without a cycle.
//
// Three scopes, all in the database, so a pause asked in the API reaches a run in the ingest worker:
//   - every run: app_settings' key RUNS_PAUSED_KEY ({"at": ISO, "by": <users.id>}, updated_by the admin), present only
//     while runs are paused;
//   - one source: job_sources.paused_at, paused_by;
//   - one run: job_source_runs.stop_requested_at (a pause of every run, or of a source, sets it on their running runs).
// A process stops its own runs that are asked to (service.ts checkStops, every RUN_STOP_POLL_MS); a run started by the
// schedule or Run now also stops while its source or every run is paused (it may have started while the pause was
// being written).

/** app_settings' key while every run is paused. */
export const RUNS_PAUSED_KEY = 'ingest:paused';

/**
 * The triggers a pause holds back at their start: the worker's schedule, and Run now (Continue on a run is one). An
 * upload (a file an admin imports, or a Google Sheet's copy) and the dev seed at start read no outside host and still
 * start; a pause asked while they run stops them too.
 */
export const PAUSABLE_TRIGGERS: readonly RunTrigger[] = ['schedule', 'manual'];

/** SQL: every run is paused now (an uncorrelated look, read once per statement). */
export const RUNS_PAUSED_SQL = `EXISTS (SELECT 1 FROM app_settings WHERE key = '${RUNS_PAUSED_KEY}')`;

/** v31 RUNS: why a run stopped before it finished: an admin paused it. It ends `paused`, not failed. */
export class RunPausedError extends IngestError {
  constructor() {
    super('An admin paused this run.');
    this.name = 'RunPausedError';
  }
}

/** Whether `signal` was aborted by a pause (rather than a lost lease or a shutdown). */
export function pausedBy(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof RunPausedError;
}

/** app_settings' JSON value (json columns may come back as text). */
function valueOf(value: unknown): { at?: unknown } {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as { at?: unknown };
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as { at?: unknown }) : {};
}

/** Every run is paused: since when, and by whom (the admin's email; null once that account is gone); or null. */
export async function runsPausedState(db: DbQueries): Promise<RunsPaused | null> {
  const row = await db.one<{ value: unknown; updated_at: string | null; email: string | null }>(
    'SELECT a.value, a.updated_at, u.email FROM app_settings a LEFT JOIN users u ON u.id = a.updated_by WHERE a.key = ?',
    [RUNS_PAUSED_KEY],
  );
  if (!row) return null;
  const at = valueOf(row.value).at;
  const when = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : row.updated_at;
  return { at: when ?? new Date(0).toISOString(), by: row.email ?? null };
}

/** Whether every run is paused now (the worker's outside work waits while it is). */
export async function runsPaused(deps: Pick<AppDeps, 'db'>): Promise<boolean> {
  return Boolean(await deps.db.one<{ found: number }>(`SELECT 1 AS found WHERE ${RUNS_PAUSED_SQL}`));
}

/**
 * A signal for one pass of the worker's outside work (discovery's validation, Common Crawl): aborted when `parent` is
 * (the worker stops), or once an admin pauses every run (looked every RUN_STOP_POLL_MS while the pass goes on). `done`
 * ends the looks.
 */
export function pauseAwareSignal(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  parent: AbortSignal,
  everyMs: number,
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onParent = () => controller.abort(parent.reason);
  if (parent.aborted) onParent();
  else parent.addEventListener('abort', onParent, { once: true });
  const timer = setInterval(() => {
    runsPaused(deps)
      .then((paused) => {
        if (paused && !controller.signal.aborted) controller.abort(new RunPausedError());
      })
      .catch(() => undefined);
  }, Math.max(100, everyMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    done: () => {
      clearInterval(timer);
      parent.removeEventListener('abort', onParent);
    },
  };
}
