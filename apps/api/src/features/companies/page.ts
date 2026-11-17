import { JOBS_PAGE_SIZE, type CompanyJobItem, type CompanyJobsQuery, type CompanyJobsResponse, type CompanyPage } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { notFound } from '../../core/http/errors';
import { APPLICATION_JOIN, SUMMARY_COLUMNS, isoTimestamp, toSummary, type SummaryRow } from '../jobs/rows';
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
  return {
    id,
    name: row.name,
    profile,
    parent: json.parent ? { id: json.parent.id, name: json.parent.name } : null,
    sources: sourcesLineOf(json.sources),
    updatedAt: profileRow?.updated_at ? new Date(profileRow.updated_at).toISOString() : null,
    counts: await countsOf(db, id, userId),
  };
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

/** GET /api/companies/:id/jobs?state=open|closed&cursor=: one page of the company's open positions or closed history. */
export async function companyJobs(deps: Pick<AppDeps, 'db'>, companyId: number, userId: string, query: CompanyJobsQuery): Promise<CompanyJobsResponse> {
  const db = deps.db;
  const id = await visibleCompanyId(db, companyId, userId);
  const open = query.state === 'open';
  // The partial indexes idx_jobs_company_open (posted_sort DESC, id DESC) and idx_jobs_company_closed (closed_at DESC,
  // id DESC). v30 FIX-PERF (PG-LOAD PGL-2): in their order (DESC, nulls first), so a page reads its entries and no sort: neither
  // column is ever null (posted_sort is COALESCE(posted_at, first_seen_at); a closed job has its closed_at by the
  // table's CHECK), so the order and the keyset need no NULLS LAST and no "or null" (a cursor with no time, which
  // these lists never make, still reads as one).
  const sort = open ? 'j.posted_sort' : 'j.closed_at';
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
  const items: CompanyJobItem[] = page.map((row) => ({ ...toSummary(row), closedAt: isoTimestamp(row.closed_at) }));
  const last = page[page.length - 1];
  return { items, ...(rows.length > JOBS_PAGE_SIZE && last ? { nextCursor: encodeCursor(last.sort_at, last.id) } : {}) };
}
