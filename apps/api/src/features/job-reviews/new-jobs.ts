import { createHash } from 'node:crypto';
import { JOB_REVIEW_SUBJECT_MAX, jobReviewSubject, linkKey, pageReviewSubject } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import { dayKeyAt } from '../../core/constants/day';
import type { AppDeps } from '../../core/context';
import type { DbQueries, DbTx } from '../../core/db/types';
import { projectJob } from '../../core/seams';
import { readJobText } from '../jobs/text';
import { autoDecide } from './auto';
import { runFollowUps, type FollowUp } from './decide';
import { isRefusedPageHost, normalHost } from './hosts';
import { openReview, recountReview, upsertReport } from './store';
import { REVIEW_HELD_SQL } from '../jobs/add/review-held'; // v31 FIX-LINK

// v30 X1-API: new jobs from the extension (docs/design/part2/14-extension-reports.md §4, §5.2, §5.3).
// - A posting TailorIT reads from an ATS for the first time is HELD (holdNewJob, in the store's transaction; v31 LINK:
//   only while NEW_JOBS_ADMIN_APPROVAL is on, v3.0 held every posting of a board no enabled source runs): `jobs.held_since` set, out of every search at once (projectJob), and its `new_job`
//   review (origin `ats`, subject 'job:<id>') opened. Each account that adds it then writes its report row (via `add`)
//   BEFORE its tracker entry (noteHeldAdd, from saveToTracker): the held rule (jobs/visibility.ts) shows a held job to
//   its adders alone, through that row or their tracker. A later add of a rejected job bumps the rejected review without
//   reopening it; the job stays held.
// - v31 LINK: no add path opens a page review any more (a page job is "Couldn't verify", jobs/add/verification.ts, and
//   only TailorIT's own read of its link is ever published: job-reviews/page-read.ts); queuePageJob stays for the page
//   reviews v3.0 opened and their tests. In v3.0:
//   A job made from a page's text stays the account's own; it is queued (queuePageJob) only from an employer's own page
//   (an ATS's or a site's, https, never LinkedIn or a refused job board), its company not opted out, while
//   EXT_NEW_PAGE_JOBS_REVIEW is on. Page jobs of one posting from several accounts merge into one review, keyed by the
//   posting's stored address ('page:<linkKey>'), each account's page job and the hash of its normalised text on its row.
// - A later add of a published page job (`ext_page`) counts as a sighting: last verified now (sightPublishedPageJob).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/**
 * Holds a job the store made now from an ATS posting no enabled source runs, and opens its review, in the store's
 * transaction (so a held job always has its review). A job with an owner, or held already, changes nothing.
 */
export async function holdNewJob(t: DbTx, jobId: number, at: string): Promise<void> {
  const { changes } = await t.run('UPDATE jobs SET held_since = ?, updated_at = ? WHERE id = ? AND held_since IS NULL AND owner_user_id IS NULL', [
    at,
    at,
    jobId,
  ]);
  if (changes === 0) return;
  await projectJob(t, jobId);
  await openReview(t, { kind: 'new_job', subjectKey: jobReviewSubject(jobId), jobId, origin: 'ats', at });
}

/**
 * The review a held job's (or a page posting's) next add goes on: its pending review, else its latest review when that
 * was rejected (bumped, not reopened), else a new pending one. Answers its id, row locked.
 */
async function reviewForAdd(
  t: DbTx,
  subjectKey: string,
  open: { jobId: number; origin: 'ats' | 'page'; pageHost?: string | null },
  at: string,
): Promise<{ id: number; pending: boolean }> {
  const latest = await t.one<{ id: number; state: string }>(
    "SELECT id, state FROM job_reviews WHERE kind = 'new_job' AND subject_key = ? ORDER BY (state = 'pending') DESC, id DESC LIMIT 1",
    [subjectKey],
  );
  if (latest?.state === 'rejected') {
    await t.run('UPDATE job_reviews SET last_reported_at = GREATEST(last_reported_at, ?), updated_at = ? WHERE id = ?', [at, at, latest.id]);
    await t.one('SELECT id FROM job_reviews WHERE id = ? FOR UPDATE', [latest.id]);
    return { id: latest.id, pending: false };
  }
  const id = await openReview(t, { kind: 'new_job', subjectKey, jobId: open.jobId, origin: open.origin, pageHost: open.pageHost ?? null, at });
  return { id, pending: true };
}

/**
 * The account's add of a held job (Add job, From page's ATS read, Applied): its report row (via `add`) on the job's
 * review, written before its tracker entry, then the automatic rule of new ATS jobs. Nothing for a job that is not held.
 * Behind the account's lock, as its tracker entry is.
 */
