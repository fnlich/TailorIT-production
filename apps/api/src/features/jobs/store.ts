import { EXPERIENCE_LEVELS, type ExperienceLevel } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import { APPLICATION_JOIN, DETAIL_COLUMNS, jsonStrings, type DetailRow, type LocationRow } from './rows';
import { countJobStat } from './stats';
import { jobTextJoin } from './text';
import { jobVisibleTo } from './visibility';

// Reads and writes of the viewer's relation to jobs: the detail row, hidden jobs, views. Every write is scoped by user
// id; another account's state is never read or changed. v30 ST3: a report is report.ts's, and hiding a company's jobs
// companies-router.ts's (pure moves, so wave 2's owners take each file whole). v3.0 D2-C: through the async client.

const DETAIL_SQL = `SELECT ${DETAIL_COLUMNS}
       FROM jobs j JOIN companies c ON c.id = j.company_id ${jobTextJoin('j', 'jt')} ${APPLICATION_JOIN}
       WHERE j.id = @jobId AND ${jobVisibleTo('j', '@userId')}`;
const SUPERSEDED_SQL = `SELECT j.superseded_by FROM jobs j WHERE j.id = ? AND ${jobVisibleTo('j')}`;
/** How many upgrades a stale id may follow. */
const MAX_HOPS = 5;

/** The job's detail row as `userId` sees it, or 404. */
export async function loadDetailRow(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number): Promise<DetailRow> {
  const row = await deps.db.one<DetailRow>(DETAIL_SQL, { userId, jobId });
  if (!row) throw notFound('That job');
  return row;
}

export async function loadLocations(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<LocationRow[]> {
  return deps.db.all<LocationRow>(
    'SELECT raw, city, region, country_code, is_remote FROM job_locations WHERE job_id = ? ORDER BY position',
    [jobId],
  );
}

/**
 * The job a job id stands for now, for `viewer`: a page job an upgrade closed (jobs.superseded_by) acts on the shared
 * job it gave way to, so a stale id (the agent's task, the side panel's chosen job, a Jobs tab still open) reaches it.
 * Null when the viewer does not see the job asked for (none, or another account's job made from a page): its
 * superseded_by is never followed then, so where another account's page job went is never told (audit A3). The
 * autofill routes, the Jobs page's routes, Save, Save all and the cover letters all act on it (audit D4).
 */
export async function currentJobId(deps: Pick<AppDeps, 'db'>, viewer: string, jobId: number): Promise<number | null> {
  let id = jobId;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const row = await deps.db.one<{ superseded_by: number | null }>(SUPERSEDED_SQL, [id, viewer]);
    if (!row) return null;
    if (!row.superseded_by || hop === MAX_HOPS) return id;
    id = row.superseded_by;
  }
  return id;
}

/**
 * The job's id and company, or 404: also for another account's job made from a page (autofill API version 5), which
 * only its own account sees. A page job an upgrade closed answers the shared job it gave way to (currentJobId), so
 * `id` may differ from the id asked for (audit D4).
 */
export async function requireJob(
  deps: Pick<AppDeps, 'db'>,
  jobId: number,
  userId: string,
): Promise<{ id: number; company_id: number; experience_levels: string }> {
  const id = await currentJobId(deps, userId, jobId);
  const row =
    id === null
      ? undefined
      : await deps.db.one<{ id: number; company_id: number; experience_levels: string }>(
          'SELECT id, company_id, experience_levels FROM jobs WHERE id = ?',
          [id],
        );
  if (!row) throw notFound('That job');
  return row;
}

export async function hiddenState(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  jobId: number,
  companyId: number,
): Promise<{ hidden: boolean; companyHidden: boolean }> {
  const job = await deps.db.one<{ hidden_at: string | null }>(
    'SELECT hidden_at FROM user_job_state WHERE user_id = ? AND job_id = ?',
    [userId, jobId],
  );
  const company = await deps.db.one('SELECT 1 AS hidden FROM user_hidden_companies WHERE user_id = ? AND company_id = ?', [
    userId,
    companyId,
  ]);
  return { hidden: Boolean(job?.hidden_at), companyHidden: Boolean(company) };
}

/**
 * Records that the viewer opened the job; its view count goes up on their first view only. Each step is one statement
 * that decides by itself whether this is the first view (a row without a view, or no row at all), so two first views
 * at once count once. v30 DB-JOBS: the count is job_stats.views (./stats.ts): a view never rewrites the jobs row.
 */
export async function markViewed(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, jobId: number): Promise<void> {
  const now = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      let first =
        (await t.run('UPDATE user_job_state SET viewed_at = ? WHERE user_id = ? AND job_id = ? AND viewed_at IS NULL', [now, userId, jobId]))
          .changes > 0;
      if (!first) {
        first = (await t.run(t.dialect.insertOrIgnore('user_job_state(user_id, job_id, viewed_at) VALUES (?, ?, ?)'), [userId, jobId, now]))
          .changes > 0;
      }
      if (first) {
        await countJobStat(t, jobId, 'views', now);
      } else {
        await t.run('UPDATE user_job_state SET viewed_at = ? WHERE user_id = ? AND job_id = ?', [now, userId, jobId]);
      }
    },
    { label: 'markViewed' },
  );
}

export async function setJobHidden(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, jobId: number, hidden: boolean): Promise<void> {
  if (hidden) {
    await deps.db.run(
      `INSERT INTO user_job_state(user_id, job_id, hidden_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, job_id) DO UPDATE SET hidden_at = COALESCE(user_job_state.hidden_at, excluded.hidden_at)`,
      [userId, jobId, nowIso(deps)],
    );
  } else {
    await deps.db.run('UPDATE user_job_state SET hidden_at = NULL WHERE user_id = ? AND job_id = ?', [userId, jobId]);
  }
}

/** The experience levels the viewer is looking for (Settings), for the facts grid's level check. */
export async function preferredLevels(deps: Pick<AppDeps, 'db'>, userId: string): Promise<ExperienceLevel[]> {
  const row = await deps.db.one<{ experience_levels: string }>('SELECT experience_levels FROM user_preferences WHERE user_id = ?', [userId]);
  const set = new Set(jsonStrings(row?.experience_levels));
  return EXPERIENCE_LEVELS.filter((level) => set.has(level));
}

// ------------------------------------------------------------------------------------------------------------------
