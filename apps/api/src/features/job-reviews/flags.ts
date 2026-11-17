import type {
  AdminFlag,
  AdminFlagBulkBody,
  AdminFlagBulkResultSchema,
  AdminFlagDecisionBody,
  AdminFlagList,
  AdminFlagsQuery,
} from '@tailorit/shared';
import type { z } from 'zod';
import { afterCursor, likeText, pageOf, Where, type AdminActor } from '../../core/admin/index';
import { nowIso, type AppDeps } from '../../core/context';
import type { SqlParam } from '../../core/db/types';
import { closeLink } from '../../core/seams';
import { FLAG_SELECT, reviewCounts, toFlag, type FlagRow } from './admin';

// v30 X1-API: Admin › Review's Flags lane (docs/design/part2/14-extension-reports.md §5.4, §6.1): the Jobs page's flags
// that are not about a closed posting (spam, wrong details, duplicate, other, and E0's "Company information is wrong";
// job_reports), with today's Admin › Reports workflow: reopen, resolve or dismiss, one at a time or in bulk. "Close the
// job" on a flag closes it through the one close function (closeLink, reason `admin`: every live link, then the job,
// out of search in the same transaction), never a direct `active = false`. The Jobs page's "The job is no longer open"
// is a closed report now (jobs/report.ts), in the Closed links lane.

const STALE = 'This list changed since it was opened. Load it again.';

/** GET /api/admin/flags: a page of flags (open, decided, or all), newest first. */
export async function listFlags(deps: Pick<AppDeps, 'db'>, query: AdminFlagsQuery): Promise<AdminFlagList> {
  const where = new Where();
  if (query.state === 'needs_review') where.add("r.status = 'open'");
  else if (query.state === 'decided') where.add("r.status <> 'open'");
  const d = deps.db.dialect;
  if (query.q) where.add(`(${d.like('j.title', '@q')} OR ${d.like('c.name', '@q')})`, { q: likeText(query.q) });
  const counted = await deps.db.one<{ n: number }>(
    `SELECT count(*) AS n FROM job_reports r JOIN jobs j ON j.id = r.job_id JOIN companies c ON c.id = j.company_id ${where.sql()}`,
    where.params as Record<string, SqlParam>,
  );
  if (query.cursor) {
    const after = afterCursor(query.cursor, { sortColumn: 'r.created_at', idColumn: 'r.id', staleMessage: STALE });
    where.add(after.sql, after.params);
  }
  const rows = await deps.db.all<FlagRow>(`${FLAG_SELECT} ${where.sql()} ORDER BY r.created_at DESC, r.id DESC LIMIT ${query.limit + 1}`, where.params as Record<string, SqlParam>);
  const page = pageOf(rows, query.limit, (last) => ({ c: last.created_at, id: last.id }), toFlag);
  return { ...page, counts: await reviewCounts(deps.db), total: counted?.n ?? 0 };
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
