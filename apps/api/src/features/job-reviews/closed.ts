import {
  AUTOFILL_CLOSED_SEEN_WITHIN_HOURS,
  closedReportStrength,
  parseAtsUrl,
  type AutofillClosedOutcome,
  type AutofillClosedReportRequest,
  type AutofillClosedSignal,
} from '@tailorit/shared/autofill';
import { JOB_REVIEW_DETAILS_MAX, jobReviewSubject, HOUR_MS, type JobReviewVia } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import { dayKeyAt, nextDailyResetAt } from '../../core/constants/day';
import type { AppDeps } from '../../core/context';
import type { DbQueries, DbTx } from '../../core/db/types';
import { notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { closeLink, type JobLinkRef } from '../../core/seams';
import { currentJobId } from '../jobs/store';
import { jobVisibleTo } from '../jobs/visibility';
import { autoDecide } from './auto';
import { runFollowUps } from './decide';
import { openReview, recountReview, upsertReport } from './store';

// v30 X1-API: a closed report (docs/design/part2/14-extension-reports.md §5.1): the extension's
// (POST /api/autofill/jobs/:jobId/closed, autofill API 9) and the Jobs page's "The job is no longer open" flag (via
// `web`, signal `person`, its details clipped to JOB_REVIEW_DETAILS_MAX). In order:
// 1. the job is one the account may see (jobVisibleTo; a stale id of a page job that gave way answers the shared job,
//    as the lookup does), else 404 not_found;
// 2. the account's own page job closes at once (it is theirs alone): `closed`, no review; a job TailorIT already shows
//    as closed answers `already_closed`;
// 3. otherwise, behind the account's lock, the daily cap (EXT_REPORTS_PER_ACCOUNT_PER_DAY report rows a day key, 12:00
//    AM PT; a second report on a job the account reported today updates its row and is never refused), then the job's
//    pending closed review opened or bumped (one per job), the account's report row written (one per account and
//    review), the review's counts kept, a server re-check queued (one per review at a time; never again within
//    RECHECK_FLOOR_HOURS of the job's last check, whose answer the review takes instead), and the automatic rules tried:
//    `queued`, trusted or not (trust cannot be probed).
// The reported address is read with parseAtsUrl and matched to the job's own link (job_source_links: its source's kind
// and posting id); a report that matches none is about the job as a whole. Logs carry outcomes and counts, never the
// job, the address and the account together (DEVELOPMENT.md, "Personal data in logs").

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** A job reported again within this many hours of its last re-check is not read again (14 §5.1 step 3). */
export const RECHECK_FLOOR_HOURS = 6;

export interface ClosedReportInput {
  /** The posting's address as the extension's lookup was asked with it; null for the Jobs page's flag. */
  url: string | null;
  signal: AutofillClosedSignal;
  marker: string | null;
  via: Extract<JobReviewVia, 'page' | 'agent' | 'queue' | 'person' | 'web'>;
  /** When it was seen (ISO): kept within the last AUTOFILL_CLOSED_SEEN_WITHIN_HOURS and never later than now. */
  seenAt: string;
  /** The web flag's own words (plain text), clipped to JOB_REVIEW_DETAILS_MAX. */
  details?: string | null;
}

export interface ClosedReportResult {
  outcome: AutofillClosedOutcome;
  /** The job the report is about (a stale page job's id answers its shared job). */
  jobId: number;
  /** The closed review opened or bumped (`queued`). */
  reviewId: number | null;
}

/** `seenAt` within the last AUTOFILL_CLOSED_SEEN_WITHIN_HOURS, never after `now`. */
export function clampSeenAt(seenAt: string, now: Date): string {
  const at = Date.parse(seenAt);
  const earliest = now.getTime() - AUTOFILL_CLOSED_SEEN_WITHIN_HOURS * HOUR_MS;
  const kept = Number.isFinite(at) ? Math.min(Math.max(at, earliest), now.getTime()) : now.getTime();
  return new Date(kept).toISOString();
}

/** The web flag's words as a report row keeps them: plain text, at most JOB_REVIEW_DETAILS_MAX characters (CT edit H). */
export function clipDetails(details: string | null | undefined): string | null {
  const text = (details ?? '').trim();
  if (!text) return null;
  return [...text].slice(0, JOB_REVIEW_DETAILS_MAX).join('').trim();
}

/** The job's link the reported address names (its ATS posting's source and id), or null: the job as a whole. */
export async function reportedLink(db: DbQueries, jobId: number, url: string): Promise<JobLinkRef | null> {
  const ats = parseAtsUrl(url);
  if (!ats?.externalId) return null;
  const rows = await db.all<{ source_id: number; source_job_id: string }>(
    `SELECT l.source_id, l.source_job_id FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
     WHERE l.job_id = ? AND s.kind = ? AND l.source_job_id = ? ORDER BY (l.missing_since IS NULL) DESC, l.seq LIMIT 1`,
    [jobId, ats.kind, ats.externalId],
  );
  return rows[0] ? { sourceId: rows[0].source_id, sourceJobId: rows[0].source_job_id } : null;
}

/** The 429 of the daily cap: MSG_EXT_REPORT_LIMIT, and when it resets (resetAt, Retry-After). */
function capReached(deps: Deps, max: number) {
  const resetAt = nextDailyResetAt(deps);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - deps.now().getTime()) / 1000));
  return refuse(deps, 'rate_limited', 'MSG_EXT_REPORT_LIMIT', { max }, { retryAfterSeconds, resetAt: resetAt.toISOString() });
}

