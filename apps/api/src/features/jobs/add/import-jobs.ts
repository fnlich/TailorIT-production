import { htmlToText, linkKey, type JobRowDetails, type JobVerifyReason } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { closeLink, projectJob } from '../../../core/seams';
import { payFromRate, salaryFromText, sourceHashOf, storedSourceJobId } from '../../ingest/normalize';
import { rowIdOf } from '../../ingest/tabular';
import { requireIngest } from '../../ingest/service';
import type { RawPosting, SourceRecord } from '../../ingest/types';
import { noteUnverified } from './verification';

// v35 IMPORT (SP v35 PLAN.md H2, H4, H5): what an import does to jobs, each in one transaction with the job's search
// row (projectJob):
//   - fillPayFromRate (H4): the row's Rate as the job's pay when the job has none (a read's pay field and its
//     description come first; a job made from a row reads its description first, then its Rate);
//   - repostJob (H5): jobs.reposted_at = now, the job re-projected (search counts from the later of its date and this);
//     its posted date is kept;
//   - closeGoneJob (H5): a job TailorIT had whose posting is gone now (its links closed, `gone`);
//   - jobFromRow (H2.3): an admin import's row TailorIT could not read, with a title and a company: a shared job made
//     from the row under the import's source, HELD (out of search, no review: legacy-like, so Review › Couldn't verify
//     lists it through its note with no adder, origin `import`) and kept out of the AI job analysis until approved
//     (jobs.ai_input false: nothing is spent on a job an admin rejects);
//   - holdImported (H5): a closed job an admin import names that TailorIT cannot read now: reopened HELD with the same
//     note, so an approval publishes (and reposts) it (v35 FIX-PIPE: in the caller's transaction; also a held job no
//     review waits on any more, back in Couldn't verify: import-pipeline.ts, data D4);
//   - fillReadPosting (v35 INT-A, H2 "a row's own fields only fill what the read lacks"): an admin row's title, company,
//     description and location in the read's raw posting where it has none, before the store (the read's own always
//     win; pay follows H4 through fillPayFromRate after the read). A person's row never reaches a shared job.

/** The country of a job's first place (a salary's currency when its text names none). */
async function countryOf(db: DbQueries, jobId: number): Promise<string | null> {
  const row = await db.one<{ country_code: string | null }>(
    'SELECT country_code FROM job_locations WHERE job_id = ? AND country_code IS NOT NULL ORDER BY position LIMIT 1',
    [jobId],
  );
  return row?.country_code ?? null;
}

/**
 * H4: the Rate as the job's pay when the job has no amount of pay; nothing otherwise. Answers whether it wrote. In the
 * caller's transaction. v35 FIX-PIPE (data D7): only a Rate that names an amount is pay ("DOE", "Competitive" are
 * never written), and a job whose pay has words but no amount ("Competitive") takes it: "no pay" is no amount.
 */
export async function fillPayFromRate(t: DbQueries, jobId: number, rate: string | null | undefined, at: string): Promise<boolean> {
  if (!rate?.trim()) return false;
  const salary = payFromRate(rate, await countryOf(t, jobId));
  if (!salary || (salary.min === null && salary.max === null)) return false;
  const { changes } = await t.run(
    `UPDATE jobs SET salary_min = ?, salary_max = ?, salary_currency = ?, salary_period = ?, salary_annual_usd_min = ?,
       salary_annual_usd_max = ?, salary_raw = ?, updated_at = ?
     WHERE id = ? AND salary_min IS NULL AND salary_max IS NULL`,
    [salary.min, salary.max, salary.currency, salary.period, salary.annualUsdMin, salary.annualUsdMax, salary.raw, at, jobId],
  );
  if (changes > 0) await projectJob(t, jobId);
  return changes > 0;
}

/**
 * v35 INT-A (H2): the read's raw posting with an admin row's fields where the read has none: its title or company (a
 * read names both today), its description (no text at all: the row's, as plain text with its paragraphs), its places
 * (none: the row's location). Everything the read has is kept as read.
 */
