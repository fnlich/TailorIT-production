import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';

// v30 FIX-A (REV-BEH BEH-6, REV-REQ REQ-6; 11-database.md §8.2 "JOB_SOURCE_RUN_KEEP_DAYS 90, batched delete"): the
// run history's retention. The daily housekeeping deletes the runs that started more than JOB_SOURCE_RUN_KEEP_DAYS ago,
// RUN_HISTORY_BATCH at a time through idx_job_source_runs_age (each batch its own statement, so no long lock), and keeps
// each source's newest run whatever its age (a source run once a month still shows its last run). Nothing else
// touches old runs: the worker's tick no longer trims their logs (that scan walked the whole table every 15 seconds).
//
// v35 FIX-STORE (the final review's D12): imports (job_imports, an admin's or a person's, with each row's link and
// fields in job_import_rows: up to SHEET_MAX_ROWS descriptions an import) are run history too. The same step first
// deletes the imports that finished more than JOB_SOURCE_RUN_KEEP_DAYS ago, with their rows, IMPORT_HISTORY_BATCH at a
// time (an import still reading is never deleted); then a run an import still kept names is kept with it (its results
// are opened by the run: GET /api/admin/imports/:runId, Runs, Review's "one import").

/** Runs one statement deletes. */
export const RUN_HISTORY_BATCH = 10_000;
/** v35 FIX-STORE (D12): imports one statement deletes (each with its rows). */
export const IMPORT_HISTORY_BATCH = 20;

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The start of the kept history: JOB_SOURCE_RUN_KEEP_DAYS ago. */
function cutoffOf(deps: Deps): { keepDays: number; cutoff: string } {
  const keepDays = constantsOf(deps).get('JOB_SOURCE_RUN_KEEP_DAYS');
  return { keepDays, cutoff: new Date(deps.now().getTime() - keepDays * 86_400_000).toISOString() };
}

/** v35 FIX-STORE (D12): deletes the imports finished before JOB_SOURCE_RUN_KEEP_DAYS ago, with their rows; answers how many. */
export async function pruneImportHistory(deps: Deps, batch = IMPORT_HISTORY_BATCH): Promise<number> {
  const { keepDays, cutoff } = cutoffOf(deps);
  let deleted = 0;
  for (;;) {
    const gone = (
      await deps.db.run(
        `DELETE FROM job_imports WHERE id IN (
           SELECT id FROM job_imports WHERE finished_at IS NOT NULL AND finished_at < CAST(@cutoff AS timestamptz) ORDER BY id LIMIT @batch)`,
        { cutoff, batch },
      )
    ).changes;
    deleted += gone;
    if (gone < batch) break;
  }
  if (deleted > 0) deps.log.info(`[ingest] run history: ${deleted} import(s) finished more than ${keepDays} days ago deleted`);
  return deleted;
}

/** Deletes the runs past JOB_SOURCE_RUN_KEEP_DAYS (see the top); answers how many went. */
export async function pruneRunHistory(deps: Deps, batch = RUN_HISTORY_BATCH): Promise<number> {
  const { keepDays, cutoff } = cutoffOf(deps);
  let deleted = 0;
  for (;;) {
    const gone = (
      await deps.db.run(
        `DELETE FROM job_source_runs WHERE id IN (
           SELECT r.id FROM job_source_runs r
           WHERE r.started_at < CAST(@cutoff AS timestamptz) AND r.status <> 'running'
             AND EXISTS (SELECT 1 FROM job_source_runs n WHERE n.source_id = r.source_id AND n.started_at > r.started_at)
             AND NOT EXISTS (SELECT 1 FROM job_imports i WHERE i.run_id = r.id)
           ORDER BY r.started_at LIMIT @batch)`,
        { cutoff, batch },
      )
    ).changes;
    deleted += gone;
    if (gone < batch) break;
  }
  if (deleted > 0) deps.log.info(`[ingest] run history: ${deleted} run(s) older than ${keepDays} days deleted`);
  return deleted;
}

/** The daily housekeeping's step (Feature.daily): `ingest.run_history`. v35 FIX-STORE: the old imports first. */
export const runHistoryDailyStep: DailyStep = {
  name: 'run_history',
  run: async (deps) => (await pruneImportHistory(deps)) + (await pruneRunHistory(deps)),
};
