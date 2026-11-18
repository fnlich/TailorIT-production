import { canonicalJobUrl } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { readLink } from '../jobs/add/pipeline';
import type { PageReviewRead } from './decide';
import { reviewById } from './store';

// v31 LINK (D2, docs/design/v3.1/21-jobs-from-links.md §6): before a page review is approved, TailorIT reads its link
// itself (the review's subject: 'page:<link key>'), outside the approval's transaction, through the add pipeline's read
// (jobs/add/pipeline.ts readLink: the ATS's API, or the page's schema.org JobPosting). The shared job it stores is what
// the approval publishes; a page it cannot read leaves nothing to publish, and the approval is refused.

/** The shared job read from a pending page review's link; undefined for another review, or a link TailorIT cannot read. */
export async function readPageReviewLink(deps: AppDeps, reviewId: number): Promise<PageReviewRead | undefined> {
  const review = await reviewById(deps.db, reviewId);
  if (!review || review.kind !== 'new_job' || review.origin !== 'page' || review.state !== 'pending') return undefined;
  const url = canonicalJobUrl(review.subject_key.slice('page:'.length));
  if (!url) return undefined;
  // v31 FIX-LINK (D12): the admin approves the posting at this link: its page's new job is published, never held, and
  // read for real (never a held job's shortcut).
  const read = await readLink(deps, url, undefined, undefined, { approved: true, fresh: true });
  return read.kind === 'shared' ? { sharedJobId: read.jobId } : undefined;
}