export function fillReadPosting(raw: RawPosting, details: JobRowDetails): RawPosting {
  const filled: RawPosting = { ...raw };
  if (!raw.title?.trim() && details.title) filled.title = details.title;
  if (!raw.company?.name?.trim() && details.company) filled.company = { ...raw.company, name: details.company };
  const described = Boolean(raw.descriptionText?.trim()) || Boolean(raw.descriptionHtml && htmlToText(raw.descriptionHtml).trim());
  if (!described && details.description) {
    filled.descriptionText = details.description;
    filled.descriptionHtml = null;
  }
  const placed = (raw.locations ?? []).some((place) => typeof place === 'string' && place.trim() !== '') || (raw.places ?? []).length > 0;
  if (!placed && details.location) filled.locations = [details.location];
  return filled;
}

/**
 * v35 FIX-PIPE (data D1, the coordinator's decision 4): who reposts a job. `adminId`: the importing admin (when known).
 * `vouchFor`: the link the admin's import vouches for when TailorIT could not read it now (H5's "unreadable: reposted,
 * the admin vouches"); absent when TailorIT read it now or lately (a read is proof enough).
 */
export interface Repost {
  adminId: string | null;
  vouchFor?: string;
}

/**
 * H5: the job reposted now (its search row rebuilt). In the caller's transaction.
 * v35 FIX-PIPE (data D1, decision 4: an admin's re-import vouches for an open job): an open, shared, unheld job that had
 * left search as unverified (ingest/unverified.ts: no source verified it for JOB_UNVERIFIED_HIDE_DAYS, or its admin
 * approval ran out, SB-4) is back in search at once:
 *   - read now or lately: the read is the proof (its sources verify it from now on);
 *   - vouched for (no read): its admin approval is renewed (v35 INT-A: as Approve again does) or, with none, one of kind
 *     `import` is written (approved by the importing admin), so the sweep takes it out again ADMIN_APPROVED_JOB_DAYS
 *     later unless a source lists it, and the link is read again as every approved job's is (approved.ts).
 * A job in search, or held, or closed, is only reposted.
 */
export async function repostJob(t: DbQueries, jobId: number, at: string, by: Repost = { adminId: null }): Promise<void> {
  const back = await t.one<{ id: number }>(
    `UPDATE jobs SET reposted_at = ?, unverified_since = NULL
     WHERE id = ? AND unverified_since IS NOT NULL AND active AND owner_user_id IS NULL AND held_since IS NULL AND superseded_by IS NULL
     RETURNING id`,
    [at, jobId],
  );
  if (!back) {
    await t.run('UPDATE jobs SET reposted_at = ? WHERE id = ?', [at, jobId]);
  } else {
    const renewed = await t.one<{ job_id: number }>(
      'UPDATE job_admin_approvals SET approved_at = ?, approved_by = COALESCE(?, approved_by) WHERE job_id = ? RETURNING job_id',
      [at, by.adminId, jobId],
    );
    const key = by.vouchFor ? linkKey(by.vouchFor) : null;
    if (!renewed && key) {
      await t.run(
        `INSERT INTO job_admin_approvals(job_id, url_key, kind, approved_by, approved_at, adders)
         VALUES (?, ?, 'import', (SELECT id FROM users WHERE id = ?), ?, 0) ON CONFLICT (job_id) DO NOTHING`,
        [jobId, key, by.adminId, at],
      );
    }
  }
  await projectJob(t, jobId);
}

/** H5: a job whose posting TailorIT found gone now: its links close (`gone`), and the job with them. */
export async function closeGoneJob(deps: AppDeps, jobId: number): Promise<void> {
  const at = nowIso(deps);
  await deps.db.tx((t) => closeLink(deps, t, { jobId, reason: 'gone', at }), { label: 'import: a posting gone' });
}

