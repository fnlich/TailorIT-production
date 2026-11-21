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
// v33 SHARE-8 (PLAN-sharing.md §7 "Handles"): a set is its CALLER's (user_id: the token's account, whose 50 newest are
// kept) and is bound to the PROFILE it was made on (profile_user_id and grant_id, migration 0049: NULL for the caller's
// own). A set is read only on that profile: one named on another profile is refused (SET_OTHER_PROFILE), one made under
// a grant that is not the call's (an earlier grant, ended since: a share made again is a new grant) is gone (SET_GONE),
// and endGrant's `mcp_sets` step deletes a grant's sets as its access ends (deleteGrantSets).

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

// v33 SHARE-8
/** Who keeps a set (the caller) and the profile it lists (the owner's data; grantId null: the caller's own profile). */
export interface SetScope {
  readonly callerId: string;
  readonly profileUserId: string;
  readonly grantId: string | null;
}
/** A set's owner: the account (its own profile, as before v3.3) or a caller on a profile. */
export type SetOwner = string | SetScope;

const scopeOf = (owner: SetOwner): SetScope =>
  typeof owner === 'string' ? { callerId: owner, profileUserId: owner, grantId: null } : owner;

/** A set named on another profile than the one it was made on. */
export const SET_OTHER_PROFILE =
  'That setId was made on another profile: send the "profile" it was made on, or search again on this one.';
// end v33 SHARE-8

const SET_ID = /^rs_[A-Za-z0-9_-]{6,30}$/;

export const SET_GONE =
  'That result set is not there any more (sets last 24 hours, and an account keeps its 50 newest). Search again for a new setId.';

/** Keeps the matches as a new set of the account and answers it. */
export async function saveResultSet(
  deps: Deps,
  owner: SetOwner, // v33 SHARE-8: the caller and the profile (an account id: its own)
  source: SetSource,
  query: unknown,
  ids: readonly number[],
  total: number,
): Promise<ResultSet> {
  const scope = scopeOf(owner);
  const userId = scope.callerId;
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
      // v33 SHARE-8: the profile it lists and its grant (NULL on the caller's own profile).
      const shared = scope.grantId !== null;
      await t.run(
        `INSERT INTO mcp_result_sets(id, user_id, source, query, ids, total, created_at, expires_at, profile_user_id, grant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          userId,
          source,
          JSON.stringify(query ?? {}),
          JSON.stringify(kept),
          set.total,
          set.createdAt,
          set.expiresAt,
          shared ? scope.profileUserId : null,
          shared ? scope.grantId : null,
        ],
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

/**
 * One of the account's live sets; a refusal (not_found) for an unknown, expired or another account's id. v33 SHARE-8:
 * `owner` the caller on a profile: a set made on another profile is refused (SET_OTHER_PROFILE), and one made under an
 * earlier grant of the same profile is gone (SET_GONE).
 */
export async function loadResultSet(deps: Deps, owner: SetOwner, id: string): Promise<ResultSet> {
  const scope = scopeOf(owner);
  const userId = scope.callerId;
  if (!SET_ID.test(id)) throw validationFailed('setId: use a setId a search or list answered (rs_...).', { setId: 'Not a setId' });
  const row = await deps.db.one<{
    id: string;
    source: SetSource;
    query: string;
    ids: string;
    total: number;
    created_at: string;
    expires_at: string;
    profile_user_id: string | null;
    grant_id: string | null;
  }>(
    `SELECT id, source, query, ids, total, created_at, expires_at, profile_user_id, grant_id FROM mcp_result_sets
     WHERE id = ? AND user_id = ? AND expires_at > ?`,
    [id, userId, deps.now().toISOString()],
  );
  if (!row) throw new AppError('not_found', SET_GONE);
  // v33 SHARE-8: the set's profile against the call's.
  if ((row.profile_user_id ?? userId) !== scope.profileUserId) throw validationFailed(SET_OTHER_PROFILE, { setId: 'Another profile' });
  if ((row.grant_id ?? null) !== scope.grantId) throw new AppError('not_found', SET_GONE);
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
  owner: SetOwner, // v33 SHARE-8
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
  const set = await loadResultSet(deps, owner, input.setId!);
  const exclude = new Set(input.exclude ?? []);
  const ids = set.ids.filter((id) => !exclude.has(id));
  return { ids: input.limit !== undefined ? ids.slice(0, input.limit) : ids, setId: set.id };
}

// v33 SHARE-8 ------------------------------------------------------------------------------------------------------------

/**
 * The grant a live set of the caller's was made under: null for one of their own profile, undefined when there is no
 * such live set (the session decides a call's profile from its handle with it, profiles.ts).
 */
export async function setGrantOf(deps: Deps, callerId: string, id: string): Promise<string | null | undefined> {
  if (!SET_ID.test(id)) return undefined;
  const row = await deps.db.one<{ grant_id: string | null }>(
    'SELECT grant_id FROM mcp_result_sets WHERE id = ? AND user_id = ? AND expires_at > ?',
    [id, callerId, deps.now().toISOString()],
  );
  return row ? row.grant_id : undefined;
}

/** The sources a permission's sets come from (a removed permission ends those): the rest need `mcp` and `tracker:view`. */
const SOURCES_OF: Partial<Record<string, readonly SetSource[]>> = {
  'prepare:run': ['filter'],
  'prepare:view': ['filter', 'queue'],
  // v33 SHARE-8 (review): a filter run's rows keep the reasons as the caller could see them when it ran (an eligibility
  // reason by name with Sensitive answers' See): once that box goes, its later pages go with it.
  'sensitive:view': ['filter'],
};

/**
 * endGrant's `mcp_sets` step (features/sharing/end-grant.ts, step 4): the grant's sets are deleted. `permissions` null
 * (the grant ended, an account disabled) or one of them `mcp` or `tracker:view` (every set needs both): all of them;
 * `prepare:run`, `prepare:view` or `sensitive:view` alone: the filter runs (and, for `prepare:view`, the queue lists).
 * Safe to run twice. Answers how many.
 */
export async function deleteGrantSets(
  deps: Pick<AppDeps, 'db'>,
  grantId: string,
  permissions: readonly string[] | null,
): Promise<number> {
  if (permissions === null || permissions.includes('mcp') || permissions.includes('tracker:view')) {
    return (await deps.db.run('DELETE FROM mcp_result_sets WHERE grant_id = ?', [grantId])).changes;
  }
  const sources = [...new Set(permissions.flatMap((perm) => SOURCES_OF[perm] ?? []))];
  if (sources.length === 0) return 0;
  return (
    await deps.db.run(
      `DELETE FROM mcp_result_sets WHERE grant_id = ? AND source IN (SELECT value FROM ${deps.db.dialect.jsonEach('?')})`,
      [grantId, JSON.stringify(sources)],
    )
  ).changes;
}
// end v33 SHARE-8
