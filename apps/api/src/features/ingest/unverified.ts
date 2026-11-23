import type { DailyStep } from '../../core/feature';
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries, DbTx } from '../../core/db/types';
import { projectJobs } from './project-job';
import { ROW_SOURCE_KINDS } from './types';

// v30 S1-API: the daily unverified sweep (12-job-sourcing.md §8.3, 11-database.md §5.3, 14 §5.3 step 4). A job no
// source has verified for JOB_UNVERIFIED_HIDE_DAYS leaves search but stays open (its source may be failing; people keep
// it in their trackers): jobs.unverified_since is set and projectJob removes its job_search row, in the same
// transaction. It comes back the same way once verified again.
//
// "Verified" is, for each of the job's live links, the latest of:
//   - its listing source's last complete run (or 304), job_sources.last_complete_at, for a link that run listed
//     (miss_count 0): a complete run verifies every link it lists at once (no daily touch of every link);
//   - the link's own read (liveness_checked_at: a re-check found it live; wave 4's per-posting kinds);
//   - the job's last verified read (jobs.last_verified_at: a run or Add job that read the posting, a later add of a
//     published page job, its approval: 14's `ext_page` rule).
// An admin's import, the demo seed and a person's page job are never swept (UNVERIFIED_EXEMPT_KINDS): nothing reads
// them again, and the import or the person vouches for them.
//
// The sweep works over sources, not jobs: only the live links of sources with no complete run in the window are read
// (the failing sources, the never-run ones: Add job's disabled boards, published page jobs), in batches of
// UNVERIFIED_BATCH jobs. A source's next complete run brings its jobs back at once (clearUnverifiedOf, from the run's
// finish); the sweep's first pass brings back any other job verified again (a re-check, a re-add).
//
// v32 FIX-API (REV-SECBEH SB-4, the coordinator's decision of 2026-11-18): a job an admin approved as captured
// (job_admin_approvals: its words a person's, never TailorIT's read) has only its adder's `page` link, which the sweep
// exempts. So an approval verifies its job for ADMIN_APPROVED_JOB_DAYS only: then the sweep's third pass takes the job
// out of search (still open, in its trackers), and the first pass never brings it back, while no link of a source
// TailorIT reads is live on it. Approved again (Admin › Review › Couldn't verify lists it again), it comes back; read
// by TailorIT (the weekly re-read, jobs/add/approved.ts), it becomes a job like any other and its approval goes.
// v35 FIX-PIPE (data D1, the coordinator's decision 4): an admin's import vouches for an open job TailorIT could not
// read now with an approval of kind `import` (jobs/add/import-jobs.ts repostJob), on a job whose links are a board's
// that no run verifies: the second pass leaves a job alone while its approval is newer than ADMIN_APPROVED_JOB_DAYS,
// so the vouch keeps it in search that long, unless a source lists it (then its own reads keep it).

/** Kinds whose links verify their jobs for good: imports, the demo seed, a person's own page job. */
export const UNVERIFIED_EXEMPT_KINDS: readonly string[] = ['csv', 'json', 'seed', 'page'];
/** Jobs one transaction of the sweep marks or clears. */
export const UNVERIFIED_BATCH = 1000;

/** v32 FIX-API (SB-4): the kinds whose links are no read of TailorIT's (a person's page, a row, the demo seed). */
const UNREAD_KINDS = ['page', 'seed', ...ROW_SOURCE_KINDS].join(',');

/**
 * v32 FIX-API (SB-4): the SQL condition "job `j`'s admin approval ran out" (approved before @approvedCutoff) and no link
 * of a source TailorIT reads is live on it (@unread: UNREAD_KINDS).
 */
const APPROVAL_RAN_OUT = `(EXISTS (SELECT 1 FROM job_admin_approvals aa WHERE aa.job_id = j.id AND aa.approved_at < CAST(@approvedCutoff AS timestamptz))
  AND NOT EXISTS (SELECT 1 FROM job_source_links rl JOIN job_sources rs ON rs.id = rl.source_id
                  WHERE rl.job_id = j.id AND rl.missing_since IS NULL AND NOT (rs.kind = ANY(string_to_array(@unread, ',')))))`;

