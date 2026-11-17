import {
  BOARD_COLUMN_ORDER,
  DISPLAY_STATUS_DRAFT,
  STATUS,
  type ApplicationStatus,
  type ApplicationSummary,
  type BoardColumn,
  type DisplayStatus,
  type EmploymentType,
  type SortOrder,
  type TrackerSort,
} from '@tailorit/shared';
import type { Dialect } from '../../core/db/dialect';
import type { DbQueries, SqlParam } from '../../core/db/types';
import { validationFailed } from '../../core/http/errors';
import {
  APPLICATION_COLUMNS,
  APPLICATION_FROM,
  LIVE_QUEUE_ROW_AT_SQL,
  loadEventsFor,
  toSummary,
  type ApplicationRow,
} from './store';

// Reads over many applications: the Options-menu filters and search as SQL, the three sorts, and keyset cursors
// (the sort key plus the id) so "Load more" never skips or repeats a card when others move between pages.
// v3.0 D2: async on a DbQueries; the search's LIKE and the flags are the dialect's (the same on both engines).
// v3.0 PG-D: PostgreSQL's shape (tracked_on a `date`, created_at a `timestamptz`): the date filter compares days, and
// a sort's key is its typed columns compared as one row value (no text spelling of a day or a time).

export type TabScope = 'active' | 'archived' | 'all';

export interface ApplicationFilter {
  tab: TabScope;
  q?: string;
  statuses?: readonly ApplicationStatus[];
  jobType?: EmploymentType;
  favorites?: boolean;
  /** Applied from / until, inclusive "YYYY-MM-DD". */
  from?: string;
  until?: string;
}

export interface SortSpec {
  sort: TrackerSort;
  order: SortOrder;
}

export interface Fragment {
  sql: string;
  params: SqlParam[];
}

/**
 * The day an application counts as applied for the date filters: its Applied event, else the day it was tracked
 * (a Saved application has not been applied to yet; it is filtered by when it was added).
 * v3.0 PG-D: both days are `date` columns, compared with a bound "YYYY-MM-DD".
 */
const APPLIED_ON_SQL =
  '(COALESCE((SELECT e.occurred_on FROM application_status_events e WHERE e.application_id = a.id AND e.status = 2), a.tracked_on))';

/**
 * Each sort's key (alias `a`): the columns it orders by before the id, which breaks ties. The tracked sort is the
 * tracked day, then the moment the entry was added (several share a day); the Saved pane (auto-apply/saved.ts) orders
 * by the same two. v3.0 PG-D: typed columns compared as one row value, `(a.tracked_on, a.created_at, a.id) < (?, ?, ?)`,
 * instead of v2.0's text key `substr(a.tracked_on, 1, 10) || '|' || a.created_at` (a `date` and a `timestamptz` on
 * PostgreSQL): the same order, on both engines.
 */
interface KeyColumn {
  sql: string;
  /** A cursor's value for it is one the column compares with (a tampered cursor is stale, never a database error). */
  valid: (value: string) => boolean;
}

const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}/.test(value);
const isTime = (value: string) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

const SORT_KEYS: Record<TrackerSort, readonly KeyColumn[]> = {
  tracked: [
    { sql: 'a.tracked_on', valid: isDay },
    { sql: 'a.created_at', valid: isTime },
  ],
  created: [{ sql: 'a.created_at', valid: isTime }],
  title: [{ sql: 'lower(a.title)', valid: () => true }],
};

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The WHERE clause of a filter for one account (table alias `a`), in the dialect's SQL. */
export function filterClause(d: Dialect, userId: string, filter: ApplicationFilter): Fragment {
  const parts = ['a.user_id = ?'];
  const params: SqlParam[] = [userId];
  if (filter.tab === 'active') parts.push('a.archived_at IS NULL');
  else if (filter.tab === 'archived') parts.push('a.archived_at IS NOT NULL');

  // Every word must appear in the title, the company or the location (case-insensitive, `\` escaping).
  const terms = (filter.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 10);
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    parts.push(`(${d.like('a.title', '?')} OR ${d.like('a.company_name', '?')} OR ${d.like('a.location', '?')})`);
    params.push(like, like, like);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    parts.push(`a.current_status IN (${d.list(filter.statuses.length)})`);
    params.push(...filter.statuses);
  }
  if (filter.jobType) {
    parts.push('a.employment_type = ?');
    params.push(filter.jobType);
  }
  if (filter.favorites) parts.push(`a.favorite = ${d.true}`);
  if (filter.from) {
    parts.push(`${APPLIED_ON_SQL} >= ?`);
    params.push(filter.from);
  }
  if (filter.until) {
    parts.push(`${APPLIED_ON_SQL} <= ?`);
    params.push(filter.until);
  }
  return { sql: parts.join(' AND '), params };
}

