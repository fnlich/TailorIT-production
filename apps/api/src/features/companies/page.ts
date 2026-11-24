import { JOBS_PAGE_SIZE, type CompanyJobItem, type CompanyJobsQuery, type CompanyJobsResponse, type CompanyPage } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { notFound } from '../../core/http/errors';
import { APPLICATION_JOIN, DEFAULT_POSTED_RULE, SUMMARY_COLUMNS, isoTimestamp, toSummary, type PostedRule, type SummaryRow } from '../jobs/rows'; // v36 IMPORTTIME: PostedRule
import { companyVisibleTo, jobVisibleTo } from '../jobs/visibility';
import { survivorOf } from './aliases';
import { COMPANY_DETAIL_SQL, profileOfDetail, sourcesLineOf } from './detail';

// v30 E0-API: the company page (/companies/:id, owner question 24; docs/design/part2/13-company-enrichment.md §10,
// 11-database.md §5.4): the profile, "Part of {parent}", the sources line, its open positions (newest first) and its
// closed history (latest closed first), each a page of jobs-list cards. A merged company answers its survivor; an
// account's own company (a page job's) answers its owner only. The jobs are those the viewer may see (jobVisibleTo).

/** The company the viewer asked for, after its merges: its id, or 404 (never revealing an account's own row). */
export async function visibleCompanyId(t: DbQueries, companyId: number, userId: string): Promise<number> {
  const survivor = await survivorOf(t, companyId);
  if (!survivor) throw notFound('That company');
  const visible = await t.one(`SELECT 1 AS ok FROM companies WHERE id = ? AND ${companyVisibleTo('')}`, [survivor.id, userId]);
  if (!visible) throw notFound('That company');
  return survivor.id;
}

/**
 * The company's open and closed jobs the viewer may see, and its newest posting. v30 FIX-C UX-3: a held job (one the
 * viewer added, waiting for approval) is not the company's: the page counts and lists what its search link finds
 * (search never lists held jobs), as company_job_counts counts.
 *
 * v30 FIX-PERF (PG-LOAD PGL-1): the open jobs and the closed ones are counted apart, each on its partial index
 * (idx_jobs_company_open WHERE active, idx_jobs_company_closed WHERE NOT active): jobs has no index on company_id over
 * every row, so one count over both read the whole table on every view (0.9-10.7 s at mix B's base size).
 */
async function countsOf(t: DbQueries, companyId: number, userId: string): Promise<CompanyPage['counts']> {
  const row = await t.one<{ open_jobs: number; closed_jobs: number; last_posted_at: string | null }>(
    `SELECT o.open_jobs, o.last_posted_at,
       (SELECT count(*) FROM jobs j WHERE j.company_id = @companyId AND NOT j.active
          AND ${jobVisibleTo('j', '@userId')} AND j.held_since IS NULL)::int AS closed_jobs
     FROM (SELECT count(*)::int AS open_jobs, max(j.posted_sort) AS last_posted_at
           FROM jobs j WHERE j.company_id = @companyId AND j.active AND ${jobVisibleTo('j', '@userId')} AND j.held_since IS NULL) o`,
    { companyId, userId },
  );
  return { openJobs: row?.open_jobs ?? 0, closedJobs: row?.closed_jobs ?? 0, lastPostedAt: row?.last_posted_at ?? null };
}

/** GET /api/companies/:id: the company page. */
export async function companyPage(deps: Pick<AppDeps, 'db'>, companyId: number, userId: string): Promise<CompanyPage> {
  const db = deps.db;
  const id = await visibleCompanyId(db, companyId, userId);
  const row = (await db.one<{ name: string; detail: string | null }>(`SELECT c.name, ${COMPANY_DETAIL_SQL('c')} AS detail FROM companies c WHERE c.id = ?`, [id]))!;
  const { profile, row: profileRow, json } = profileOfDetail(row.detail);
  const counts = await countsOf(db, id, userId);
  // v31 LINK (21-jobs-from-links.md §6): a company whose jobs all wait for an admin (held: TailorIT read them, an
  // admin approves new jobs by hand) is shown to no one until one of them is public, but to an account that added one.
  // Only a company with no job the viewer sees is looked at (a few rows: its jobs are all held or others' own).
  if (counts.openJobs === 0 && counts.closedJobs === 0 && (await onlyHeldJobs(db, id, userId))) throw notFound('That company');
  return {
    id,
    name: row.name,
    profile,
    parent: json.parent ? { id: json.parent.id, name: json.parent.name } : null,
    sources: sourcesLineOf(json.sources),
    updatedAt: profileRow?.updated_at ? new Date(profileRow.updated_at).toISOString() : null,
    counts,
  };
}