export async function noteHeldAdd(deps: AppDeps, userId: string, jobId: number): Promise<void> {
  // v31 FIX-LINK: a job the legacy pass holds (no review holds it: jobs/add/held.ts) is no new job to review: an add of
  // it opens no review (an approval would publish the row's or the browser's words); its own read settles it.
  const held = await deps.db.one(
    `SELECT 1 FROM jobs j WHERE j.id = ? AND j.owner_user_id IS NULL AND j.held_since IS NOT NULL AND ${REVIEW_HELD_SQL}`,
    [jobId],
  );
  if (!held) return;
  const now = deps.now();
  const at = now.toISOString();
  const followUps = await deps.db.tx(
    async (t): Promise<FollowUp[]> => {
      await t.lockPerson(userId);
      const still = await t.one(
        `SELECT 1 FROM jobs j WHERE j.id = ? AND j.owner_user_id IS NULL AND j.held_since IS NOT NULL AND ${REVIEW_HELD_SQL}`,
        [jobId],
      );
      if (!still) return [];
      const review = await reviewForAdd(t, jobReviewSubject(jobId), { jobId, origin: 'ats' }, at);
      await upsertReport(t, review.id, userId, { via: 'add', seenAt: at, dayKey: dayKeyAt(deps, now), at });
      const tally = await recountReview(deps, t, review.id, now);
      return review.pending ? autoDecide(deps, t, review.id, tally, now) : [];
    },
    { label: 'held job add' },
  );
  await runFollowUps(deps, followUps);
}

/** The hash a page job's text agreement compares: its plain text, lower case, each run of white space one space. */
export function pageTextHash(text: string): Buffer {
  return createHash('sha256').update(text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim(), 'utf8').digest();
}

/** The host of an https address, or null. */
function httpsHost(address: string): string | null {
  try {
    const url = new URL(address.trim());
    return url.protocol === 'https:' ? normalHost(url.hostname) : null;
  } catch {
    return null;
  }
}

/** Whether a domain of the host (it or a parent with two labels or more) is on crawl_opt_outs. */
async function hostOptedOut(db: DbQueries, host: string): Promise<boolean> {
  const labels = host.split('.');
  const domains: string[] = [];
  for (let at = 0; at <= labels.length - 2; at += 1) domains.push(labels.slice(at).join('.'));
  const row = await db.one(`SELECT 1 FROM crawl_opt_outs WHERE domain IN (SELECT value FROM ${db.dialect.jsonEach('?')})`, [
    JSON.stringify(domains),
  ]);
  return row !== undefined;
}

export interface PageJobQueue {
  /** The page the text was read from (the request's address). */
  pageUrl: string;
  /** What the lookup reads the page as (lookup.ts pageOf's kind). */
  pageKind: 'linkedin' | 'ats' | 'site';
}

/**
 * Queues the account's own page job for review when its page is an employer's own (see above). Answers whether it was
 * queued (or its row updated). A failure here never fails the add (the caller logs it).
 */
export async function queuePageJob(deps: AppDeps, userId: string, jobId: number, page: PageJobQueue): Promise<boolean> {
  if (!constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW')) return false;
  if (page.pageKind === 'linkedin') return false;
  const pageHost = httpsHost(page.pageUrl);
  if (!pageHost || isRefusedPageHost(pageHost)) return false;
  const job = await deps.db.one<{ apply_url: string; active: boolean; do_not_fetch: boolean }>(
    `SELECT j.apply_url, j.active, c.do_not_fetch FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.id = ? AND j.owner_user_id = ? AND j.superseded_by IS NULL`,
    [jobId, userId],
  );
  if (!job || !job.active || job.do_not_fetch === true) return false;
  const applyHost = httpsHost(job.apply_url);
  if (!applyHost || isRefusedPageHost(applyHost)) return false;
  if ((await hostOptedOut(deps.db, pageHost)) || (await hostOptedOut(deps.db, applyHost))) return false;
  const key = linkKey(job.apply_url);
  if (!key) return false;
  const subjectKey = pageReviewSubject(key);
  if (subjectKey.length > JOB_REVIEW_SUBJECT_MAX) return false;
  const text = await readJobText(deps.db, jobId);
  if (!text) return false;
  const textHash = pageTextHash(text.text);
  const now = deps.now();
  const at = now.toISOString();
  const followUps = await deps.db.tx(
    async (t): Promise<FollowUp[]> => {
      await t.lockPerson(userId);
      const review = await reviewForAdd(t, subjectKey, { jobId, origin: 'page', pageHost }, at);
      await upsertReport(t, review.id, userId, { via: 'add', pageJobId: jobId, textHash, seenAt: at, dayKey: dayKeyAt(deps, now), at });
      const tally = await recountReview(deps, t, review.id, now);
      return review.pending ? autoDecide(deps, t, review.id, tally, now) : [];
    },
    { label: 'page job review' },
  );
  await runFollowUps(deps, followUps);
  return true;
}

/**
 * A later add of a published page job (a live `ext_page` link) is a sighting (14 §5.3 step 4): last verified now, and
 * back in search if the unverified sweep had taken it out. Answers whether it was one.
 */
export async function sightPublishedPageJob(deps: Deps, jobId: number): Promise<boolean> {
  const at = deps.now().toISOString();
  return deps.db.tx(
    async (t) => {
      const { changes } = await t.run(
        `UPDATE jobs SET last_verified_at = ?, unverified_since = NULL, updated_at = ? WHERE id = ? AND owner_user_id IS NULL
           AND EXISTS (SELECT 1 FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
                       WHERE l.job_id = jobs.id AND s.kind = 'ext_page' AND l.missing_since IS NULL)`,
        [at, at, jobId],
      );
      if (changes === 0) return false;
      // Back in search when the unverified sweep had taken it out (a no-op for a row already there).
      await projectJob(t, jobId);
      return true;
    },
    { label: 'published page job sighting' },
  );
}
