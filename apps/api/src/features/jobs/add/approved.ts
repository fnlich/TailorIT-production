import { linkKey } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import { closeLink, projectJob } from '../../../core/seams';
import { upgradeOwnPageJob } from '../../autofill/jobs';
import { retireLegacyJob } from './legacy';
import { noticeVerification } from './notify';
import { readLink } from './pipeline';
import { noteUnverified, ownJobsOfLink } from './verification';

// v32 FIX-API (REV-SECBEH SB-4, the coordinator's decision of 2026-11-18): a job an admin approved as captured
// (approve.ts) has a lifecycle like any other job's:
//   - it stays in search ADMIN_APPROVED_JOB_DAYS after its approval (the unverified sweep, ingest/unverified.ts), then
//     leaves search (still open) and is listed again in Admin › Review › Couldn't verify (verification.ts LISTED), to be
//     approved again, read again or rejected (a Reject closes it);
//   - its link is read again every JOB_PAGE_RECHECK_DAYS (the daily `job-links.page-recheck` step queues it, recheck.ts;
//     the link queue's worker reads it, settleApprovedRecheck):
//       read:   TailorIT's read is the job's now: the store rewrote it from the read (store.ts: an Add-job read rewrites
//               a captured `page` job) or, when the read made another job, the approved job gives way to it (its
//               trackers move: legacy.ts retireLegacyJob). Either way its approval goes (no "Approved by an admin"
//               mark), its captured `page` link is retired and it is back in search: a normal verified job, read again
//               as Add job's page jobs are; the adders' own jobs of the link give way to it, as a Retry read's do;
//       closed: it closes (closeLink, `gone`), and the link's notes say closed;
//       else:   nothing changes; its note's check time and reason move (read again at the next interval).

/** The SQL of the approved jobs due a read (`?` the time before which the last check is due), longest unchecked first. */
export const APPROVED_DUE_SQL = `SELECT a.job_id, j.apply_url, GREATEST(a.approved_at, COALESCE(v.checked_at, a.approved_at)) AS checked
  FROM job_admin_approvals a JOIN jobs j ON j.id = a.job_id LEFT JOIN job_verifications v ON v.job_id = a.job_id
  WHERE j.active AND j.owner_user_id IS NULL AND j.superseded_by IS NULL AND j.held_since IS NULL
    AND GREATEST(a.approved_at, COALESCE(v.checked_at, a.approved_at)) < ?
    AND NOT EXISTS (SELECT 1 FROM job_link_queue q WHERE q.for_job_id = a.job_id AND q.state <> 'done')
  ORDER BY checked, a.job_id LIMIT ?`;

/** The approved jobs due a read now (see the top): at most JOB_PAGE_RECHECKS_PER_PASS. */
export async function approvedJobsDue(deps: AppDeps, before: string): Promise<Array<{ jobId: number; url: string }>> {
  const rows = await deps.db.all<{ job_id: number; apply_url: string }>(APPROVED_DUE_SQL, [
    before,
    constantsOf(deps).get('JOB_PAGE_RECHECKS_PER_PASS'),
  ]);
  return rows.map((row) => ({ jobId: Number(row.job_id), url: row.apply_url }));
}

/** Whether the job is an admin's approval still on (job_admin_approvals). */
export async function isApprovedJob(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<boolean> {
  return (await deps.db.one('SELECT 1 FROM job_admin_approvals WHERE job_id = ?', [jobId])) !== undefined;
}

/**
 * Reads an approved job's link again (the worker's `recheck` row for it) and settles the job (see the top). Answers what
 * the read came to, as recheck.ts's settleRecheck does. Outside any transaction.
 */
export async function settleApprovedRecheck(deps: AppDeps, jobId: number, url: string): Promise<'live' | 'closed' | 'unreadable'> {
  const job = await deps.db.one<{ active: boolean; public: boolean }>(
    'SELECT active, owner_user_id IS NULL AND superseded_by IS NULL AS public FROM jobs WHERE id = ?',
    [jobId],
  );
  if (!job?.active || !job.public) return 'unreadable';
  // A real read (never a held job's shortcut); the admin approved this link, so a page's new job is never held (D12).
  const read = await readLink(deps, url, undefined, undefined, { fresh: true, approved: true });
  const at = nowIso(deps);
  if (read.kind === 'shared') {
    await deps.db.tx(
      async (t) => {
        if (read.jobId !== jobId) await retireLegacyJob(t, jobId, read.jobId, at);
        // A job like any other now: no approval, its captured link retired, its note gone, back in search.
        await t.run('DELETE FROM job_admin_approvals WHERE job_id = ?', [jobId]);
        await t.run(
          `UPDATE job_source_links SET missing_since = COALESCE(missing_since, ?)
           WHERE job_id = ? AND source_id IN (SELECT id FROM job_sources WHERE kind = 'page')`,
          [at, jobId],
        );
        await t.run('DELETE FROM job_verifications WHERE job_id = ? AND user_id IS NULL', [jobId]);
        await t.run('UPDATE jobs SET unverified_since = NULL, updated_at = ? WHERE id = ? AND superseded_by IS NULL', [at, jobId]);
        await projectJob(t, jobId);
      },
      { label: 'approved job read' },
    );
    // TailorIT reads the link now: every account's own job of it gives way to the job read, as a Retry read's does (the
    // adders who kept their own version when the approval was made, SB-1), and each adder hears it.
    const key = linkKey(url);
    for (const row of key ? await ownJobsOfLink(deps.db, key) : []) {
      try {
        if (await upgradeOwnPageJob(deps, row.user_id, Number(row.job_id), read.jobId, { sameLink: true })) {
          await noticeVerification(deps, { userId: row.user_id, jobId: read.jobId, state: 'published' });
        }
      } catch (error) {
        deps.log.warn('[job-links] an own job could not give way to the job read', error instanceof Error ? error.name : 'unknown');
      }
    }
    return 'live';
  }
  if (read.kind === 'closed') {
    const key = linkKey(url);
    await deps.db.tx(
      async (t) => {
        await closeLink(deps, t, { jobId, reason: 'gone', at });
        if (key) await t.run("UPDATE job_verifications SET reason = 'closed', checked_at = ? WHERE url_key = ?", [at, key]);
      },
      { label: 'approved job closed' },
    );
    return 'closed';
  }
  await noteUnverified(deps.db, { jobId, userId: null, url, origin: 'admin', reason: read.reason }, at);
  return 'unreadable';
}
