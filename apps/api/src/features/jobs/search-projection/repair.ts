import type { AppDeps } from '../../../core/context';
import type { DailyStep } from '../../../core/feature';
import { projectJobs, searchableSql, SEARCH_PROJECTION_VERSION } from './project';

// v3.0 PG-SEARCH (11-database.md §5.6, §7.7): the nightly repair of the search projection, both ways. Every writer
// calls projectJob in its change's transaction and migration 0004's trigger removes a closed, unverified or held job
// at once; this pass catches what slipped past them:
//   1. a row whose job is gone or no longer searchable is deleted;
//   2. a searchable job without a row gets one;
//   3. a row older than a change of its job (jobs.updated_at), its company (companies.updated_at), its text
//      (job_texts.updated_at) or its facts (job_facts.computed_at), or written by an older projection
//      (SEARCH_PROJECTION_VERSION), is written again.
// It walks in batches of REPAIR_BATCH jobs, each batch its own short transaction, so it never holds a lock for long.
// `{ all: true }` writes every searchable job's row again (`node scripts/run-api-script.mjs search:repair --all`,
// after a change to the projection that its version does not mark).

/** Jobs one transaction of the repair reads and writes. */
export const REPAIR_BATCH = 500;

export interface RepairCounts {
  /** Rows deleted: their job is gone, closed, unverified or held. */
  removed: number;
  /** Rows written: missing, stale or of an older projection (all of them with `all`). */
  written: number;
}

type RepairDeps = Pick<AppDeps, 'db'>;

/** The searchable jobs after `after` (by id) whose row is missing or stale, at most `limit`. */
const STALE_SQL = `SELECT j.id FROM jobs j
  JOIN companies c ON c.id = j.company_id
  LEFT JOIN company_profiles cp ON cp.company_id = j.company_id
  LEFT JOIN job_search s ON s.job_id = j.id
  LEFT JOIN job_texts jt ON jt.job_id = j.id
  LEFT JOIN job_facts f ON f.job_id = j.id
  WHERE ${searchableSql('j')} AND j.id > @after
    AND (@all OR s.job_id IS NULL OR s.facts_version < @version OR s.refreshed_at < j.updated_at
      OR s.refreshed_at < c.updated_at OR s.refreshed_at < cp.updated_at OR s.refreshed_at < jt.updated_at OR s.refreshed_at < f.computed_at)
  ORDER BY j.id
  LIMIT @limit`;

/** Rows whose job is gone or not searchable, at most `limit`. */
const GONE_SQL = `SELECT s.job_id AS id FROM job_search s LEFT JOIN jobs j ON j.id = s.job_id
  WHERE j.id IS NULL OR NOT ${searchableSql('j')}
  LIMIT @limit`;

/** One pass of the repair (see the module's note). */
export async function repairSearch(deps: RepairDeps, options: { all?: boolean; batch?: number } = {}): Promise<RepairCounts> {
  const batch = Math.max(1, options.batch ?? REPAIR_BATCH);
  const counts: RepairCounts = { removed: 0, written: 0 };
  for (;;) {
    const gone = (await deps.db.all<{ id: number }>(GONE_SQL, { limit: batch })).map((row) => row.id);
    if (gone.length === 0) break;
    // projectJobs deletes the row of a job that is not searchable, or gone.
    await deps.db.tx((t) => projectJobs(t, gone), { label: 'search repair: gone' });
    counts.removed += gone.length;
    if (gone.length < batch) break;
  }
  let after = 0;
  for (;;) {
    const ids = (
      await deps.db.all<{ id: number }>(STALE_SQL, { after, all: options.all === true, version: SEARCH_PROJECTION_VERSION, limit: batch })
    ).map((row) => row.id);
    if (ids.length === 0) break;
    counts.written += await deps.db.tx((t) => projectJobs(t, ids), { label: 'search repair: stale' });
    after = ids[ids.length - 1]!;
    if (ids.length < batch) break;
  }
  return counts;
}

/** The jobs feature's daily step: one repair pass; answers the rows it changed. */
export const searchRepairStep: DailyStep = {
  name: 'search-repair',
  run: async (deps) => {
    const counts = await repairSearch(deps);
    return counts.removed + counts.written;
  },
};

/** The `search:repair [--all]` command: one repair pass now (every row with --all), and what it changed. */
export async function searchRepairCommand(deps: Pick<AppDeps, 'db' | 'log'>, args: string[]): Promise<void> {
  const counts = await repairSearch(deps, { all: args.includes('--all') });
  deps.log.info(`[search] repair: ${counts.written} row(s) written, ${counts.removed} removed`);
}
