import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types';
import { companyOf, likelyDuplicates } from './checks';
import { queueCheck, settleReviewsOfClosedJob } from './closed'; // v31 LINK; v37 INT-A: settleReviewsOfClosedJob
import { approveReview, rejectReview, type FollowUp } from './decide';
import { reviewById, type ReviewTally } from './store';
import { ADDED_BY_AUTOFILL, ROW_SOURCE_KINDS } from '../ingest/types'; // v31 FIX-LINK (D12)

// v30 X1-API: the automatic rules (docs/design/part2/14-extension-reports.md §5.1 step 4, §5.2 step 6, §5.3 step 5,
// §7), each behind its admin constant, all off by default:
// - a closed link (EXT_AUTO_APPROVE_CLOSED): where TailorIT's re-check could read the posting, its answer decides
//   (`gone` approves, `live` rejects: decided by `server_check`); where it could not (`unreadable`, `not_possible`), at
//   least EXT_AUTO_CLOSE_MIN_REPORTERS distinct trusted accounts within EXT_REPORT_WINDOW_DAYS, one of them with a strong
//   signal or a person's own word, approve it (`auto`). Weak signals count toward the number, never alone. While the
//   check is queued (or none was made) nothing is decided. v37 CLOSED (SP v37 PLAN.md C6): a `gone` re-check approves
//   the report whatever the switch says (TailorIT's own read confirmed it: the job closes, decided by `server_check`
//   with MSG_REVIEW_CLOSED_CONFIRMED, under Decided); the switch still decides the `live` rejection and the reporters'
//   rule, and unconfirmed reports wait for an admin as before;
// - a new job read from an ATS (EXT_AUTO_APPROVE_NEW_ATS; held only while NEW_JOBS_ADMIN_APPROVAL is on, v31 LINK):
//   approved once TailorIT read the posting again itself (v31 LINK: the re-check queue's `live`, queued by the rule)
//   and its checks pass: still open, its company not opted out, no likely duplicate; otherwise it stays for the admin;
// - a new job from pages (EXT_AUTO_APPROVE_NEW_PAGE): v31 LINK (D2) never approved by the rule: only TailorIT's own
//   read of the page may be published, and that read is made outside a transaction, by an admin's approval
//   (page-read.ts). v3.0 approved the text two accounts' browsers agreed on (behind SITE_READER_CAREER_PAGES).
// An untrusted account (new, disabled, or with its reports keep being rejected) never counts (trust.ts).
//
// v31 FIX-LINK (decision D12): a held new job TailorIT read from a page's own JobPosting (no ATS API: Add job's source
// of the page's host) waits for an admin whatever EXT_AUTO_APPROVE_NEW_ATS says: only PAGE_JOBS_AUTO_PUBLISH publishes
// page jobs without one, and it does so at the read (jobs/add/page.ts).

/** v31 FIX-LINK (D12): the job has a live link of a source an ATS's API (or a feed) reads, not only page reads and rows. */
const READ_BY_API_SQL = `SELECT 1 AS found FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
  WHERE l.job_id = ? AND l.missing_since IS NULL AND s.kind NOT IN (${[...ROW_SOURCE_KINDS, 'page'].map((kind) => `'${kind}'`).join(', ')})
    AND NOT (s.kind = 'career_site' AND NOT s.enabled AND s.config ->> 'addedBy' = ?) LIMIT 1`;

/**
 * Applies the automatic rules to a pending review, in the caller's transaction (its row locked): approves or rejects
 * it when a rule decides; answers an approval's follow-ups (nothing when nothing was decided).
 */
export async function autoDecide(deps: AppDeps, t: DbTx, reviewId: number, tally: ReviewTally, now: Date): Promise<FollowUp[]> {
  const review = await reviewById(t, reviewId, true);
  if (!review || review.state !== 'pending') return [];
  const constants = constantsOf(deps);
  const at = now.toISOString();
  if (review.kind === 'closed') {
    // v37 CLOSED (C6): confirmed gone by TailorIT's own read: closed and decided by the server, switch or not.
    if (review.check_state === 'gone') {
      const followUps = await approveReview(deps, t, review, { by: 'server_check', userId: null, note: constants.message('MSG_REVIEW_CLOSED_CONFIRMED') }, at);
      // v37 INT-A (C2/C6 with REVIEW's counts): the job it closed leaves every lane, as an import's close does: its New
      // jobs review and other closed reports decided by the server, its notes with no adder gone (closed.ts).
      const job = await t.one<{ active: boolean }>('SELECT active FROM jobs WHERE id = ?', [review.job_id]);
      if (job && !job.active) await settleReviewsOfClosedJob(deps, t, review.job_id, at);
      return followUps;
    }
    if (!constants.get('EXT_AUTO_APPROVE_CLOSED')) return [];
    if (review.check_state === 'live') {
      await rejectReview(t, review, { by: 'server_check', userId: null }, at);
      return [];
    }
    if (review.check_state !== 'unreadable' && review.check_state !== 'not_possible') return [];
    if (tally.trustedReporters >= constants.get('EXT_AUTO_CLOSE_MIN_REPORTERS') && tally.trustedStrongOrPerson) {
      return approveReview(deps, t, review, { by: 'auto', userId: null }, at);
    }
    return [];
  }
  if (review.origin === 'ats') {
    if (!constants.get('EXT_AUTO_APPROVE_NEW_ATS')) return [];
    // v31 LINK: approved only on TailorIT's own fresh read of the posting (the re-check queue's `live`, recheckPosting):
    // a review that has none queues one here, and the rule decides once it answered.
    // D12: a page job is an admin's to approve.
    if (!(await t.one(READ_BY_API_SQL, [review.job_id, ADDED_BY_AUTOFILL]))) return [];
    if (review.check_state !== 'live') {
      if (review.check_state === 'none') await queueCheck(t, review.id, review.job_id, now);
      return [];
    }
    const job = await t.one<{ active: boolean; held: boolean }>('SELECT active, held_since IS NOT NULL AS held FROM jobs WHERE id = ?', [
      review.job_id,
    ]);
    const company = await companyOf(t, review.job_id);
    if (!job?.active || !job.held || !company || company.doNotFetch) return [];
    if ((await likelyDuplicates(deps, t, review.job_id)).length > 0) return [];
    return approveReview(deps, t, review, { by: 'auto', userId: null }, at);
  }
  // v31 LINK (D2): a page review is approved only with TailorIT's own read of its link, made outside a transaction
  // (an admin's approval makes it: page-read.ts): the automatic rule never publishes what browsers captured, however
  // many accounts agree (EXT_AUTO_APPROVE_NEW_PAGE, EXT_AUTO_NEW_PAGE_MIN_ACCOUNTS and SITE_READER_CAREER_PAGES are
  // read here only to say so in the log of a sweep that has them on).
  if (constants.get('EXT_AUTO_APPROVE_NEW_PAGE') && constants.get('SITE_READER_CAREER_PAGES') && tally.agreeing >= constants.get('EXT_AUTO_NEW_PAGE_MIN_ACCOUNTS')) {
    deps.log.debug(`[job-reviews] page review ${review.id}: waits for an admin's approval (TailorIT reads the page then)`);
  }
  return [];
}