/** When the job `j` was last verified (see the top); NULL when never. Exempt links count as always. */
const VERIFIED_AT = `GREATEST(
  j.last_verified_at,
  (SELECT max(CASE WHEN s.kind = ANY(string_to_array(@exempt, ',')) THEN CAST('infinity' AS timestamptz)
                   WHEN k.runs AND l.miss_count = 0 THEN s.last_complete_at END)
     FROM job_source_links l JOIN job_sources s ON s.id = l.source_id JOIN job_source_kinds k ON k.kind = s.kind
    WHERE l.job_id = j.id AND l.missing_since IS NULL),
  (SELECT max(l.liveness_checked_at) FROM job_source_links l WHERE l.job_id = j.id AND l.missing_since IS NULL))`;

/**
 * A complete run (or a 304) of the source verified its listed links: their jobs that were unverified come back, each
 * re-projected into search in the caller's transaction. Answers how many came back.
 */
export async function clearUnverifiedOf(t: DbTx, sourceId: number): Promise<number> {
  // v30 FIX-A (REQ-3): a read first, so a run whose jobs are all verified makes no statement on `jobs` (0007's mark).
  const any = await t.one<{ found: number }>(
    `SELECT 1 AS found FROM job_source_links l JOIN jobs j ON j.id = l.job_id
     WHERE l.source_id = ? AND l.missing_since IS NULL AND l.miss_count = 0 AND j.unverified_since IS NOT NULL LIMIT 1`,
    [sourceId],
  );
  if (!any) return 0;
  const back = await t.all<{ id: number }>(
    `UPDATE jobs SET unverified_since = NULL WHERE unverified_since IS NOT NULL
       AND id IN (SELECT job_id FROM job_source_links WHERE source_id = ? AND missing_since IS NULL AND miss_count = 0)
     RETURNING id`,
    [sourceId],
  );
  await projectJobs(
    t,
    back.map((row) => row.id),
  );
  return back.length;
}

/** The cutoff: a job verified before it is unverified. */
function cutoffOf(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): string {
  return new Date(deps.now().getTime() - constantsOf(deps).get('JOB_UNVERIFIED_HIDE_DAYS') * 86_400_000).toISOString();
}

/** v32 FIX-API (SB-4): an approval made before it has run out. */
function approvedCutoffOf(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): string {
  return new Date(deps.now().getTime() - constantsOf(deps).get('ADMIN_APPROVED_JOB_DAYS') * 86_400_000).toISOString();
}

/** The next batch of jobs to look at, by id after `after`. */
type Batch = (db: DbQueries, after: number) => Promise<number[]>;

/** Runs `write` over the ids `batch` answers, a transaction per batch, until none are left. Answers the rows changed. */
async function inBatches(deps: Pick<AppDeps, 'db'>, batch: Batch, write: (t: DbTx, ids: number[]) => Promise<number>): Promise<number> {
  let after = 0;
  let changed = 0;
  for (;;) {
    const ids = await batch(deps.db, after);
    if (ids.length === 0) return changed;
    changed += await deps.db.tx((t) => write(t, ids), { label: 'unverified sweep' });
    after = ids[ids.length - 1]!;
  }
}

/**
 * The daily sweep (see the top): first the unverified jobs verified again come back, then the open, shared, unheld jobs
 * of sources with no complete run in the window that nothing else verified leave search; v32 FIX-API (SB-4): then the
 * jobs whose admin approval ran out. Answers the jobs changed.
 */
