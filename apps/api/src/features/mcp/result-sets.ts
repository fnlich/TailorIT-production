import { randomBytes } from 'node:crypto';
import type { AppDeps } from '../../core/context';
import { AppError, validationFailed } from '../../core/http/errors';

// v1.5 Q2: result sets (migration 0818, mcp_result_sets). A search's or a list's matching job ids, kept server-side
// with the query that made them, so the person's AI names thousands of jobs by one `setId` (save_jobs, queue_remove, ...)
// instead of sending their ids through its tokens. A set is its account's alone (another account's id is "not found"),
// lives SET_TTL_MS, holds at most SET_MAX_IDS ids in the answer's order, and an account keeps at most
// SETS_PER_ACCOUNT: making one deletes the expired ones and the account's oldest beyond the cap. Only this file touches
// the table.
// v3.0 D2 (11-database.md §9.3, the concurrency audit): the cap is an insert, then a delete beyond the newest 50, in one
// transaction that starts with the person's lock. Without it two saves at once on PostgreSQL would each delete beyond
// 50 of the rows they see (their own insert and the committed ones) and leave 51.

export const SET_TTL_MS = 24 * 60 * 60_000;
export const SET_MAX_IDS = 5_000;
export const SETS_PER_ACCOUNT = 50;

/** v2.0 P5: `filter`, a filter_jobs run (its passing job ids; prepare_start takes it by its id). */
export type SetSource = 'search' | 'applications' | 'queue' | 'filter';

export interface ResultSet {
  id: string;
  source: SetSource;
  query: unknown;
  ids: number[];
  /** Every match when the set was made; more than ids.length when the set was cut at SET_MAX_IDS. */
  total: number;
  createdAt: string;
  expiresAt: string;
}

type Deps = Pick<AppDeps, 'db' | 'now'>;

const SET_ID = /^rs_[A-Za-z0-9_-]{6,30}$/;

export const SET_GONE =
  'That result set is not there any more (sets last 24 hours, and an account keeps its 50 newest). Search again for a new setId.';

/** Keeps the matches as a new set of the account and answers it. */
export async function saveResultSet(
  deps: Deps,
  userId: string,
  source: SetSource,
  query: unknown,
  ids: readonly number[],
  total: number,
): Promise<ResultSet> {
  const now = deps.now();
  const id = `rs_${randomBytes(9).toString('base64url')}`;
  const kept = ids.slice(0, SET_MAX_IDS);
  const set: ResultSet = {
    id,
    source,
    query,
    ids: kept,
    total: Math.max(total, kept.length),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SET_TTL_MS).toISOString(),
  };
  await deps.db.tx(
    async (t) => {
      // Count (the newest 50), then write: behind the person's lock, so two saves at once keep the cap.
      await t.lockPerson(userId);
      await t.run('DELETE FROM mcp_result_sets WHERE expires_at <= ?', [set.createdAt]);
      await t.run(
        `INSERT INTO mcp_result_sets(id, user_id, source, query, ids, total, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, source, JSON.stringify(query ?? {}), JSON.stringify(kept), set.total, set.createdAt, set.expiresAt],
      );
      // seq: the insertion order among sets of one instant (v3.0 PG-G: the baseline's identity column).
      await t.run(
        `DELETE FROM mcp_result_sets WHERE user_id = ? AND id NOT IN (
           SELECT id FROM mcp_result_sets WHERE user_id = ? ORDER BY created_at DESC, ${t.dialect.seq()} DESC LIMIT ${SETS_PER_ACCOUNT})`,
        [userId, userId],
      );
    },
    { label: 'saveResultSet' },
  );
  return set;
}

/** One of the account's live sets; a refusal (not_found) for an unknown, expired or another account's id. */
export async function loadResultSet(deps: Deps, userId: string, id: string): Promise<ResultSet> {
  if (!SET_ID.test(id)) throw validationFailed('setId: use a setId a search or list answered (rs_...).', { setId: 'Not a setId' });
  const row = await deps.db.one<{
    id: string;
    source: SetSource;
    query: string;
    ids: string;
    total: number;
    created_at: string;
    expires_at: string;
  }>(
    `SELECT id, source, query, ids, total, created_at, expires_at FROM mcp_result_sets
     WHERE id = ? AND user_id = ? AND expires_at > ?`,
    [id, userId, deps.now().toISOString()],
  );
  if (!row) throw new AppError('not_found', SET_GONE);
  return {
    id: row.id,
    source: row.source,
    query: JSON.parse(row.query) as unknown,
    ids: (JSON.parse(row.ids) as unknown[]).filter((value): value is number => Number.isSafeInteger(value)),
    total: row.total,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** A page cursor over a set: "<setId>.<offset>". */
export function setCursor(setId: string, offset: number): string {
  return `${setId}.${offset}`;
}

export function readSetCursor(cursor: string): { setId: string; offset: number } {
  const at = cursor.lastIndexOf('.');
  const offset = Number(cursor.slice(at + 1));
  if (at < 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw validationFailed('cursor: use the `next` value of the last answer as it is.', { cursor: 'Not a cursor' });
  }
  return { setId: cursor.slice(0, at), offset };
}

/** The job ids a bulk tool acts on: its `ids`, or a set's ids less `exclude`, at most `limit` of them. */
export interface Targets {
  ids: number[];
  /** The set they came from, when one was named. */
  setId: string | null;
}

export const MAX_DIRECT_IDS = 500;

export async function targetsOf(
  deps: Deps,
  userId: string,
  input: { ids?: number[]; setId?: string; exclude?: number[]; limit?: number },
): Promise<Targets> {
  const hasIds = input.ids !== undefined && input.ids.length > 0;
  if (hasIds === (input.setId !== undefined)) {
    throw validationFailed('Send either ids (at most 500 job ids) or setId (from a search or list), not both.');
  }
  if (hasIds) {
    if (input.ids!.length > MAX_DIRECT_IDS) throw validationFailed(`ids: at most ${MAX_DIRECT_IDS}; use a setId for more.`);
    return { ids: [...new Set(input.ids!)], setId: null };
  }
  const set = await loadResultSet(deps, userId, input.setId!);
  const exclude = new Set(input.exclude ?? []);
  const ids = set.ids.filter((id) => !exclude.has(id));
  return { ids: input.limit !== undefined ? ids.slice(0, input.limit) : ids, setId: set.id };
}
