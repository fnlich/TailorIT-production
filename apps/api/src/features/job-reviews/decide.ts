import type { JobReviewDecider } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbQueries, DbTx } from '../../core/db/types';
import { conflict } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { closeLink, offerToDiscovery, projectJob, type JobLinkRef } from '../../core/seams';
import { upgradeOwnPageJob } from '../autofill/jobs';
import { noticeVerification } from '../jobs/add/notify'; // v31 LINK
import { publishCapturedIn } from '../jobs/add/approve'; // v32 ADMINAPP (E6)
import { DATE_APPROVED_SQL } from '../jobs/add/import-time'; // v36 IMPORTTIME
import { boardOfUrl } from '../ingest/discovery/boards';
import { boardOfJob, companyOf } from './checks';
import { pendingReview, recountReview, type ReviewRow } from './store';

// v30 X1-API: the decisions on a review (docs/design/part2/14-extension-reports.md §5): approve, reject, reopen. Each
// runs in the caller's transaction, with the review's row locked (reviewById(t, id, true)), and only on a review in the
// right state. What an approval does:
// - a closed link closes as its own read's 404 would: closeLink (DB-INGEST's one close function) with the link the
//   reports name, or every live link when they named none (reason `report`); the job closes when no live link is left,
//   and leaves search in the same transaction (closeLink's projectJob);
// - a new job read from an ATS is published: held_since cleared and projectJob in the same transaction, then its board
//   offered to discovery (offerToDiscovery, `extension`), unless its company opted out;
// - a new job from pages: v31 LINK (D2) publishes only what TailorIT read itself from the review's link (the caller's
//   read, before this transaction: the shared job jobs/add stored from the page's schema.org JobPosting or its ATS); a
//   page TailorIT cannot read is refused (MSG_JOB_REVIEW_PAGE_UNREADABLE), never published from a browser's text (v3.0's
//   publishPageJob, which copied the most agreed capture into an `ext_page` job, is gone). The page's host is offered
//   to discovery as a career site. After the commit each reporting account's page job gives way to the shared job
//   (upgradeOwnPageJob: its tracker entry, aliases, queue rows and marks move; the page job closes, superseded): the
//   follow-ups.
// A rejection changes nothing else (a held job stays its adders' own; a page job its account's). A reopen brings a
// rejected or expired review back to the queue.
// v32 ADMINAPP (E6, the owner's "admin should be able to approve manually", over v3.1's D2): a page review whose page
// TailorIT cannot read is approved as it was captured when the admin says so (`captured`, after a confirm): the page job
// whose text most reporters share is published as it is (jobs/add/approve.ts publishCapturedIn: its company by name
// alone, marked approved by the admin), and every reporter's page job gives way to it.
// v32 FIX-API (REV-SECBEH SB-1, the coordinator's decision): the other reporters' page jobs are never closed or moved
// into the captured job published: each keeps theirs and is told a public version exists (`publicVersion`); the checks
// of a Couldn't-verify approval hold too (approve.ts: the link's checks under its lock, never the admin's own words).

/** Who decides: an admin (with their account), the automatic rules, or TailorIT's own check. */
export interface Decider {
  by: Exclude<JobReviewDecider, 'source'>;
  userId: string | null;
  note?: string | null;
}

/** Work an approval leaves for after its commit: a page job giving way to the shared job published now. */
export interface FollowUp {
  userId: string;
  pageJobId: number;
  sharedJobId: number;
  /** v31 LINK: the shared job was read from the page job's own link (upgradeOwnPageJob's sameLink). */
  sameLink?: boolean;
  /** v32 ADMINAPP (E6): the shared job is the admin's approval of a captured page job (its own reporter's included). */
  approvedByAdmin?: boolean;
  /** v32 FIX-API (SB-1): the page job stays its reporter's; they are told another reporter's version is published. */
  publicVersion?: boolean;
}

/** v32 ADMINAPP (E6): a page review approved as captured: its link (shared form), checked by the caller, and the admin. */
export interface CapturedApproval {
  url: string;
  adminId: string;
}

/** v31 LINK: the shared job TailorIT read from a page review's link, before its approval's transaction. */
export interface PageReviewRead {
  sharedJobId: number;
}

