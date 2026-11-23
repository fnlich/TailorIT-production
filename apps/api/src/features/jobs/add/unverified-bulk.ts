import type { UnverifiedBulkResult, UnverifiedCount } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import { AppError, validationFailed } from '../../../core/http/errors';
import { closeLink } from '../../../core/seams';
import { approveUnverifiedJob } from './approve';
import { LISTED, rejectLink, unverifiedFilterSql, type UnverifiedFilter } from './verification';

// v35 IMPORT (SP v35 PLAN.md H3): Admin › Review › Couldn't verify, a selection or every row at once.
//   - Approve: each row as the single Approve does (approve.ts approveUnverifiedJob: the job published as it is, the
//     checks, the four-eyes rule for a person's add), with no version (the admin approves what is there). An admin
//     import's job takes nothing from ADMIN_APPROVALS_PER_HOUR; a person's add takes one approval, and once the hour's
//     are used the rest are left (answered as `left`: call again later).
//   - Reject: each row's link as the single Reject does (rejectLink), and a job an admin import made of it closes (it
//     is never published).
//   - All: every row the list's filter matches (the From filter), in batches of UNVERIFIED_ALL_BATCH, within
//     UNVERIFIED_ALL_BUDGET_MS of the request (a longer one answers what is `left`; the next call goes on).
// A row that cannot be approved (a refusal: a closed posting, a site never read, an admin's own add, ...) is skipped
// with its words.

/** Rows one batch of "all" reads. */
export const UNVERIFIED_ALL_BATCH = 100;
/** How long one "all" request works before it answers what is left (under the web proxy's 240 s). */
export const UNVERIFIED_ALL_BUDGET_MS = 150_000;

type Action = 'approve' | 'reject';

interface RowOutcome {
  jobId: number;
  outcome: 'approved' | 'rejected' | 'skipped';
  message: string | null;
}

/** The hour's approvals are used: the rows after it are left. */
class HourUsed extends Error {}

/** Rejects a listed row's link (the route's Reject) and closes the held jobs an admin import made of it. */
export async function rejectUnverifiedLink(deps: AppDeps, url: string, adminId: string): Promise<number> {
  const at = nowIso(deps);
  const noted = await rejectLink(deps, url, adminId, at, (t, jobId) => closeLink(deps, t, { jobId, reason: 'admin', at }));
  const held = await deps.db.all<{ job_id: number }>(
    `SELECT v.job_id FROM job_verifications v JOIN jobs j ON j.id = v.job_id
     WHERE v.url = ? AND v.user_id IS NULL AND v.origin = 'import' AND j.owner_user_id IS NULL AND j.held_since IS NOT NULL AND j.active`,
    [url],
  );
  if (held.length > 0) {
    await deps.db.tx(
      async (t) => {
        for (const row of held) await closeLink(deps, t, { jobId: Number(row.job_id), reason: 'admin', at });
      },
      { label: 'reject: an import job closes' },
    );
  }
  return noted;
}

async function actOn(deps: AppDeps, admin: { id: string }, action: Action, jobId: number): Promise<RowOutcome> {
  try {
    if (action === 'approve') {
      await approveUnverifiedJob(deps, jobId, admin);
      return { jobId, outcome: 'approved', message: null };
    }
    const row = await deps.db.one<{ url: string }>('SELECT url FROM job_verifications WHERE job_id = ?', [jobId]);
    if (!row) return { jobId, outcome: 'skipped', message: 'That job is no longer listed.' };
    await rejectUnverifiedLink(deps, row.url, admin.id);
    return { jobId, outcome: 'rejected', message: null };
  } catch (error) {
    if (error instanceof AppError && error.code === 'rate_limited') throw new HourUsed(error.message);
    if (error instanceof AppError && (error.code === 'conflict' || error.code === 'not_found')) {
      return { jobId, outcome: 'skipped', message: error.message };
    }
    throw error;
  }
}

/** One line of words for the result. */
function sentence(action: Action, done: number, skipped: number, left: number, hourUsed: string | null): string {
  const verb = action === 'approve' ? 'Approved' : 'Rejected';
  const parts = [`${verb} ${done.toLocaleString('en-US')} ${done === 1 ? 'job' : 'jobs'}.`];
  if (skipped > 0) parts.push(`${skipped.toLocaleString('en-US')} could not be ${action === 'approve' ? 'approved' : 'rejected'}.`);
  if (left > 0) parts.push(hourUsed ?? `${left.toLocaleString('en-US')} left: run it again to go on.`);
  return parts.join(' ');
}

/** POST /api/admin/jobs/unverified/bulk: the rows chosen (their list jobIds), one by one. */
export async function bulkUnverified(deps: AppDeps, admin: { id: string }, action: Action, jobIds: readonly number[]): Promise<UnverifiedBulkResult> {
  const items: RowOutcome[] = [];
  let hourUsed: string | null = null;
  for (const [index, jobId] of jobIds.entries()) {
    try {
      items.push(await actOn(deps, admin, action, jobId));
    } catch (error) {
      if (!(error instanceof HourUsed)) throw error;
      hourUsed = error.message;
      for (const rest of jobIds.slice(index)) items.push({ jobId: rest, outcome: 'skipped', message: hourUsed });
      break;
    }
  }
  const done = items.filter((item) => item.outcome !== 'skipped').length;
  const skipped = items.length - done;
  return { action, done, skipped, left: 0, message: sentence(action, done, skipped, 0, hourUsed), items };
}

