import { canonicalJobUrl, type JobVerifyReason, type ReviewRetryRead } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { conflict } from '../../core/http/errors';
import { sharedAddress } from '../jobs/add/address'; // v32 ADMINAPP (E6)
import { readLink } from '../jobs/add/pipeline';
import type { PageReviewRead } from './decide';
import { reviewById } from './store';

// v31 LINK (D2, docs/design/v3.1/21-jobs-from-links.md §6): before a page review is approved, TailorIT reads its link
// itself (the review's subject: 'page:<link key>'), outside the approval's transaction, through the add pipeline's read
// (jobs/add/pipeline.ts readLink: the ATS's API, or the page's schema.org JobPosting). The shared job it stores is what
// the approval publishes; a page it cannot read leaves nothing to publish, and the approval is refused.

/** A page review's link (its subject), canonical; null when it names none. */
export function pageReviewUrl(review: { subject_key: string }): string | null {
  return review.subject_key.startsWith('page:') ? canonicalJobUrl(review.subject_key.slice('page:'.length)) : null;
}

/** The shared job read from a pending page review's link; undefined for another review, or a link TailorIT cannot read. */
export async function readPageReviewLink(deps: AppDeps, reviewId: number): Promise<PageReviewRead | undefined> {
  return (await readPageReview(deps, reviewId)).read;
}

/**
 * readPageReviewLink, and v32 FIX-API (REV-SECBEH SB-6): why the link could not be read (`closed` for a posting gone),
 * null when it was read or is no pending page review's: an approval as captured is refused for a closed posting or an
 * opted-out company or site, as Couldn't verify's is.
 */
export async function readPageReview(deps: AppDeps, reviewId: number): Promise<{ read?: PageReviewRead; unread: JobVerifyReason | null }> {
  const review = await reviewById(deps.db, reviewId);
  if (!review || review.kind !== 'new_job' || review.origin !== 'page' || review.state !== 'pending') return { unread: null };
  const url = pageReviewUrl(review);
  if (!url) return { unread: null };
  // v31 FIX-LINK (D12): the admin approves the posting at this link: its page's new job is published, never held, and
  // read for real (never a held job's shortcut).
  const read = await readLink(deps, url, undefined, undefined, { approved: true, fresh: true });
  if (read.kind === 'shared') return { read: { sharedJobId: read.jobId }, unread: null };
  return { unread: read.kind === 'closed' ? 'closed' : read.reason };
}

/**
 * v32 ADMINAPP (E6): Retry read of a pending new job a read made (origin `ats`: an ATS's API or, under D12, a page's own
 * JobPosting): TailorIT reads the job's link again now, for real (`fresh`), and the store rewrites the job from it (its
 * keys find it); the job keeps waiting for the admin's decision. A posting gone answers `closed` (the admin rejects it),
 * a link not readable now its reason. Undefined for a review that is not there; 409 for any other review (a v3.0 page
 * review is read by its approval, a closed link's review has nothing to read again). Outside any transaction.
 */
export async function retryReviewRead(deps: AppDeps, reviewId: number): Promise<ReviewRetryRead | undefined> {
  const review = await reviewById(deps.db, reviewId);
  if (!review) return undefined;
  if (review.kind !== 'new_job' || review.origin !== 'ats' || review.state !== 'pending') {
    throw conflict('Only a new job waiting for approval can be read again.');
  }
  const job = await deps.db.one<{ apply_url: string }>('SELECT apply_url FROM jobs WHERE id = ?', [review.job_id]);
  const url = sharedAddress(job?.apply_url ?? null);
  if (!url) return { state: 'unreadable', jobId: review.job_id, reason: 'invalid_link' };
  const read = await readLink(deps, url, undefined, undefined, { fresh: true });
  if (read.kind === 'shared') return { state: 'read', jobId: read.jobId, reason: null };
  if (read.kind === 'closed') return { state: 'closed', jobId: review.job_id, reason: 'closed' };
  return { state: 'unreadable', jobId: review.job_id, reason: read.reason };
}
