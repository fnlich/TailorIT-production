import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types';
import { companyOf, likelyDuplicates } from './checks';
import { approveReview, rejectReview, type FollowUp } from './decide';
import { reviewById, type ReviewTally } from './store';

// v30 X1-API: the automatic rules (docs/design/part2/14-extension-reports.md §5.1 step 4, §5.2 step 6, §5.3 step 5,
// §7), each behind its admin constant, all off by default:
// - a closed link (EXT_AUTO_APPROVE_CLOSED): where TailorIT's re-check could read the posting, its answer decides
//   (`gone` approves, `live` rejects: decided by `server_check`); where it could not (`unreadable`, `not_possible`), at
//   least EXT_AUTO_CLOSE_MIN_REPORTERS distinct trusted accounts within EXT_REPORT_WINDOW_DAYS, one of them with a strong
//   signal or a person's own word, approve it (`auto`). Weak signals count toward the number, never alone. While the
//   check is queued (or none was made) nothing is decided;
// - a new job read from an ATS (EXT_AUTO_APPROVE_NEW_ATS): approved once its checks pass: still open, its company not
//   opted out, no likely duplicate; otherwise it stays for the admin;
// - a new job from pages (EXT_AUTO_APPROVE_NEW_PAGE, off until the lawyer's view): approved once
//   EXT_AUTO_NEW_PAGE_MIN_ACCOUNTS distinct trusted accounts captured the same normalised text, its company not opted out.
//   v30 FIX-B (SEC-10, DECISIONS P6.8): never while SITE_READER_CAREER_PAGES is off: the text is only what the
//   extension sent (two throwaway accounts can agree on invented text), so publishing one needs TailorIT's own read of
//   the page, which waits for the lawyer's view. The admin decides such a review by hand.
// An untrusted account (new, disabled, or with its reports keep being rejected) never counts (trust.ts).

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
    if (!constants.get('EXT_AUTO_APPROVE_CLOSED')) return [];
    if (review.check_state === 'gone') return approveReview(deps, t, review, { by: 'server_check', userId: null }, at);
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
    const job = await t.one<{ active: boolean; held: boolean }>('SELECT active, held_since IS NOT NULL AS held FROM jobs WHERE id = ?', [
      review.job_id,
    ]);
    const company = await companyOf(t, review.job_id);
    if (!job?.active || !job.held || !company || company.doNotFetch) return [];
    if ((await likelyDuplicates(deps, t, review.job_id)).length > 0) return [];
    return approveReview(deps, t, review, { by: 'auto', userId: null }, at);
  }
  if (!constants.get('EXT_AUTO_APPROVE_NEW_PAGE') || !constants.get('SITE_READER_CAREER_PAGES')) return [];
  const company = await companyOf(t, review.job_id);
  if (company?.doNotFetch) return [];
  if (tally.agreeing < constants.get('EXT_AUTO_NEW_PAGE_MIN_ACCOUNTS')) return [];
  return approveReview(deps, t, review, { by: 'auto', userId: null }, at);
}
