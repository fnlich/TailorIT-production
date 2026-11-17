import type { DbQueries } from '../../core/db/types';

// v30 DB-JOBS (docs/design/part2/11-database.md §5.5): a job's views and saves are counted in `job_stats`, apart from
// the jobs row, so a view or a save never rewrites the job (v2.0 bumped jobs.view_count, which migration 0011 drops).
// One row per job that was ever viewed or saved, made on its first count:
//   views  the accounts that opened the job (an account's first view only: jobs/store.ts markViewed, whose mark
//          user_job_state.viewed_at is kept USER_JOB_VIEW_KEEP_DAYS, so an account that comes back later counts again)
//   saves  the tracker entries made for the job (applications/service.ts: one per account and job, idx_app_user_job;
//          an entry deleted later is not taken back)
// Each count is one upsert in the caller's transaction; two at once both count (the row lock orders them).

type JobStat = 'views' | 'saves';

const UPSERT: Record<JobStat, string> = {
  views: `INSERT INTO job_stats(job_id, views, saves, updated_at) VALUES (?, 1, 0, ?)
          ON CONFLICT (job_id) DO UPDATE SET views = job_stats.views + 1, updated_at = excluded.updated_at`,
  saves: `INSERT INTO job_stats(job_id, views, saves, updated_at) VALUES (?, 0, 1, ?)
          ON CONFLICT (job_id) DO UPDATE SET saves = job_stats.saves + 1, updated_at = excluded.updated_at`,
};

/** Counts one more `stat` of the job at `at` (ISO time). */
export async function countJobStat(db: DbQueries, jobId: number, stat: JobStat, at: string): Promise<void> {
  await db.run(UPSERT[stat], [jobId, at]);
}

/** A job's counts (zeros for a job never viewed or saved). */
export async function jobStats(db: DbQueries, jobId: number): Promise<{ views: number; saves: number }> {
  const row = await db.one<{ views: number; saves: number }>('SELECT views, saves FROM job_stats WHERE job_id = ?', [jobId]);
  return { views: row?.views ?? 0, saves: row?.saves ?? 0 };
}

/** The join that brings a listed job's counts: `LEFT JOIN job_stats <alias> ON <alias>.job_id = <jobAlias>.id`. */
export function jobStatsJoin(jobAlias = 'j', alias = 'js'): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(jobAlias) || !/^[a-z_][a-z0-9_]*$/.test(alias)) {
    throw new Error(`jobStatsJoin takes SQL aliases: ${jobAlias}, ${alias}`);
  }
  return `LEFT JOIN job_stats ${alias} ON ${alias}.job_id = ${jobAlias}.id`;
}
