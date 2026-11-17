import type { JobReportBody } from '@tailorit/shared';
import type { AutofillClosedOutcome } from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../core/context';
import { fileClosedReport } from '../job-reviews/closed';

// v30 ST3: moved unchanged from store.ts (a pure move: wave 2's reports package takes this file whole). A person's
// report on a job (the Jobs page's flag dialog, POST /api/jobs/:id/report), for the admin console. v3.0 D2-C: through
// the async client.
//
// v30 X1-API (docs/design/part2/14-extension-reports.md §5.4): "The job is no longer open" (`inactive`) files a closed
// report (via `web`, signal `person`) into the job's closed review, beside the extension's reports, its details kept on
// the report row clipped to JOB_REVIEW_DETAILS_MAX (CT's edit H; the dialog takes 2,000 characters); under the same
// daily cap (429 MSG_EXT_REPORT_LIMIT). The other reasons go to job_reports as before: Admin › Review's Flags lane.

export interface ReportResult {
  /** The flag's id (job_reports), or the closed review's (`inactive`; null when no review was opened). */
  id: number | null;
  status: 'open';
  /** `inactive` only: what the closed report did (queued; closed: the account's own page job; already_closed). */
  outcome?: AutofillClosedOutcome;
}

/**
 * Files the viewer's report on a job for the admin console. A second report while the first is still open replaces
 * its reason and details instead of adding another (look, then write: behind the person's lock, so two reports at once
 * never both add one on PostgreSQL). `inactive` is a closed report (see above).
 */
export async function reportJob(deps: AppDeps, userId: string, jobId: number, body: JobReportBody): Promise<ReportResult> {
  const now = nowIso(deps);
  if (body.reason === 'inactive') {
    const filed = await fileClosedReport(deps, userId, jobId, {
      url: null,
      signal: 'person',
      marker: null,
      via: 'web',
      seenAt: now,
      details: body.details,
    });
    return { id: filed.reviewId, status: 'open', outcome: filed.outcome };
  }
  return deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      const open = await t.one<{ id: number }>(
        "SELECT id FROM job_reports WHERE user_id = ? AND job_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
        [userId, jobId],
      );
      if (open) {
        await t.run('UPDATE job_reports SET reason = ?, details = ?, created_at = ? WHERE id = ?', [body.reason, body.details, now, open.id]);
        return { id: open.id, status: 'open' as const };
      }
      const created = await t.one<{ id: number }>(
        'INSERT INTO job_reports(user_id, job_id, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        [userId, jobId, body.reason, body.details, 'open', now],
      );
      return { id: created!.id, status: 'open' as const };
    },
    { label: 'reportJob' },
  );
}
