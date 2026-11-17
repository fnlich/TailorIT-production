import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import type { DailyStep } from '../../core/feature';

// v30 E0-API: company_job_counts (11-database.md §5.4): each company's open and closed lake jobs and its newest open
// posting, for the admin's list and "most hiring" lists. Recounted for the companies a change touched (a merge, a
// split, an opt-out) and nightly for all, in batches of company ids. Open means open and not held for review; an
// account's own page jobs are not counted.
//
// v30 FIX-C (W5 review UX-1): and a few seconds after any change of a job that moves its company's counts (a run's new
// postings, a close, a reopen, a hold cleared): migration 0033's trigger on jobs appends the company to
// company_count_touches, and the companies worker drains that list every COUNT_DRAIN_TICK_MS (drainCompanyCountTouches).

/** Companies per transaction of the nightly recount's writes. */
const RECOUNT_BATCH = 5_000;

// v30 FIX-PERF (PG-LOAD PGL-16): jobs has no index on company_id over every row (only idx_jobs_company_open WHERE
// active and idx_jobs_company_closed WHERE NOT active), so a count of a set of companies' jobs joined jobs whole: the
// nightly recount read the table once per 5,000 companies (20 times a night at mix B's base size, 60 GB), and the
// drain every few seconds. Now a few companies (the drain's, a merge's, a split's, an opt-out's) are counted each on
// its two partial indexes, and every company (the nightly step) by one GROUP BY pass over jobs.

/** Recounts the given companies' jobs, in the caller's transaction; answers how many rows it wrote. */
export async function recountCompanyJobs(t: DbQueries, companyIds: readonly number[], at: string): Promise<number> {
  const ids = [...new Set(companyIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return 0;
  // In id order: two recounts of overlapping companies take their rows' locks in one order.
  const done = await t.run(
    `INSERT INTO company_job_counts(company_id, open_jobs, closed_jobs, last_posted_at, counted_at)
     SELECT c.id, o.open_jobs, cl.closed_jobs, o.last_posted_at, CAST(? AS timestamptz)
     FROM companies c
     CROSS JOIN LATERAL (SELECT count(*)::int AS open_jobs, max(j.posted_sort) AS last_posted_at FROM jobs j
                         WHERE j.company_id = c.id AND j.active AND j.held_since IS NULL AND j.owner_user_id IS NULL) o
     CROSS JOIN LATERAL (SELECT count(*)::int AS closed_jobs FROM jobs j
                         WHERE j.company_id = c.id AND NOT j.active AND j.owner_user_id IS NULL) cl
     WHERE c.id IN (${t.dialect.list(ids.length)})
     ORDER BY c.id
     ON CONFLICT (company_id) DO UPDATE SET open_jobs = excluded.open_jobs, closed_jobs = excluded.closed_jobs,
       last_posted_at = excluded.last_posted_at, counted_at = excluded.counted_at`,
    [at, ...ids],
  );
  return done.changes;
}

/** How often the worker drains company_count_touches. */
export const COUNT_DRAIN_TICK_MS = 15_000;
/** Touches one transaction of the drain takes (the companies among them are recounted in it). */
const DRAIN_BATCH = 5_000;

/**
 * v30 FIX-C UX-1: recounts the companies company_count_touches names, oldest touches first, DRAIN_BATCH touches per
 * transaction (taken FOR UPDATE SKIP LOCKED: two drains never take one touch), until the list is empty or `maxRounds`
 * transactions ran. Answers the companies recounted.
 */
export async function drainCompanyCountTouches(deps: Pick<AppDeps, 'db' | 'now'>, maxRounds = 20): Promise<number> {
  let recounted = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const companies = await deps.db.tx(
      async (t) => {
        const touched = await t.all<{ company_id: number }>(
          `DELETE FROM company_count_touches WHERE id IN (
             SELECT id FROM company_count_touches ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
           RETURNING company_id`,
          [DRAIN_BATCH],
        );
        // In id order: two recounts of overlapping companies take their rows' locks in one order.
        const ids = [...new Set(touched.map((row) => Number(row.company_id)))].sort((a, b) => a - b);
        if (ids.length > 0) await recountCompanyJobs(t, ids, deps.now().toISOString());
        return ids.length;
      },
      { label: 'company count touches' },
    );
    if (companies === 0) return recounted;
    recounted += companies;
  }
  return recounted;
}

/** Starts the drain in this process (the companies worker hook); answers the stop. */
export function startCompanyCountDrain(deps: Pick<AppDeps, 'db' | 'now' | 'log'>, everyMs = COUNT_DRAIN_TICK_MS): () => Promise<void> {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = drainCompanyCountTouches(deps)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!stopped) deps.log.warn('[companies] could not recount the companies whose jobs changed; the next pass tries again', error);
      })
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

