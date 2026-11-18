import { DAY_MS } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DailyStep } from '../../../core/feature';
import { closeLink } from '../../../core/seams';
import { ADDED_BY_AUTOFILL } from '../../ingest/liveness';
import { readPageToSharedJob } from './page';
import { queueJobLinks } from './queue';

// v31 LINK2 (21-jobs-from-links.md §10; the coordinator's decision of 2026-11-17): a job TailorIT read from its own
// page when it was added (its host's career-site source, made disabled for Add job) is read again every
// JOB_PAGE_RECHECK_DAYS, so a posting that closed leaves search. The daily step `job-links.page-recheck` queues the
// due ones (job_link_queue, origin `recheck`, for that job); the worker reads them a host at a time at each host's
// pace, and waits while every run is paused (pause.ts). A read (settleRecheck):
//   - read: the store saw the posting again (its last-seen and last-verified times move); the link's check time moves;
//   - closed (404, 410, or its JSON-LD's validThrough past): the link closes (closeLink, `gone`), and the job with it
//     when no other live link is left;
//   - unreadable (robots.txt, a wall, no JSON-LD now, a site down): nothing closes; the check time moves, so the page
//     is read again at the next interval (a read that failed for now is retried first, as any queued read).
// A career site an admin enabled is read by its own runs, never here.
//
// v31 FIX-LINK (REV-BEH BEH-10): a pass queues at most JOB_PAGE_RECHECKS_PER_PASS links (a constant), the longest
// unchecked first, so every due job is reached in turn however many there are (v31 LINK2 took the lowest job ids first:
// past 7 x 2,000 jobs the highest were never read again).

/** The SQL of the live career-site links Add job's reads made: their sources disabled, marked as Add job's. */
const ADDED_PAGE_LINK_SQL = `l.missing_since IS NULL AND s.kind = 'career_site' AND NOT s.enabled AND s.config ->> 'addedBy' = ?`;

/** The daily step (see the top): links queued. */
export const pageRecheckStep: DailyStep = {
  name: 'page-recheck',
  async run(deps) {
    const before = new Date(deps.now().getTime() - constantsOf(deps).get('JOB_PAGE_RECHECK_DAYS') * DAY_MS).toISOString();
    const due = await deps.db.all<{ job_id: number; apply_url: string }>(
      `SELECT job_id, apply_url FROM (
         SELECT DISTINCT ON (l.job_id) l.job_id, j.apply_url, COALESCE(l.liveness_checked_at, l.last_seen_at) AS checked
         FROM job_source_links l JOIN job_sources s ON s.id = l.source_id JOIN jobs j ON j.id = l.job_id
         WHERE ${ADDED_PAGE_LINK_SQL} AND j.active AND j.owner_user_id IS NULL AND j.superseded_by IS NULL
           AND COALESCE(l.liveness_checked_at, l.last_seen_at) < ?
           AND NOT EXISTS (SELECT 1 FROM job_link_queue q WHERE q.for_job_id = l.job_id AND q.state <> 'done')
         ORDER BY l.job_id, COALESCE(l.liveness_checked_at, l.last_seen_at)) AS due
       ORDER BY checked, job_id LIMIT ?`,
      [ADDED_BY_AUTOFILL, before, constantsOf(deps).get('JOB_PAGE_RECHECKS_PER_PASS')],
    );
    const queued = await queueJobLinks(
      deps,
      due.map((row) => ({ jobId: Number(row.job_id), url: row.apply_url })),
      'recheck',
    );
    return queued;
  },
};

/** The job's live Add-job career-site link. */
async function addedPageLink(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<{ source_id: number; source_job_id: string } | undefined> {
  return deps.db.one<{ source_id: number; source_job_id: string }>(
    `SELECT l.source_id, l.source_job_id FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
     WHERE l.job_id = ? AND ${ADDED_PAGE_LINK_SQL} ORDER BY l.seq LIMIT 1`,
    [jobId, ADDED_BY_AUTOFILL],
  );
}

/** Reads a queued `recheck` link again and settles its job (see the top). Answers what the read came to. */
export async function settleRecheck(deps: AppDeps, jobId: number, url: string): Promise<'live' | 'closed' | 'unreadable'> {
  const link = await addedPageLink(deps, jobId);
  if (!link) return 'unreadable';
  const read = await readPageToSharedJob(deps, url);
  const at = nowIso(deps);
  if (read.kind === 'closed') {
    await deps.db.tx(
      (t) => closeLink(deps, t, { jobId, link: { sourceId: Number(link.source_id), sourceJobId: link.source_job_id }, reason: 'gone', at }),
      { label: 'page recheck closed' },
    );
    return 'closed';
  }
  await deps.db.run('UPDATE job_source_links SET liveness_checked_at = ? WHERE source_id = ? AND source_job_id = ?', [
    at,
    link.source_id,
    link.source_job_id,
  ]);
  return read.kind === 'shared' ? 'live' : 'unreadable';
}