export async function sweepUnverified(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): Promise<number> {
  const cutoff = cutoffOf(deps);
  const approvedCutoff = approvedCutoffOf(deps);
  const unread = UNREAD_KINDS;
  const now = nowIso(deps);
  const exempt = UNVERIFIED_EXEMPT_KINDS.join(',');
  const back = await inBatches(
    deps,
    async (db, after) =>
      (
        await db.all<{ id: number }>('SELECT id FROM jobs WHERE unverified_since IS NOT NULL AND id > ? ORDER BY id LIMIT ?', [
          after,
          UNVERIFIED_BATCH,
        ])
      ).map((row) => row.id),
    async (t, ids) => {
      const rows = await t.all<{ id: number }>(
        `UPDATE jobs j SET unverified_since = NULL
         WHERE j.id = ANY(CAST(string_to_array(@ids, ',') AS bigint[])) AND j.unverified_since IS NOT NULL
           AND COALESCE(${VERIFIED_AT}, CAST('-infinity' AS timestamptz)) >= CAST(@cutoff AS timestamptz)
           AND NOT ${APPROVAL_RAN_OUT}
         RETURNING j.id`,
        { ids: ids.join(','), cutoff, exempt, approvedCutoff, unread },
      );
      await projectJobs(
        t,
        rows.map((row) => row.id),
      );
      return rows.length;
    },
  );
  const gone = await inBatches(
    deps,
    // The live links of sources with no complete run in the window (idx_job_sources_verified, then idx_jsl_live).
    async (db, after) =>
      (
        await db.all<{ job_id: number }>(
          `SELECT DISTINCT l.job_id FROM job_sources s JOIN job_source_links l ON l.source_id = s.id AND l.missing_since IS NULL
           WHERE (s.last_complete_at IS NULL OR s.last_complete_at < CAST(@cutoff AS timestamptz))
             AND NOT (s.kind = ANY(string_to_array(@exempt, ','))) AND l.job_id > @after
           ORDER BY l.job_id LIMIT @limit`,
          { cutoff, exempt, after, limit: UNVERIFIED_BATCH },
        )
      ).map((row) => row.job_id),
    async (t, ids) => {
      const rows = await t.all<{ id: number }>(
        `UPDATE jobs j SET unverified_since = CAST(@now AS timestamptz)
         WHERE j.id = ANY(CAST(string_to_array(@ids, ',') AS bigint[]))
           AND j.active AND j.held_since IS NULL AND j.owner_user_id IS NULL AND j.unverified_since IS NULL
           AND j.first_seen_at < CAST(@cutoff AS timestamptz)
           AND COALESCE(${VERIFIED_AT}, CAST('-infinity' AS timestamptz)) < CAST(@cutoff AS timestamptz)
           AND NOT EXISTS (SELECT 1 FROM job_admin_approvals va WHERE va.job_id = j.id AND va.approved_at >= CAST(@approvedCutoff AS timestamptz))
         RETURNING j.id`,
        { ids: ids.join(','), now, cutoff, exempt, approvedCutoff }, // v35 FIX-PIPE (data D1): an approval still on keeps it
      );
      // Out of search in the same transaction (the 0004 trigger also deletes the row; projectJob says so).
      await projectJobs(
        t,
        rows.map((row) => row.id),
      );
      return rows.length;
    },
  );
  // v32 FIX-API (SB-4): the jobs whose admin approval ran out (few: approved by hand) leave search, still open.
  const ranOut = await inBatches(
    deps,
    async (db, after) =>
      (
        await db.all<{ job_id: number }>(
          `SELECT aa.job_id FROM job_admin_approvals aa
           WHERE aa.approved_at < CAST(@approvedCutoff AS timestamptz) AND aa.job_id > @after ORDER BY aa.job_id LIMIT @limit`,
          { approvedCutoff, after, limit: UNVERIFIED_BATCH },
        )
      ).map((row) => Number(row.job_id)),
    async (t, ids) => {
      const rows = await t.all<{ id: number }>(
        `UPDATE jobs j SET unverified_since = CAST(@now AS timestamptz)
         WHERE j.id = ANY(CAST(string_to_array(@ids, ',') AS bigint[]))
           AND j.active AND j.held_since IS NULL AND j.owner_user_id IS NULL AND j.superseded_by IS NULL AND j.unverified_since IS NULL
           AND ${APPROVAL_RAN_OUT}
         RETURNING j.id`,
        { ids: ids.join(','), now, approvedCutoff, unread },
      );
      await projectJobs(
        t,
        rows.map((row) => row.id),
      );
      return rows.length;
    },
  );
  if (back || gone || ranOut) {
    const approvals = ranOut > 0 ? ` (${ranOut} admin approval(s) ran out)` : '';
    deps.log.info(`[ingest] unverified sweep: ${gone + ranOut} job(s) out of search, ${back} back in${approvals}`);
  }
  return back + gone + ranOut;
}

/** The daily housekeeping's step (Feature.daily): `ingest.unverified`. */
export const unverifiedDailyStep: DailyStep = { name: 'unverified', run: (deps) => sweepUnverified(deps) };
