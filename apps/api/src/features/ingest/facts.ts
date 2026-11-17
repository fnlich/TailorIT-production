import type { AppDeps } from '../../core/context';
import type { DbClient } from '../../core/db/types';
import type { DailyStep } from '../../core/feature';
import { ensureJobFacts, JOB_FACTS_CHUNK, JOB_FACTS_VERSION, storeFactsIn } from '../job-facts/service';

// v3.0 DB-INGEST (11-database.md §5.5a, §9.2 step 1b; 12-job-sourcing.md §9.7): job facts for every open job, without
// AI. What the search filters read (job_search copies them) is built at ingest from the source's own fields, the ingest
// columns, the deterministic analysis and the eligibility rules (job-facts/service.ts, Part 1's buildJobFacts): no job
// waits for a person to save it or for Claude to read it before its filters work. Two ways in:
// - at ingest: the jobs a batch created or changed get their facts in the batch's transaction, before the batch's one
//   projection (store.ts upsertBatch); an unchanged posting costs nothing (its facts are current);
// - the backfill sweep (a daily step of the job-facts feature): the open jobs whose facts are missing or older than
//   JOB_FACTS_VERSION, oldest id first, FACTS_BACKFILL_MAX a pass, each chunk in its own transaction with its
//   projection (ensureJobFacts). A fresh install has nothing to fill; a facts version bump refills every open job over
//   a few passes.

/** Open jobs the backfill sweep computes in one pass (about 1-2 ms a job: 50,000 is a minute or two). */
export const FACTS_BACKFILL_MAX = 50_000;

/** The open jobs among `jobIds` get current facts, in the caller's transaction (no projection: the caller projects). */
export async function factsAtIngest(db: DbClient, jobIds: readonly number[], at: string): Promise<number[]> {
  return storeFactsIn(db, jobIds, at);
}

/** Open jobs after `afterId` whose facts are missing or stale by version, in id order. */
async function lacking(db: DbClient, afterId: number, limit: number): Promise<number[]> {
  const rows = await db.all<{ id: number }>(
    `SELECT j.id FROM jobs j
      WHERE j.active AND j.id > ?
        AND NOT EXISTS (SELECT 1 FROM job_facts f WHERE f.job_id = j.id AND f.facts_version >= ?)
      ORDER BY j.id LIMIT ?`,
    [afterId, JOB_FACTS_VERSION, limit],
  );
  return rows.map((row) => row.id);
}

/**
 * One pass of the backfill: up to `max` open jobs that lack current facts get them (each chunk in its own transaction,
 * projected). Answers how many it computed. Outside any transaction.
 */
export async function backfillFacts(deps: Pick<AppDeps, 'db' | 'now'>, max = FACTS_BACKFILL_MAX): Promise<number> {
  let afterId = 0;
  let seen = 0;
  let computed = 0;
  while (seen < max) {
    const ids = await lacking(deps.db, afterId, Math.min(JOB_FACTS_CHUNK, max - seen));
    if (ids.length === 0) break;
    computed += await ensureJobFacts(deps, ids);
    seen += ids.length;
    afterId = ids[ids.length - 1]!;
  }
  return computed;
}

/** The daily step (job-facts' Feature.daily): `job-facts.backfill`. */
export const factsBackfillStep: DailyStep = { name: 'backfill', run: (deps) => backfillFacts(deps) };