/** The page job whose text most accounts share (ties: the first report), with every reporter's page job still there. */
export async function pageJobsOf(t: DbQueries, reviewId: number): Promise<{ chosen: number | null; reports: Array<{ userId: string; pageJobId: number }> }> {
  const rows = await t.all<{ user_id: string; page_job_id: number; text_hash: Buffer | null }>(
    `SELECT r.user_id, r.page_job_id, r.text_hash FROM job_review_reports r JOIN jobs j ON j.id = r.page_job_id
     WHERE r.review_id = ? AND r.page_job_id IS NOT NULL ORDER BY r.created_at, r.user_id`,
    [reviewId],
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.text_hash ? Buffer.from(row.text_hash).toString('hex') : `job:${row.page_job_id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let chosen: number | null = null;
  let best = 0;
  for (const row of rows) {
    const key = row.text_hash ? Buffer.from(row.text_hash).toString('hex') : `job:${row.page_job_id}`;
    if ((counts.get(key) ?? 0) > best) {
      best = counts.get(key)!;
      chosen = row.page_job_id;
    }
  }
  return { chosen, reports: rows.map((row) => ({ userId: row.user_id, pageJobId: row.page_job_id })) };
}

/**
 * v31 LINK (D2): a page review's approval publishes only what TailorIT read itself. The caller read the review's link
 * outside the transaction (readPageReviewLink) and hands the shared job it stored (`read`); each reporting account's page
 * job then gives way to it (the follow-ups). With no read (the page could not be read), the approval is refused: an
 * admin never publishes the text a person's browser captured (v3.0's publishPageJob is gone).
 */
async function followUpsOfRead(deps: AppDeps, t: DbTx, review: ReviewRow, read: PageReviewRead | undefined): Promise<FollowUp[]> {
  if (!read) throw refuse(deps, 'conflict', 'MSG_JOB_REVIEW_PAGE_UNREADABLE');
  const { reports } = await pageJobsOf(t, review.id);
  return reports.map((report) => ({ ...report, sharedJobId: read.sharedJobId, sameLink: true }));
}

/**
 * Offers a board to discovery unless the job's company opted out (its boards never become candidates, 14 §7). v30 FIX-B
 * (S2's edit B): a Workday posting's board is its career site (`workday_site`, which discovery validates and S3's
 * sitemap source reads), not Add job's one-posting tenant (`workday`, which lists nothing and would wait for ever).
 */
async function offerBoard(deps: AppDeps, t: DbTx, jobId: number, board: { kind: 'career_site'; name: string } | null, at: string) {
  const company = await companyOf(t, jobId);
  if (!company || company.doNotFetch) return;
  let offered = board ?? (await boardOfJob(t, jobId));
  if (offered?.kind === 'workday') {
    const job = await t.one<{ apply_url: string }>('SELECT apply_url FROM jobs WHERE id = ?', [jobId]);
    offered = (job ? boardOfUrl(job.apply_url) : null) ?? offered;
  }
  if (offered) await offerToDiscovery(deps, t, { kind: offered.kind, name: offered.name, via: 'extension', at });
}

async function markDecided(t: DbQueries, review: ReviewRow, state: 'approved' | 'rejected', decider: Decider, at: string): Promise<void> {
  await t.run(
    `UPDATE job_reviews SET state = ?, decided_by = ?, decided_by_user = ?, decided_at = ?, note = COALESCE(?, note), updated_at = ?
     WHERE id = ? AND state = 'pending'`,
    [state, decider.by, decider.userId, at, decider.note ?? null, at, review.id],
  );
}

/**
 * v32 ADMINAPP (E6): a page review TailorIT cannot read, approved as captured: its most shared page job is published as
 * it is (publishCapturedIn), its reporter told. v32 FIX-API (SB-1): every other reporter keeps their page job and is
 * told a public version exists; only when the link's open job is one TailorIT read (joined) do their jobs give way.
 */
async function followUpsOfCapture(deps: AppDeps, t: DbTx, review: ReviewRow, captured: CapturedApproval, at: string): Promise<FollowUp[]> {
  const { chosen, reports } = await pageJobsOf(t, review.id);
  if (chosen === null) throw refuse(deps, 'conflict', 'MSG_JOB_REVIEW_PAGE_UNREADABLE');
  const published = await publishCapturedIn(deps, t, { jobId: chosen, url: captured.url, adminId: captured.adminId, at });
  return reports.map((report) => {
    const followUp = { ...report, sharedJobId: published.jobId, sameLink: true, approvedByAdmin: published.approved };
    return published.approved && report.pageJobId !== published.jobId ? { ...followUp, publicVersion: true } : followUp;
  });
}

/** Approves a pending review (see above), in the caller's transaction; answers the follow-ups for after the commit. */
export async function approveReview(
  deps: AppDeps,
  t: DbTx,
  review: ReviewRow,
  decider: Decider,
  at: string,
  read?: PageReviewRead,
  captured?: CapturedApproval,
): Promise<FollowUp[]> {
  if (review.state !== 'pending') throw conflict('This review was decided already.');
  let followUps: FollowUp[] = [];
  if (review.kind === 'closed') {
    const link: JobLinkRef | undefined =
      review.link_source_id !== null && review.link_source_job_id !== null
        ? { sourceId: review.link_source_id, sourceJobId: review.link_source_job_id }
        : undefined;
    await closeLink(deps, t, { jobId: review.job_id, ...(link ? { link } : {}), reason: 'report', at });
  } else if (review.origin === 'ats') {
    // v36 IMPORTTIME (SP v36 PLAN.md I1): a job an admin's import held, or named while it waited, reaches people now:
    // dated its approval.
    await t.run(DATE_APPROVED_SQL, [at, review.job_id, review.imported]);
    await t.run('UPDATE jobs SET held_since = NULL, updated_at = ? WHERE id = ? AND held_since IS NOT NULL', [at, review.job_id]);
    await projectJob(t, review.job_id);
    await offerBoard(deps, t, review.job_id, null, at);
  } else if (!read && captured) {
    followUps = await followUpsOfCapture(deps, t, review, captured, at); // v32 ADMINAPP (E6)
  } else {
    followUps = await followUpsOfRead(deps, t, review, read);
    if (review.page_host && read) await offerBoard(deps, t, read.sharedJobId, { kind: 'career_site', name: review.page_host }, at);
  }
  await markDecided(t, review, 'approved', decider, at);
  return followUps;
}

/** Rejects a pending review: nothing else changes. */
export async function rejectReview(t: DbTx, review: ReviewRow, decider: Decider, at: string): Promise<void> {
  if (review.state !== 'pending') throw conflict('This review was decided already.');
  await markDecided(t, review, 'rejected', decider, at);
}

/**
 * Brings a rejected or expired review back to the queue (its decision cleared, its note kept unless a new one is given);
 * 409 for any other state, or while a newer review of the same subject is open.
 */
export async function reopenReview(deps: AppDeps, t: DbTx, review: ReviewRow, note: string | null, now: Date): Promise<void> {
  if (review.state !== 'rejected' && review.state !== 'expired') {
    throw conflict('Only a rejected or expired review can be reopened.');
  }
  if (await pendingReview(t, review.kind, review.subject_key)) {
    throw conflict('A newer review of this job is open: decide that one.');
  }
  const at = now.toISOString();
  await t.run(
    `UPDATE job_reviews SET state = 'pending', decided_by = NULL, decided_by_user = NULL, decided_at = NULL,
       note = COALESCE(?, note), last_reported_at = GREATEST(last_reported_at, ?), updated_at = ? WHERE id = ?`,
    [note, at, at, review.id],
  );
  await recountReview(deps, t, review.id, now);
}

/** Runs an approval's follow-ups after its commit: each page job gives way to the shared copy (a failure is logged). */
export async function runFollowUps(deps: AppDeps, followUps: readonly FollowUp[]): Promise<void> {
  for (const followUp of [...followUps].sort((a, b) => a.userId.localeCompare(b.userId))) {
    try {
      // v32 FIX-API (SB-1): another reporter's version was published: theirs stays as it is, and they are told.
      if (followUp.publicVersion) {
        await noticeVerification(deps, { userId: followUp.userId, jobId: followUp.sharedJobId, state: 'published', publicVersion: true });
        continue;
      }
      // v32 ADMINAPP (E6): the reporter whose own page job was published itself gives way to nothing, and is told.
      const itself = followUp.approvedByAdmin === true && followUp.pageJobId === followUp.sharedJobId;
      const moved =
        itself || (await upgradeOwnPageJob(deps, followUp.userId, followUp.pageJobId, followUp.sharedJobId, { sameLink: followUp.sameLink === true }));
      // v31 LINK: the reporter hears that TailorIT read their job and published it (v32: or that an admin approved it).
      if (moved) {
        await noticeVerification(deps, {
          userId: followUp.userId,
          jobId: followUp.sharedJobId,
          state: 'published',
          ...(followUp.approvedByAdmin ? { approvedByAdmin: true } : {}),
        });
      }
    } catch (error) {
      deps.log.warn('[job-reviews] a page job could not give way to its published copy', error instanceof Error ? error.name : 'unknown');
    }
  }
}
