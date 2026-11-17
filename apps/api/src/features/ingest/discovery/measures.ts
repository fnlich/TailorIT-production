import type { DiscoveryKindMeasure, JobSourceKind } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { BOARD_KINDS } from './boards';

// v30 S2: each board's open life and postings (docs/design/part2/12-job-sourcing.md §5.2, §11 phase 2: "measuring
// open life and postings per board", so section 5's estimates are replaced by counts). A daily step measures every
// source in one set-based pass (v30 FIX-PERF) and writes one job_source_measures row each (migration 0020):
//   open_jobs                its jobs open now (a live link, an active job)
//   new_30d                  its postings first seen in the last 30 days (new postings a month)
//   closed_90d               its jobs closed in the last 90 days
//   open_life_days_median    how long those were open, closed_at - first_seen_at, in days: the median and the mean
//   open_life_days_mean
// Admin › Candidates shows each validated board's row, and the summary by kind (kindMeasures): boards, boards with open
// jobs, open jobs per board, new postings per board a month, and the open life across its boards.

/** The windows of the measures, in days. */
export const NEW_WINDOW_DAYS = 30;
export const CLOSED_WINDOW_DAYS = 90;

/**
 * One pass over every source (the daily step): answers how many rows it wrote.
 *
 * v30 FIX-PERF (PG-LOAD PGL-17): one set-based statement: every link and its job are read once (the planner joins the
 * two tables by hashing, each read in order) and grouped by source, and every source's row is written by one INSERT ...
 * ON CONFLICT (a source without links gets zeros). It measured 500 sources at a time, reaching each link's job through
 * jobs' key at random: one batch (40,954 links) did not finish in 240 s on the load test's disk, and a pass reads every
 * link and job (5.7 M at mix B's base size).
 */
export async function measureBoards(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  const at = nowIso(deps);
  const nowMs = deps.now().getTime();
  const newSince = new Date(nowMs - NEW_WINDOW_DAYS * 86_400_000).toISOString();
  const closedSince = new Date(nowMs - CLOSED_WINDOW_DAYS * 86_400_000).toISOString();
  const closed = 'NOT j.active AND j.closed_at >= CAST(@closedSince AS timestamptz)';
  const life = 'GREATEST(0, extract(epoch FROM j.closed_at - j.first_seen_at)) / 86400';
  return (
    await deps.db.run(
      `INSERT INTO job_source_measures AS m (source_id, open_jobs, new_30d, closed_90d, open_life_days_median, open_life_days_mean, measured_at)
       SELECT s.id, COALESCE(x.open_jobs, 0), COALESCE(x.new_30d, 0), COALESCE(x.closed_90d, 0), x.life_median, x.life_mean,
         CAST(@at AS timestamptz)
       FROM job_sources s
       LEFT JOIN (
         SELECT l.source_id,
           count(*) FILTER (WHERE l.missing_since IS NULL AND j.active) AS open_jobs,
           count(*) FILTER (WHERE l.first_seen_at >= CAST(@newSince AS timestamptz)) AS new_30d,
           count(*) FILTER (WHERE ${closed}) AS closed_90d,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ${life}) FILTER (WHERE ${closed}) AS life_median,
           avg(${life}) FILTER (WHERE ${closed}) AS life_mean
         FROM job_source_links l JOIN jobs j ON j.id = l.job_id
         GROUP BY l.source_id
       ) x ON x.source_id = s.id
       ORDER BY s.id
       ON CONFLICT (source_id) DO UPDATE SET open_jobs = EXCLUDED.open_jobs, new_30d = EXCLUDED.new_30d,
         closed_90d = EXCLUDED.closed_90d, open_life_days_median = EXCLUDED.open_life_days_median,
         open_life_days_mean = EXCLUDED.open_life_days_mean, measured_at = EXCLUDED.measured_at`,
      { at, newSince, closedSince },
    )
  ).changes;
}

/** The measures by board kind (the four APIs and the other board kinds with a source), from the last daily pass. */
export async function kindMeasures(db: DbQueries): Promise<DiscoveryKindMeasure[]> {
  const kinds = Object.keys(BOARD_KINDS).filter((kind) => kind !== 'workday');
  const rows = await db.all<{
    kind: JobSourceKind;
    sources: number;
    boards_open: number;
    open_jobs: number;
    new_30d: number;
    closed_90d: number;
    life_median: number | null;
    life_mean: number | null;
    measured_at: string | null;
  }>(
    `SELECT s.kind, count(*) AS sources,
       count(*) FILTER (WHERE m.open_jobs > 0) AS boards_open,
       COALESCE(sum(m.open_jobs), 0) AS open_jobs,
       COALESCE(sum(m.new_30d), 0) AS new_30d,
       COALESCE(sum(m.closed_90d), 0) AS closed_90d,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY m.open_life_days_median) FILTER (WHERE m.closed_90d > 0) AS life_median,
       sum(m.open_life_days_mean * m.closed_90d) FILTER (WHERE m.closed_90d > 0) / NULLIF(sum(m.closed_90d) FILTER (WHERE m.closed_90d > 0), 0) AS life_mean,
       max(m.measured_at) AS measured_at
     FROM job_sources s LEFT JOIN job_source_measures m ON m.source_id = s.id
     WHERE s.enabled AND s.kind = ANY(string_to_array(?, ','))
     GROUP BY s.kind ORDER BY s.kind`,
    [kinds.join(',')],
  );
  const round = (value: number | null) => (value === null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10) / 10);
  return rows.map((row) => ({
    kind: row.kind,
    sources: row.sources,
    boardsWithOpenJobs: row.boards_open,
    openJobs: row.open_jobs,
    openJobsPerBoard: row.boards_open > 0 ? round(row.open_jobs / row.boards_open) : null,
    newPostingsPerBoardPerMonth: row.sources > 0 ? round(row.new_30d / row.sources) : null,
    closed90d: row.closed_90d,
    openLifeDaysMedian: round(row.life_median),
    openLifeDaysMean: round(row.life_mean),
    measuredAt: row.measured_at,
  }));
}
