import {
  ADMIN_BULK_MAX,
  type AdminFlag,
  type AdminFlagBulkBody,
  type AdminFlagBulkResultSchema,
  type AdminFlagDecisionBody,
  type AdminFlagList,
  type AdminFlagsAllBody,
  type AdminFlagsAllCount,
  type AdminFlagsAllResult,
  type AdminFlagsFilter,
  type AdminFlagsQuery,
} from '@tailorit/shared';
import type { z } from 'zod';
import { afterCursor, likeText, pageOf, Where, type AdminActor } from '../../core/admin/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { SqlParam } from '../../core/db/types';
import { closeLink } from '../../core/seams';
import { FLAG_SELECT, reviewCounts, toFlag, type FlagRow } from './admin';
import { FLAG_LANE_FROM } from './counts'; // v37 REVIEW
import { decideInTurns, reviewsUpToBound, upToOf } from './service'; // v37 REVIEW (R3)

// v30 X1-API: Admin › Review's Flags lane (docs/design/part2/14-extension-reports.md §5.4, §6.1): the Jobs page's flags
// that are not about a closed posting (spam, wrong details, duplicate, other, and E0's "Company information is wrong";
// job_reports), with today's Admin › Reports workflow: reopen, resolve or dismiss, one at a time or in bulk. "Close the
// job" on a flag closes it through the one close function (closeLink, reason `admin`: every live link, then the job,
// out of search in the same transaction), never a direct `active = false`. The Jobs page's "The job is no longer open"
// is a closed report now (jobs/report.ts), in the Closed links lane.

const STALE = 'This list changed since it was opened. Load it again.';

/**
 * The Flags lane's filters on the flag `r` (its job `j`, company `c`): the state (v37 REVIEW: Waiting, the default, is
 * the open flags, as Needs review) and the search.
 */
function flagsWhere(deps: Pick<AppDeps, 'db'>, filter: AdminFlagsFilter): Where {
  const where = new Where();
  if (filter.state === 'waiting' || filter.state === 'needs_review') where.add("r.status = 'open'");
  else if (filter.state === 'decided') where.add("r.status <> 'open'");
  const d = deps.db.dialect;
  if (filter.q) where.add(`(${d.like('j.title', '@q')} OR ${d.like('c.name', '@q')})`, { q: likeText(filter.q) });
  return where;
}

/**
 * GET /api/admin/flags: a page of flags (open, decided, or all), newest first. v37 REVIEW (R2, R3): with the flags the
 * query matches (`total`), the open ones among them (`decidable`), and the view's flags without the search
 * (`unfiltered`); counted as the list reads them (counts.ts FLAG_LANE_FROM).
 */