/** v31 LINK: whether the company has a held job and no job the viewer sees (each side on its partial index). */
async function onlyHeldJobs(t: DbQueries, companyId: number, userId: string): Promise<boolean> {
  const row = await t.one<{ held: boolean; seen: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM jobs h WHERE h.company_id = @companyId AND h.active AND h.held_since IS NOT NULL)
          OR EXISTS (SELECT 1 FROM jobs h WHERE h.company_id = @companyId AND NOT h.active AND h.held_since IS NOT NULL)) AS held,
       (EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = @companyId AND j.active AND ${jobVisibleTo('j', '@userId')})
          OR EXISTS (SELECT 1 FROM jobs j WHERE j.company_id = @companyId AND NOT j.active AND ${jobVisibleTo('j', '@userId')})) AS seen`,
    { companyId, userId },
  );
  return row?.held === true && row.seen !== true;
}

/** A page's cursor: the last card's sort time and id. */
function encodeCursor(at: string | null, id: number): string {
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}

function decodeCursor(text: string | undefined): { at: string | null; id: number } | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value as [unknown, unknown];
    if ((at !== null && (typeof at !== 'string' || Number.isNaN(Date.parse(at)))) || typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
    return { at: at as string | null, id };
  } catch {
    return null;
  }
}

/**
 * v36 FIX-SRC (the final data review's D3): the time an open position's row shows (jobs/rows.ts postingTimesOf), in SQL,
 * as migration 0061's idx_jobs_company_open_shown holds it (the index's expression: keep the same text).
 */
export const OPEN_SHOWN_SORT = 'GREATEST(j.posted_sort, j.reposted_at)';

/** GET /api/companies/:id/jobs?state=open|closed&cursor=: one page of the company's open positions or closed history. */
export async function companyJobs(
  deps: Pick<AppDeps, 'db'>,
  companyId: number,
  userId: string,
  query: CompanyJobsQuery,
  rule: PostedRule = DEFAULT_POSTED_RULE, // v36 IMPORTTIME: how a job an admin's import dated reads (jobs/rows.ts)
): Promise<CompanyJobsResponse> {
  const db = deps.db;
  const id = await visibleCompanyId(db, companyId, userId);
  const open = query.state === 'open';
  // The partial indexes idx_jobs_company_open (posted_sort DESC, id DESC) and idx_jobs_company_closed (closed_at DESC,
  // id DESC). v30 FIX-PERF (PG-LOAD PGL-2): in their order (DESC, nulls first), so a page reads its entries and no sort: neither
  // column is ever null (posted_sort is COALESCE(posted_at, first_seen_at); a closed job has its closed_at by the
  // table's CHECK), so the order and the keyset need no NULLS LAST and no "or null" (a cursor with no time, which
  // these lists never make, still reads as one).
  // v36 FIX-SRC (the final data review's D3): the open positions follow the time each row shows (postingTimesOf: the
  // later of the job's own date and an admin's import of it, jobs.reposted_at), on idx_jobs_company_open_shown (migration
  // 0061: the same expression, never null either), so a job an admin imported an hour ago, reading "1 hour ago", is
  // listed above one reading "2 days ago".
  const sort = open ? OPEN_SHOWN_SORT : 'j.closed_at';
  const cursor = decodeCursor(query.cursor);
  const after = cursor
    ? cursor.at === null
      ? `AND ${sort} IS NULL AND j.id < @cursorId`
      : `AND (${sort}, j.id) < (CAST(@cursorAt AS timestamptz), @cursorId)`
    : '';
  const rows = await db.all<SummaryRow & { closed_at: string | null; sort_at: string | null }>(
    `SELECT ${SUMMARY_COLUMNS}, j.closed_at, ${sort} AS sort_at
     FROM jobs j JOIN companies c ON c.id = j.company_id ${APPLICATION_JOIN}
     WHERE j.company_id = @companyId AND ${open ? 'j.active' : 'NOT j.active'} AND ${jobVisibleTo('j', '@userId')} AND j.held_since IS NULL ${after}
     ORDER BY ${sort} DESC, j.id DESC
     LIMIT @limit`,
    { companyId: id, userId, cursorAt: cursor?.at ?? null, cursorId: cursor?.id ?? 0, limit: JOBS_PAGE_SIZE + 1 },
  );
  const page = rows.slice(0, JOBS_PAGE_SIZE);
  const items: CompanyJobItem[] = page.map((row) => ({ ...toSummary(row, rule), closedAt: isoTimestamp(row.closed_at) }));
  const last = page[page.length - 1];
  return { items, ...(rows.length > JOBS_PAGE_SIZE && last ? { nextCursor: encodeCursor(last.sort_at, last.id) } : {}) };
}
