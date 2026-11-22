import { createHash } from 'node:crypto';
import type { AiTaskKind } from '@tailorit/shared';
import type { DbClient, DbQueries } from '../core/db/types';
import { DAY_MS } from '@tailorit/shared';

// v1.3 C (decision 11): answers the AI need not give twice (ai_result_cache, migration 0812). A handler asks the cache
// first, item by item, sends the AI only the items it misses, and stores each checked answer it may keep. A row is keyed
// by the task kind, the model, the prompt's version, a scope and a hash of everything the answer depends on; it is kept
// 30 days, and a model or prompt change simply misses.
//
// The scope says who may read a row. `shared` rows are for answers that hold nothing of a person: a question's
// category (autofill_classify reads page text alone). Everything that came from a person's facts, or from a value of
// theirs (an option tiebreak's value, an answer from their resume), is cached under their account and read by them
// alone, and goes with the account.

/** How long a cached answer is kept. */
export const RESULT_CACHE_DAYS = 30;

/** A stable JSON text: object keys sorted at every depth, undefined dropped (so equal values hash equally). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : stableJson(item))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/** The sha-256 of a value's stable JSON, in hex: an item's cache key, or a part of one (a person's facts, a job). */
export function itemHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

/** Whose a row is: every account's (an answer that holds nothing of a person), or one account's. */
export type CacheScope = { shared: true } | { userId: string };

export interface CacheKey {
  kind: AiTaskKind;
  model: string;
  version: number;
  scope: CacheScope;
}

export interface ResultCache {
  /** The cached answers of these item hashes that have not expired, by hash. */
  getMany<T>(key: CacheKey, hashes: readonly string[]): Promise<Map<string, T>>;
  /** Stores (or replaces) answers by item hash, for RESULT_CACHE_DAYS. */
  putMany(key: CacheKey, entries: ReadonlyArray<readonly [string, unknown]>): Promise<void>;
}

/** A cache key's scope column and owner. */
export const scopeOf = (scope: CacheScope) =>
  'shared' in scope ? { scope: '', userId: null } : { scope: scope.userId, userId: scope.userId };

/** The cache's SQL. */
export const RESULT_CACHE_SQL = {
  get:
    'SELECT result FROM ai_result_cache WHERE kind = ? AND model = ? AND prompt_version = ? AND scope = ? ' +
    'AND item_hash = ? AND expires_at > ?',
  put:
    'INSERT INTO ai_result_cache(kind, model, prompt_version, scope, item_hash, user_id, result, created_at, expires_at) ' +
    'VALUES (@kind, @model, @version, @scope, @hash, @userId, @result, @at, @expires) ' +
    'ON CONFLICT(kind, model, prompt_version, scope, item_hash) DO UPDATE SET result = excluded.result, ' +
    'created_at = excluded.created_at, expires_at = excluded.expires_at',
} as const;

/** The put's rows for a key and its entries (createResultCache and its twin). */
export function cacheRows(key: CacheKey, entries: ReadonlyArray<readonly [string, unknown]>, now: () => Date) {
  const { scope, userId } = scopeOf(key.scope);
  const atMs = now().getTime();
  const at = new Date(atMs).toISOString();
  const expires = new Date(atMs + RESULT_CACHE_DAYS * DAY_MS).toISOString();
  return entries.map(([hash, result]) => ({
    kind: key.kind,
    model: key.model,
    version: key.version,
    scope,
    hash,
    userId,
    result: JSON.stringify(result),
    at,
    expires,
  }));
}

/** A row's answer, or undefined when it is unreadable (asked again). */
export function cachedAnswer<T>(row: { result: string } | undefined): T | undefined {
  if (!row) return undefined;
  try {
    return JSON.parse(row.result) as T;
  } catch {
    return undefined;
  }
}

/** v3.0 D2: on the async client (`deps.db`); a putMany inside a caller's transaction joins it. */
export function createResultCache(client: DbClient, now: () => Date): ResultCache {
  return {
    async getMany<T>(key: CacheKey, hashes: readonly string[]): Promise<Map<string, T>> {
      const { scope } = scopeOf(key.scope);
      const at = now().toISOString();
      const found = new Map<string, T>();
      for (const hash of new Set(hashes)) {
        const answer = cachedAnswer<T>(await client.one<{ result: string }>(RESULT_CACHE_SQL.get, [key.kind, key.model, key.version, scope, hash, at]));
        if (answer !== undefined) found.set(hash, answer);
      }
      return found;
    },
    async putMany(key, entries) {
      if (entries.length === 0) return;
      const rows = cacheRows(key, entries, now);
      await client.atomic(async (t) => {
        for (const row of rows) await t.run(RESULT_CACHE_SQL.put, row);
      });
    },
  };
}

/**
 * Deletes the expired rows. v34 PUBLIC (PLAN G8, the review's finding 6): with `personalKeepDays` (the queue passes
 * AI_TASK_KEEP_DAYS), an account's rows are also deleted once older than that, so the Privacy page's "what was sent to
 * the AI for a task, and its answer, are deleted within N days" holds when an admin keeps tasks fewer days than
 * RESULT_CACHE_DAYS. Shared rows (nothing of a person) keep RESULT_CACHE_DAYS.
 */
export async function pruneResultCache(db: Pick<DbQueries, 'run'>, now: Date, personalKeepDays?: number): Promise<number> {
  const expired = (await db.run('DELETE FROM ai_result_cache WHERE expires_at <= ?', [now.toISOString()])).changes;
  if (personalKeepDays === undefined) return expired;
  const cutoff = new Date(now.getTime() - personalKeepDays * DAY_MS).toISOString();
  return expired + (await db.run('DELETE FROM ai_result_cache WHERE user_id IS NOT NULL AND created_at <= ?', [cutoff])).changes;
}