// v35 FIX-STORE (the final review's S6; the coordinator's decision 2: "Approve all" decides what the confirm counted):
// the count (GET /api/admin/jobs/unverified/count) answers an opaque `upTo`: the newest note counted and the time of the
// count ("<job id>@<ms>"). Approve all / Reject all send it back and take only a link whose notes are all no newer than
// it and unchanged since (checked again, or listed again when an approval ran out: unverified_since); a link that
// arrived, or changed, after the count stays for the next decision, and is not `left` of this one.

/** A link (its notes `v`, grouped by url_key) within a count's upTo. */
const WITHIN_UP_TO = 'max(v.job_id) <= ? AND max(GREATEST(v.checked_at, COALESCE(j.unverified_since, v.checked_at))) <= CAST(? AS timestamptz)';

/** The bound of an `upTo` (400 for one no count gave). */
function upToBound(upTo: string): { lastJobId: number; at: string } {
  const parts = /^(\d{1,15})@(\d{1,15})$/.exec(upTo);
  const at = parts ? new Date(Number(parts[2])) : null;
  if (!parts || !at || Number.isNaN(at.getTime())) throw validationFailed('Count the jobs again, then approve or reject them all.');
  return { lastJobId: Number(parts[1]), at: at.toISOString() };
}

/** GET /api/admin/jobs/unverified/count: the links the list holds for the filter (0 while it is off), and `upTo`. */
export async function countUnverifiedUpTo(deps: AppDeps, filter: UnverifiedFilter): Promise<UnverifiedCount> {
  const at = deps.now(); // before the count: nothing changed after it is in its upTo
  if (!constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW')) return { count: 0, upTo: `0@${at.getTime()}` };
  const where = unverifiedFilterSql(filter);
  const row = await deps.db.one<{ n: number; last: number | null }>(
    `SELECT count(DISTINCT v.url_key)::int AS n, max(v.job_id) AS last FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE ${LISTED}${where.sql}`,
    where.params,
  );
  return { count: Number(row?.n ?? 0), upTo: `${Number(row?.last ?? 0)}@${at.getTime()}` };
}

/** The listed rows' jobIds the filter matches (one per link, as the list shows them), after those already tried. */
async function nextBatch(deps: AppDeps, filter: UnverifiedFilter, tried: ReadonlySet<number>, bound: { lastJobId: number; at: string } | null): Promise<number[]> {
  const where = unverifiedFilterSql(filter);
  const rows = await deps.db.all<{ job_id: number }>(
    `SELECT min(v.job_id) AS job_id FROM job_verifications v JOIN jobs j ON j.id = v.job_id
     WHERE ${LISTED}${where.sql} GROUP BY v.url_key${bound ? ` HAVING ${WITHIN_UP_TO}` : ''}
     ORDER BY max(v.checked_at) DESC, v.url_key DESC LIMIT ?`,
    [...where.params, ...(bound ? [bound.lastJobId, bound.at] : []), UNVERIFIED_ALL_BATCH + tried.size],
  );
  return rows.map((row) => Number(row.job_id)).filter((id) => !tried.has(id)).slice(0, UNVERIFIED_ALL_BATCH);
}

/** POST /api/admin/jobs/unverified/all: every row the filter matches (see the top), within the count's `upTo` when given. */
export async function allUnverified(
  deps: AppDeps,
  admin: { id: string },
  action: Action,
  filter: UnverifiedFilter,
  upTo?: string,
): Promise<UnverifiedBulkResult> {
  const bound = upTo === undefined ? null : upToBound(upTo); // v35 FIX-STORE (S6)
  // The list is empty while it is off (verification.ts): nothing to act on.
  if (!constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW')) return { action, done: 0, skipped: 0, left: 0, message: sentence(action, 0, 0, 0, null), items: [] };
  const started = Date.now();
  const tried = new Set<number>();
  let done = 0;
  let skipped = 0;
  let hourUsed: string | null = null;
  outer: while (Date.now() - started < UNVERIFIED_ALL_BUDGET_MS) {
    const batch = await nextBatch(deps, filter, tried, bound);
    if (batch.length === 0) break;
    for (const jobId of batch) {
      tried.add(jobId);
      try {
        const outcome = await actOn(deps, admin, action, jobId);
        if (outcome.outcome === 'skipped') skipped += 1;
        else done += 1;
      } catch (error) {
        if (!(error instanceof HourUsed)) throw error;
        hourUsed = error.message;
        tried.delete(jobId);
        break outer;
      }
      if (Date.now() - started >= UNVERIFIED_ALL_BUDGET_MS) break outer;
    }
  }
  const where = unverifiedFilterSql(filter);
  const remaining = await deps.db.all<{ job_id: number }>(
    `SELECT min(v.job_id) AS job_id FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE ${LISTED}${where.sql} GROUP BY v.url_key${bound ? ` HAVING ${WITHIN_UP_TO}` : ''}`,
    [...where.params, ...(bound ? [bound.lastJobId, bound.at] : [])],
  );
  const left = remaining.filter((row) => !tried.has(Number(row.job_id))).length;
  return { action, done, skipped, left, message: sentence(action, done, skipped, left, hourUsed), items: [] };
}