interface CursorValue {
  /** The last row's sort key. */
  k: string;
  id: string;
  /** What the page was read under (sort, order, board column): a cursor is only valid for the same read. */
  s: string;
}

const STALE_CURSOR = 'That page of applications is out of date. Reload the tracker and try again.';

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, scope: string): CursorValue {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorValue>;
    if (typeof value.k === 'string' && typeof value.id === 'string' && value.s === scope) {
      return { k: value.k, id: value.id, s: value.s };
    }
  } catch {
    // fall through
  }
  throw validationFailed(STALE_CURSOR);
}

/** Between a key's values in a cursor: a day or a time never holds it, and only the last value may (a title). */
const KEY_SEPARATOR = '|';

/** A cursor's key text from a row's key values ("2026-10-22|2026-10-22T12:00:00.000Z", v2.0's form). */
export function keyText(values: readonly unknown[]): string {
  return values.map((value) => String(value ?? '')).join(KEY_SEPARATOR);
}

/** A cursor's key values for `sort` from its key text; a key of another shape is a stale cursor. */
export function keyValues(text: string, sort: TrackerSort): string[] {
  const columns = SORT_KEYS[sort];
  const values: string[] = [];
  let rest = text;
  for (let index = 1; index < columns.length; index += 1) {
    const at = rest.indexOf(KEY_SEPARATOR);
    if (at < 0) throw validationFailed(STALE_CURSOR);
    values.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  values.push(rest);
  if (!values.every((value, index) => columns[index]!.valid(value))) throw validationFailed(STALE_CURSOR);
  return values;
}

/** The read a cursor belongs to. */
export function cursorScope(spec: SortSpec, column?: DisplayStatus): string {
  return `${spec.sort}:${spec.order}${column === undefined ? '' : `:${column}`}`;
}

function cursorClause(d: Dialect, spec: SortSpec, cursor: string | undefined, scope: string): Fragment | null {
  if (!cursor) return null;
  const { k, id } = decodeCursor(cursor, scope);
  const columns = SORT_KEYS[spec.sort].map((column) => column.sql);
  const op = spec.order === 'desc' ? '<' : '>';
  return { sql: `(${columns.join(', ')}, a.id) ${op} (${d.list(columns.length + 1)})`, params: [...keyValues(k, spec.sort), id] };
}

/** The ORDER BY of a sort (table alias `a`), the id breaking ties; the resume ZIP lists applications this way too. */
export function orderClause(spec: SortSpec): string {
  const direction = spec.order === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${SORT_KEYS[spec.sort].map((column) => `${column.sql} ${direction}`).join(', ')}, a.id ${direction}`;
}

/** A sort's key columns as `sort_key_0`, `sort_key_1`, ... in a SELECT list. */
const sortKeyColumns = (spec: SortSpec) =>
  SORT_KEYS[spec.sort].map((column, index) => `${column.sql} AS sort_key_${index}`).join(', ');

type SortedRow = ApplicationRow & Record<`sort_key_${number}`, unknown>;

export interface PageResult {
  items: ApplicationSummary[];
  nextCursor?: string;
}

/** One page of matching applications (events included), with the cursor of the next page when there is one. */
export async function pageOfApplications(
  db: DbQueries,
  where: Fragment,
  spec: SortSpec,
  cursor: string | undefined,
  pageSize: number,
  scope: string = cursorScope(spec),
): Promise<PageResult> {
  // SQLite binds a fractional LIMIT as a type mismatch.
  const limit = Math.max(1, Math.floor(pageSize));
  const after = cursorClause(db.dialect, spec, cursor, scope);
  const rows = await db.all<SortedRow>(
    `SELECT ${APPLICATION_COLUMNS}, ${sortKeyColumns(spec)} FROM ${APPLICATION_FROM}
     WHERE ${where.sql}${after ? ` AND ${after.sql}` : ''} ${orderClause(spec)} LIMIT ?`,
    [...where.params, ...(after?.params ?? []), limit + 1],
  );
  const page = rows.slice(0, limit);
  const events = await loadEventsFor(
    db,
    page.map((row) => row.id),
  );
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toSummary(row, events.get(row.id) ?? [])),
    ...(rows.length > limit && last
      ? { nextCursor: encodeCursor({ k: keyText(SORT_KEYS[spec.sort].map((_, index) => last[`sort_key_${index}`])), id: last.id, s: scope }) }
      : {}),
  };
}

export async function countApplications(db: DbQueries, where: Fragment): Promise<number> {
  const row = await db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM applications a WHERE ${where.sql}`, where.params);
  return row!.n;
}