export async function listFlags(deps: Pick<AppDeps, 'db'>, query: AdminFlagsQuery): Promise<AdminFlagList> {
  const where = flagsWhere(deps, query);
  const counted = await deps.db.one<{ n: number; open: number }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE r.status = 'open') AS open ${FLAG_LANE_FROM} ${where.sql()}`,
    where.params as Record<string, SqlParam>,
  );
  const total = Number(counted?.n ?? 0);
  let unfiltered = total;
  if (query.q) {
    const base = flagsWhere(deps, { state: query.state });
    unfiltered = Number((await deps.db.one<{ n: number }>(`SELECT count(*) AS n ${FLAG_LANE_FROM} ${base.sql()}`, base.params as Record<string, SqlParam>))?.n ?? 0);
  }
  if (query.cursor) {
    const after = afterCursor(query.cursor, { sortColumn: 'r.created_at', idColumn: 'r.id', staleMessage: STALE });
    where.add(after.sql, after.params);
  }
  const rows = await deps.db.all<FlagRow>(`${FLAG_SELECT} ${where.sql()} ORDER BY r.created_at DESC, r.id DESC LIMIT ${query.limit + 1}`, where.params as Record<string, SqlParam>);
  const page = pageOf(rows, query.limit, (last) => ({ c: last.created_at, id: last.id }), toFlag);
  return { ...page, counts: await reviewCounts(deps.db), total, decidable: Number(counted?.open ?? 0), unfiltered };
}

/** PATCH /api/admin/flags/:id: reopen, resolve or dismiss a flag, closing its job too when asked; null when none. */
export async function decideFlag(deps: AppDeps, id: number, change: AdminFlagDecisionBody, admin: AdminActor): Promise<AdminFlag | null> {
  const flag = await deps.db.one<{ job_id: number }>('SELECT job_id FROM job_reports WHERE id = ?', [id]);
  if (!flag) return null;
  const at = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      if (change.status === 'open') {
        await t.run("UPDATE job_reports SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = ?", [id]);
      } else {
        await t.run('UPDATE job_reports SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?', [change.status, at, admin.id, id]);
      }
      if (change.closeJob) await closeLink(deps, t, { jobId: flag.job_id, reason: 'admin', at });
    },
    { label: 'decide flag' },
  );
  const row = await deps.db.one<FlagRow>(`${FLAG_SELECT} WHERE r.id = ?`, [id]);
  return row ? toFlag(row) : null;
}

/** POST /api/admin/flags/bulk: resolve or dismiss chosen flags; each row says what happened. */
export async function decideFlags(
  deps: AppDeps,
  bulk: AdminFlagBulkBody,
  admin: AdminActor,
): Promise<{ ids: number[]; body: z.infer<typeof AdminFlagBulkResultSchema> }> {
  const at = nowIso(deps);
  const results: z.infer<typeof AdminFlagBulkResultSchema>['results'] = [];
  const changed: number[] = [];
  for (const id of bulk.ids) {
    const { changes } = await deps.db.run(
      'UPDATE job_reports SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status <> ?',
      [bulk.status, at, admin.id, id, bulk.status],
    );
    if (changes > 0) {
      changed.push(id);
      results.push({ id, outcome: bulk.status });
      continue;
    }
    const exists = await deps.db.one('SELECT 1 FROM job_reports WHERE id = ?', [id]);
    results.push(exists ? { id, outcome: 'skipped', message: `This flag is ${bulk.status} already.` } : { id, outcome: 'failed', message: 'That flag was not found.' });
  }
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  return { ids: changed, body: { results, counts } };
}

// v37 REVIEW (SP v37 PLAN.md R3) --------------------------------------------------------- Resolve all / Dismiss all

/** The open flags the filter matches (the lane's own condition), on `r` with its reporter, job and company. */
function openWhere(deps: Pick<AppDeps, 'db'>, filter: AdminFlagsFilter): Where {
  const where = flagsWhere(deps, filter);
  where.add("r.status = 'open'");
  return where;
}

/** GET /api/admin/flags/all/count: the open flags the filter matches (the confirm's count), and what was counted. */
export async function countAllFlags(deps: AppDeps, filter: AdminFlagsFilter): Promise<AdminFlagsAllCount> {
  const at = deps.now(); // taken before the count, so nothing changed after it is in its upTo
  const where = openWhere(deps, filter);
  const row = await deps.db.one<{ n: number; last: number | null }>(
    `SELECT count(*) AS n, max(r.id) AS last ${FLAG_LANE_FROM} ${where.sql()}`,
    where.params as Record<string, SqlParam>,
  );
  return { pending: Number(row?.n ?? 0), upTo: upToOf(Number(row?.last ?? 0), at) };
}

/**
 * POST /api/admin/flags/all: resolves or dismisses every open flag the filter matches, oldest first, ADMIN_BULK_MAX at a
 * time through decideFlags (a flag decided meanwhile is skipped), for at most ADMIN_BULK_ALL_SECONDS (decideInTurns:
 * `done` false, then the same request with `after` goes on); with the count's `upTo`, never a flag made after it.
 */
export async function decideAllFlags(
  deps: AppDeps,
  body: AdminFlagsAllBody,
  admin: AdminActor,
  clock: () => number = Date.now,
): Promise<{ ids: number[]; body: AdminFlagsAllResult }> {
  const bound = body.upTo === undefined ? null : reviewsUpToBound(body.upTo);
  const nextIds = async (after: number): Promise<number[]> => {
    const where = openWhere(deps, body.filter);
    where.add('r.id > @after', { after });
    if (bound) {
      where.add('r.id <= @upToId', { upToId: bound.lastId });
      where.add('r.created_at <= CAST(@upToAt AS timestamptz)', { upToAt: bound.at });
    }
    const rows = await deps.db.all<{ id: number }>(`SELECT r.id ${FLAG_LANE_FROM} ${where.sql()} ORDER BY r.id LIMIT ${ADMIN_BULK_MAX}`, where.params as Record<string, SqlParam>);
    return rows.map((row) => Number(row.id));
  };
  const decide = async (ids: number[]) => {
    const decided = await decideFlags(deps, { ids, status: body.status }, admin);
    return { ids: decided.ids, results: decided.body.results };
  };
  const turns = await decideInTurns(deps, body.after ?? 0, nextIds, decide, clock);
  return {
    ids: turns.changed,
    body: { status: body.status, matched: turns.matched, counts: turns.counts, failures: turns.failures, done: turns.done, after: turns.after },
  };
}
// end v37 REVIEW