/** One company's counts as the nightly pass read them. */
interface CountRow {
  company_id: number;
  open_jobs: number;
  closed_jobs: number;
  /** As PostgreSQL writes it (its text, every digit kept), so the count's time is the job's to the microsecond. */
  last_posted_at: string | null;
}

/**
 * The nightly recount of every shared company: one pass over jobs counts every company's jobs (a GROUP BY: the planner
 * reads the table once), then the counts are written a batch of RECOUNT_BATCH company ids per transaction (a company
 * with no job left gets zeros). A row a drain or a merge counted after the pass began (counted_at later than its
 * start) is newer than the pass's read and is kept.
 */
export async function recountAllCompanyJobs(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  const at = deps.now().toISOString();
  const counted = new Map<number, CountRow>();
  for (const row of await deps.db.all<CountRow>(
    `SELECT j.company_id,
       count(*) FILTER (WHERE j.active AND j.held_since IS NULL)::int AS open_jobs,
       count(*) FILTER (WHERE NOT j.active)::int AS closed_jobs,
       CAST(max(j.posted_sort) FILTER (WHERE j.active AND j.held_since IS NULL) AS text) AS last_posted_at
     FROM jobs j WHERE j.owner_user_id IS NULL GROUP BY j.company_id`,
  )) {
    counted.set(Number(row.company_id), row);
  }
  let after = 0;
  let written = 0;
  for (;;) {
    const ids = (
      await deps.db.all<{ id: number }>('SELECT id FROM companies WHERE id > ? AND owner_user_id IS NULL ORDER BY id LIMIT ?', [after, RECOUNT_BATCH])
    ).map((row) => row.id);
    if (ids.length === 0) return written;
    const rows = ids.map((id) => counted.get(id) ?? { company_id: id, open_jobs: 0, closed_jobs: 0, last_posted_at: null });
    written += (
      await deps.db.run(
        `INSERT INTO company_job_counts(company_id, open_jobs, closed_jobs, last_posted_at, counted_at)
         SELECT x.company_id, x.open_jobs, x.closed_jobs, x.last_posted_at, CAST(? AS timestamptz)
         FROM json_to_recordset(CAST(? AS json)) AS x(company_id bigint, open_jobs integer, closed_jobs integer, last_posted_at timestamptz)
         JOIN companies c ON c.id = x.company_id
         ORDER BY x.company_id
         ON CONFLICT (company_id) DO UPDATE SET open_jobs = excluded.open_jobs, closed_jobs = excluded.closed_jobs,
           last_posted_at = excluded.last_posted_at, counted_at = excluded.counted_at
           WHERE company_job_counts.counted_at <= excluded.counted_at`,
        [at, JSON.stringify(rows)],
      )
    ).changes;
    after = ids[ids.length - 1]!;
  }
}

/** Feature.daily: `companies.job-counts`. */
export const jobCountsStep: DailyStep = { name: 'job-counts', run: (deps) => recountAllCompanyJobs(deps) };