/**
 * Queues the review's server re-check (check_state `queued`) unless one is queued, or the job was checked within
 * RECHECK_FLOOR_HOURS: then the review takes that check's answer. In the caller's transaction.
 */
export async function queueCheck(t: DbQueries, reviewId: number, jobId: number, now: Date): Promise<boolean> {
  const review = await t.one<{ check_state: string }>('SELECT check_state FROM job_reviews WHERE id = ?', [reviewId]);
  if (!review || review.check_state === 'queued') return false;
  const last = await t.one<{ state: string; checked_at: string }>(
    'SELECT state, checked_at FROM job_review_checks WHERE job_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1',
    [jobId],
  );
  if (last && now.getTime() - Date.parse(last.checked_at) < RECHECK_FLOOR_HOURS * HOUR_MS) {
    await t.run("UPDATE job_reviews SET check_state = ?, checked_at = ? WHERE id = ? AND check_state = 'none'", [
      last.state,
      last.checked_at,
      reviewId,
    ]);
    return false;
  }
  await t.run("UPDATE job_reviews SET check_state = 'queued', updated_at = ? WHERE id = ? AND state = 'pending'", [now.toISOString(), reviewId]);
  return true;
}

/** Whether a new report row of the account today would pass the cap (a row it already has today never counts again). */
async function underCap(t: DbTx, userId: string, reviewId: number | null, dayKey: string, max: number): Promise<boolean> {
  if (reviewId !== null) {
    const today = await t.one('SELECT 1 FROM job_review_reports WHERE review_id = ? AND user_id = ? AND day_key = ?', [reviewId, userId, dayKey]);
    if (today) return true;
  }
  const used = await t.one<{ n: number }>(
    `SELECT count(*) AS n FROM job_review_reports r JOIN job_reviews v ON v.id = r.review_id
     WHERE r.user_id = ? AND r.day_key = ? AND v.kind = 'closed'`,
    [userId, dayKey],
  );
  return (used?.n ?? 0) < max;
}

/** Files a closed report (see above). Throws 404 not_found, or 429 rate_limited at the daily cap. */
export async function fileClosedReport(deps: AppDeps, userId: string, askedJobId: number, input: ClosedReportInput): Promise<ClosedReportResult> {
  const jobId = await currentJobId(deps, userId, askedJobId);
  if (jobId === null) throw notFound('That job');
  const now = deps.now();
  const at = now.toISOString();
  const seenAt = clampSeenAt(input.seenAt, now);
  const link = input.url ? await reportedLink(deps.db, jobId, input.url) : null;
  const strength = closedReportStrength({ signal: input.signal, marker: (input.marker ?? undefined) as AutofillClosedReportRequest['marker'] });
  const max = constantsOf(deps).get('EXT_REPORTS_PER_ACCOUNT_PER_DAY');
  const dayKey = dayKeyAt(deps, now);
  const done = await deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      const job = await t.one<{ active: boolean; owner_user_id: string | null }>(
        `SELECT j.active, j.owner_user_id FROM jobs j WHERE j.id = ? AND ${jobVisibleTo('j')}`,
        [jobId, userId],
      );
      if (!job) throw notFound('That job');
      if (!job.active) return { outcome: 'already_closed' as const, reviewId: null, followUps: [] };
      if (job.owner_user_id === userId) {
        await closeLink(deps, t, { jobId, reason: 'report', at });
        return { outcome: 'closed' as const, reviewId: null, followUps: [] };
      }
      const subjectKey = jobReviewSubject(jobId);
      const open = await t.one<{ id: number }>("SELECT id FROM job_reviews WHERE kind = 'closed' AND subject_key = ? AND state = 'pending'", [
        subjectKey,
      ]);
      if (!(await underCap(t, userId, open?.id ?? null, dayKey, max))) throw capReached(deps, max);
      const reviewId = await openReview(t, { kind: 'closed', subjectKey, jobId, at });
      if (link) {
        await t.run('UPDATE job_reviews SET link_source_id = ?, link_source_job_id = ? WHERE id = ? AND link_source_id IS NULL', [
          link.sourceId,
          link.sourceJobId,
          reviewId,
        ]);
      }
      await upsertReport(t, reviewId, userId, {
        via: input.via,
        signal: input.signal,
        marker: input.marker,
        strength,
        details: input.via === 'web' ? clipDetails(input.details) : null,
        seenAt,
        dayKey,
        at,
      });
      await queueCheck(t, reviewId, jobId, now);
      const tally = await recountReview(deps, t, reviewId, now);
      const followUps = await autoDecide(deps, t, reviewId, tally, now);
      return { outcome: 'queued' as const, reviewId, followUps };
    },
    { label: 'closed report' },
  );
  await runFollowUps(deps, done.followUps);
  return { outcome: done.outcome, jobId, reviewId: done.reviewId };
}
