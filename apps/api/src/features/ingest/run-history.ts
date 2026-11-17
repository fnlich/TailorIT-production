import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';

// v30 FIX-A (REV-BEH BEH-6, REV-REQ REQ-6; 11-database.md §8.2 "JOB_SOURCE_RUN_KEEP_DAYS 90, batched delete"): the
// run history's retention. The daily housekeeping deletes the runs that started more than JOB_SOURCE_RUN_KEEP_DAYS ago,
// RUN_HISTORY_BATCH at a time through idx_job_source_runs_age (each batch its own statement, so no long lock), and keeps
// each source's newest run whatever its age (a source run once a month still shows its last run). Nothing else
// touches old runs: the worker's tick no longer trims their logs (that scan walked the whole table every 15 seconds).

/** Runs one statement deletes. */
export const RUN_HISTORY_BATCH = 10_000;

/** Deletes the runs past JOB_SOURCE_RUN_KEEP_DAYS (see the top); answers how many went. */
export async function pruneRunHistory(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, batch = RUN_HISTORY_BATCH): Promise<number> {
  const keepDays = constantsOf(deps).get('JOB_SOURCE_RUN_KEEP_DAYS');
  const cutoff = new Date(deps.now().getTime() - keepDays * 86_400_000).toISOString();
  let deleted = 0;
  for (;;) {
    const gone = (
      await deps.db.run(
        `DELETE FROM job_source_runs WHERE id IN (
           SELECT r.id FROM job_source_runs r
           WHERE r.started_at < CAST(@cutoff AS timestamptz) AND r.status <> 'running'
             AND EXISTS (SELECT 1 FROM job_source_runs n WHERE n.source_id = r.source_id AND n.started_at > r.started_at)
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

/** The daily housekeeping's step (Feature.daily): `ingest.run_history`. */
export const runHistoryDailyStep: DailyStep = { name: 'run_history', run: (deps) => pruneRunHistory(deps) };
