import type { AppDeps } from '../../../core/context';
import { queuePageJob } from '../../job-reviews/new-jobs';
import { readPage, type PageReading } from '../lookup';

// The job lake (TailorIT v1.3, decision 1): TailorIT's shared jobs. A person who submits an application for a job only
// they have (one they added from a page's text, migration 0809: jobs.owner_user_id) offers it to the lake: on a
// submission the site confirmed (POST /api/autofill/submissions), never on an add without applying.
//
// v30 INT-3 (the coordinator's decision on X1-API's open item 1; the owner's rule that nothing reaches the shared lake
// before an admin's approval or an automatic rule): the offer goes through Admin › Review exactly as adding the job from
// the page does (job-reviews/new-jobs.ts queuePageJob, 14 §5.3): the posting's page review is opened or joined with this
// account's report, and the job stays the person's own. Nothing is shared here: when an admin approves the review (or
// its automatic rule does), one shared copy is published through the ingest store (the `ext_page` source) and every
// reporting account's page job gives way to it (autofill/jobs.ts upgradeOwnPageJob: entries, aliases). The form's
// questions, kept under the posting's key for a page job (forms/store.ts formPlace), are the published job's from then
// on. queuePageJob's own rules decide what is offered: never a LinkedIn page or a refused job board, an https employer
// page only, a company that did not opt out, and only while EXT_NEW_PAGE_JOBS_REVIEW is on.

/** Whether the job is `userId`'s own, made from a page (and so not in the lake yet). */
export async function isOwnJob(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number): Promise<boolean> {
  return (await deps.db.one('SELECT 1 FROM jobs WHERE id = ? AND owner_user_id = ?', [jobId, userId])) !== undefined;
}

/**
 * Offers `userId`'s own page job to the lake through its page review (see above); true when it was theirs and the
 * review holds their report now (`offered` in the submission's answer), false otherwise. `page` is the submission's page
 * (the job's own address when the submission named the job by its id). Never throws for the review
 * step: a failure is logged without the job or the page, and the submission stands.
 */
export async function shareOwnJob(
  deps: AppDeps,
  userId: string,
  jobId: number,
  page: Pick<PageReading, 'url' | 'ats' | 'linkedIn'>,
): Promise<boolean> {
  const job = await deps.db.one<{ apply_url: string }>('SELECT apply_url FROM jobs WHERE id = ? AND owner_user_id = ?', [jobId, userId]);
  if (!job) return false;
  // A submission named by the job's id (the agent's, the panel's) has no page address: the job's own is its page.
  const shown = /^https:\/\//i.test(page.url) ? page : readPage(job.apply_url);
  try {
    return await queuePageJob(deps, userId, jobId, { pageUrl: shown.url, pageKind: shown.linkedIn ? 'linkedin' : shown.ats ? 'ats' : 'site' });
  } catch (error) {
    deps.log.warn('[autofill] a submission could not offer its page job for review', error instanceof Error ? error.name : 'unknown');
    return false;
  }
}