/** Every matching application row (CSV export, chart), in the given order, without paging. */
export function allApplicationRows(db: DbQueries, where: Fragment, spec: SortSpec): Promise<ApplicationRow[]> {
  return db.all<ApplicationRow>(
    `SELECT ${APPLICATION_COLUMNS} FROM ${APPLICATION_FROM} WHERE ${where.sql} ${orderClause(spec)}`,
    where.params,
  );
}

/**
 * The cards of one board column: a stored status, Saved without a live queue row, or (v20 A30) Draft, the Saved entries
 * whose job has a live queue row.
 */
function withStatus(where: Fragment, status: DisplayStatus): Fragment {
  if (status === DISPLAY_STATUS_DRAFT) {
    return { sql: `${where.sql} AND a.current_status = ? AND ${LIVE_QUEUE_ROW_AT_SQL} IS NOT NULL`, params: [...where.params, STATUS.saved] };
  }
  if (status === STATUS.saved) {
    return { sql: `${where.sql} AND a.current_status = ? AND ${LIVE_QUEUE_ROW_AT_SQL} IS NULL`, params: [...where.params, status] };
  }
  return { sql: `${where.sql} AND a.current_status = ?`, params: [...where.params, status] };
}

/**
 * The board: one column per status with its total under the filter and its first page (or, with `only`, that one
 * column from `cursor`). A status the filter leaves out is an empty column. v20 A30: the columns are BOARD_COLUMN_ORDER,
 * Draft (`'draft'`, the Saved entries whose job has a live queue row) right after Saved, which then holds the others.
 */
export async function boardColumns(
  db: DbQueries,
  userId: string,
  filter: ApplicationFilter,
  spec: SortSpec,
  limit: number,
  only?: { status: DisplayStatus; cursor?: string },
): Promise<BoardColumn[]> {
  const where = filterClause(db.dialect, userId, filter);
  const totals = new Map<DisplayStatus, number>();
  // Each card's column as text on both engines ('draft', or the status's number): one CASE answers one type.
  const rows = await db.all<{ status: string; n: number }>(
    `SELECT CASE WHEN a.current_status = ${STATUS.saved} AND ${LIVE_QUEUE_ROW_AT_SQL} IS NOT NULL THEN 'draft'
              ELSE CAST(a.current_status AS TEXT) END AS status, COUNT(*) AS n
     FROM applications a WHERE ${where.sql} GROUP BY 1`,
    where.params,
  );
  for (const row of rows) {
    const status: DisplayStatus = row.status === DISPLAY_STATUS_DRAFT ? DISPLAY_STATUS_DRAFT : (Number(row.status) as ApplicationStatus);
    totals.set(status, row.n);
  }

  const statuses = only ? [only.status] : BOARD_COLUMN_ORDER;
  const columns: BoardColumn[] = [];
  for (const status of statuses) {
    const total = totals.get(status) ?? 0;
    if (total === 0) {
      columns.push({ status, total, items: [] });
      continue;
    }
    const page = await pageOfApplications(db, withStatus(where, status), spec, only?.cursor, limit, cursorScope(spec, status));
    columns.push({ status, total, items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
  }
  return columns;
}
