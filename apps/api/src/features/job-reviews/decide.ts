import type { JobReviewDecider } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbQueries, DbTx } from '../../core/db/types';
import { AppError, conflict } from '../../core/http/errors';
import { closeLink, offerToDiscovery, projectJob, type JobLinkRef } from '../../core/seams';
import { upgradeOwnPageJob } from '../autofill/jobs';
import { firstSourceOfKind, insertSourceIfNameFree } from '../autofill/sources';
import { boardOfUrl } from '../ingest/discovery/boards';
import { sourceHashOf, storedSourceJobId } from '../ingest/normalize';
import { requireIngest } from '../ingest/service';
import type { RawPosting, SourceRecord } from '../ingest/types';
import { readJobText } from '../jobs/text';
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
// - a new job from pages is published as a shared copy (§5.3): a new job with no owner under the one `ext_page` source,
//   made through the ingest pipeline (its company, places, analysis, facts, keys and search row as any posting's) from
//   the page job whose normalised text most accounts share, verified now; the page's host offered to discovery as a
//   career site. After the commit each reporting account's page job gives way to it (upgradeOwnPageJob: its tracker
//   entry, aliases, queue rows and marks move; the page job closes, superseded): the follow-ups.
// A rejection changes nothing else (a held job stays its adders' own; a page job its account's). A reopen brings a
// rejected or expired review back to the queue.

/** Who decides: an admin (with their account), the automatic rules, or TailorIT's own check. */
export interface Decider {
  by: Exclude<JobReviewDecider, 'source'>;
  userId: string | null;
  note?: string | null;
}

/** Work an approval leaves for after its commit: a page job giving way to the shared copy published now. */
export interface FollowUp {
  userId: string;
  pageJobId: number;
  sharedJobId: number;
}

/** The one source the published page jobs are kept under: never run, checked or closed by a run. */
export const PUBLISHED_PAGE_SOURCE_NAME = 'Published page jobs';

async function publishedPageSource(t: DbTx, at: string): Promise<SourceRecord> {
  const found = await firstSourceOfKind(t, 'ext_page');
  if (found) return found;
  const made = await insertSourceIfNameFree(
    t,
    { kind: 'ext_page', name: PUBLISHED_PAGE_SOURCE_NAME, config: {}, enabled: false, deactivateMissing: false },
    at,
  );
  const source = made ?? (await firstSourceOfKind(t, 'ext_page'));
  if (!source) throw new AppError('internal', 'TailorIT could not publish this job. Please try again.');
  return source;
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

/** Publishes a page review's posting as a shared job (see above); answers the shared job's id and the follow-ups. */
async function publishPageJob(deps: AppDeps, t: DbTx, review: ReviewRow, at: string): Promise<FollowUp[]> {
  const { chosen, reports } = await pageJobsOf(t, review.id);
  if (chosen === null) throw conflict('No page job of this review is left to publish.');
  const page = await t.one<{ title: string; apply_url: string; company: string; industry: string | null }>(
    'SELECT j.title, j.apply_url, c.name AS company, j.industry FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?',
    [chosen],
  );
  const text = await readJobText(t, chosen);
  if (!page || !text) throw conflict('No page job of this review is left to publish.');
  const places = await t.all<{ raw: string }>('SELECT raw FROM job_locations WHERE job_id = ? ORDER BY position', [chosen]);
  const source = await publishedPageSource(t, at);
  const raw: RawPosting = {
    // The posting's stored address, as the review's subject keys it (the same for every account's page job of it).
    sourceJobId: review.subject_key.slice('page:'.length),
    title: page.title,
    company: { name: page.company },
    descriptionHtml: text.html,
    url: page.apply_url,
    locations: places.map((place) => place.raw),
    industry: page.industry,
    // An admin (or two accounts' agreeing captures) confirmed it now: last_verified_at = now (12 §8.3's clock).
    verified: true,
  };
  const outcome = await requireIngest(deps).store.upsertBatch(source, [{ raw, sourceHash: sourceHashOf(raw) }], at);
  const link = await t.one<{ job_id: number }>('SELECT job_id FROM job_source_links WHERE source_id = ? AND source_job_id = ?', [
    source.id,
    storedSourceJobId(raw.sourceJobId),
  ]);
  if (outcome.failures.length > 0 || !link) throw new AppError('internal', 'TailorIT could not publish this job. Please try again.');
  return reports.map((report) => ({ ...report, sharedJobId: link.job_id }));
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

/** Approves a pending review (see above), in the caller's transaction; answers the follow-ups for after the commit. */
export async function approveReview(deps: AppDeps, t: DbTx, review: ReviewRow, decider: Decider, at: string): Promise<FollowUp[]> {
  if (review.state !== 'pending') throw conflict('This review was decided already.');
  let followUps: FollowUp[] = [];
  if (review.kind === 'closed') {
    const link: JobLinkRef | undefined =
      review.link_source_id !== null && review.link_source_job_id !== null
        ? { sourceId: review.link_source_id, sourceJobId: review.link_source_job_id }
        : undefined;
    await closeLink(deps, t, { jobId: review.job_id, ...(link ? { link } : {}), reason: 'report', at });
  } else if (review.origin === 'ats') {
    await t.run('UPDATE jobs SET held_since = NULL, updated_at = ? WHERE id = ? AND held_since IS NOT NULL', [at, review.job_id]);
    await projectJob(t, review.job_id);
    await offerBoard(deps, t, review.job_id, null, at);
  } else {
    followUps = await publishPageJob(deps, t, review, at);
    if (review.page_host) await offerBoard(deps, t, followUps[0]!.sharedJobId, { kind: 'career_site', name: review.page_host }, at);
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
      await upgradeOwnPageJob(deps, followUp.userId, followUp.pageJobId, followUp.sharedJobId);
    } catch (error) {
      deps.log.warn('[job-reviews] a page job could not give way to its published copy', error instanceof Error ? error.name : 'unknown');
    }
  }
}