/** The posting a row makes (H2.3, H4): its own words; the Rate only when its description names no pay. */
export function postingOfRow(url: string, details: JobRowDetails): RawPosting {
  const description = details.description ?? '';
  const describedPay = description ? salaryFromText(description) !== null : false;
  return {
    sourceJobId: rowIdOf(details.company ?? '', details.title ?? '', url, description),
    title: details.title ?? '',
    company: { name: details.company ?? '' },
    descriptionText: description || null,
    descriptionHtml: null,
    url,
    locations: details.location ? [details.location] : [],
    salaryText: !describedPay && details.rate ? details.rate : null,
    // TailorIT did not read the posting: an admin's row says it.
    verified: false,
  };
}

/** What jobFromRow came to: the held job it made, or the job the store found for the row (`created` false). */
export interface RowJob {
  jobId: number;
  created: boolean;
}

/** v35 FIX-PIPE (data D6): the store filed a row under a job TailorIT has: its writes are undone (see jobFromRow). */
class RowOfKnownJob extends Error {
  constructor(readonly jobId: number) {
    super('import: the row names a job TailorIT has');
  }
}

/**
 * H2.3: an admin import's row as a held shared job (see the top), under the import's source, and its "Couldn't verify"
 * note (no adder, origin `import`, the read's reason). Outside any transaction (the store's own).
 * v35 FIX-PIPE (data D6, the coordinator's decision 5): a row joins a job TailorIT has only by an exact match: its link's
 * keys, or the same company, title and text (the store's `importRow`: never the fuzzy fingerprint). A row the store
 * files under such a job answers that job (`created` false) and changes NOTHING: the store's writes for it (an import
 * link that no run ever reads again, which would keep the job open and verified for good; a closed job reopened) are
 * undone, and the caller settles the job as H5 settles a job TailorIT has that it cannot read now.
 */
export async function jobFromRow(
  deps: AppDeps,
  source: SourceRecord,
  input: { url: string; details: JobRowDetails; reason: JobVerifyReason },
): Promise<RowJob> {
  const ingest = requireIngest(deps);
  const raw = postingOfRow(input.url, input.details);
  return deps.db.tx(
    async (t) => {
      const at = nowIso(deps);
      try {
        return await t.savepoint(async (s): Promise<RowJob> => {
          const outcome = await ingest.store.upsertBatch(source, [{ raw, sourceHash: sourceHashOf(raw), importRow: true }], at);
          const link = await s.one<{ job_id: number }>('SELECT job_id FROM job_source_links WHERE source_id = ? AND source_job_id = ?', [
            source.id,
            outcome.failures.length > 0 ? '' : storedSourceJobId(raw.sourceJobId),
          ]);
          if (!link) throw new Error('import: the row could not be stored');
          const jobId = Number(link.job_id);
          if (outcome.counts.created === 0) throw new RowOfKnownJob(jobId);
          await holdImported(s, jobId, input.url, input.reason, at);
          return { jobId, created: true };
        });
      } catch (error) {
        if (error instanceof RowOfKnownJob) return { jobId: error.jobId, created: false };
        throw error;
      }
    },
    { label: 'import: a job from its row' },
  );
}

/**
 * Holds a shared job for Review › Couldn't verify (see the top) and notes it there. In the caller's transaction (v35
 * FIX-PIPE: exported, so an import's other writes of the row join it: import-pipeline.ts, data D8).
 */
export async function holdImported(t: DbQueries, jobId: number, url: string, reason: JobVerifyReason, at: string): Promise<void> {
  await t.run(
    `UPDATE jobs SET held_since = COALESCE(held_since, ?), active = true, closed_at = NULL, ai_input = false, updated_at = ?
     WHERE id = ? AND owner_user_id IS NULL`,
    [at, at, jobId],
  );
  await projectJob(t, jobId);
  await noteUnverified(t, { jobId, userId: null, url, origin: 'import', reason, addedBy: null }, at);
}
