import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import { isRefusedPageHost } from '../../job-reviews/hosts';
import { noteUnverified } from '../../jobs/add/verification';
import { readPage, type PageReading } from '../lookup';

// The job lake (TailorIT v1.3, decision 1): TailorIT's shared jobs. A person who submits an application for a job only
// they have (one they added from a page's text, migration 0809: jobs.owner_user_id) offers it to the lake: on a
// submission the site confirmed (POST /api/autofill/submissions), never on an add without applying.
//
// v31 LINK (D2, docs/design/v3.1/21-jobs-from-links.md §6): the lake takes only what TailorIT read itself from a job's
// link, so the offer is Admin › Review's "Couldn't verify" list (jobs/add/verification.ts): the job's row there is made
// (or kept), and an admin's Retry read reads the link; when TailorIT can read it, the shared job takes the place of
// every adder's own (upgradeOwnPageJob). The text the person's browser captured is never published (v3.0's page
// review, approved into an `ext_page` copy, is gone). What is offered: never a LinkedIn page or a refused job board,
// a link an admin did not reject, and only while EXT_NEW_PAGE_JOBS_REVIEW is on.

/** Whether the job is `userId`'s own, made from a page (and so not in the lake yet). */
export async function isOwnJob(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number): Promise<boolean> {
  return (await deps.db.one('SELECT 1 FROM jobs WHERE id = ? AND owner_user_id = ?', [jobId, userId])) !== undefined;
}

/**
 * Offers `userId`'s own page job to the lake through the "Couldn't verify" list (see above); true when it was theirs
 * and an admin sees it there now (`offered` in the submission's answer), false otherwise. `page` is the submission's
 * page (the job's own address when the submission named the job by its id). Never throws: a failure is logged without
 * the job or the page, and the submission stands.
 */
export async function shareOwnJob(
  deps: AppDeps,
  userId: string,
  jobId: number,
  page: Pick<PageReading, 'url' | 'ats' | 'linkedIn'>,
): Promise<boolean> {
  try {
    const job = await deps.db.one<{ apply_url: string }>('SELECT apply_url FROM jobs WHERE id = ? AND owner_user_id = ?', [jobId, userId]);
    if (!job || !constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW')) return false;
    // A submission named by the job's id (the agent's, the panel's) has no page address: the job's own is its page.
    const shown = /^https:\/\//i.test(page.url) ? page : readPage(job.apply_url);
    if (shown.linkedIn || isRefusedPageHost(new URL(shown.url).hostname)) return false;
    // v32 FIX-API (REV-SECBEH SB-2): the note names the job's own Apply link (what an approval would publish), never the
    // submission page's address; a job whose Apply link is a site TailorIT never reads is not offered.
    const own = readPage(job.apply_url);
    if (own.linkedIn || !/^https:\/\//i.test(own.url) || isRefusedPageHost(new URL(own.url).hostname)) return false;
    const kept = await deps.db.one<{ reason: string }>('SELECT reason FROM job_verifications WHERE job_id = ?', [jobId]);
    if (!kept) {
      // A page job kept before v3.1 has no row yet: why its link was not read is not known, so "try again".
      await noteUnverified(deps.db, { jobId, userId, url: job.apply_url, origin: 'applied', reason: 'unavailable' }, nowIso(deps));
    }
    const row = await deps.db.one<{ reason: string; rejected: boolean }>(
      `SELECT v.reason, EXISTS (SELECT 1 FROM job_link_rejections r WHERE r.url_key = v.url_key) AS rejected
       FROM job_verifications v WHERE v.job_id = ?`,
      [jobId],
    );
    return row !== undefined && row.reason !== 'unreadable_host' && !row.rejected;
  } catch (error) {
    deps.log.warn('[autofill] a submission could not offer its page job for review', error instanceof Error ? error.name : 'unknown');
    return false;
  }
}
