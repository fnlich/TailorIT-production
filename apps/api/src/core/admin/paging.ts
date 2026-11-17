import { validationFailed } from '../http/errors';

// v30 ST0: the admin lists' paging and filter helpers (PLAN §6, "Admin APIs"). Admin lists grow to 100,000 rows
// (accounts, sources, reviews), so they page by a keyset cursor (newest first), never by OFFSET: the cursor holds the
// last row's sort key and id, base64url JSON, and a cursor that does not decode answers 400 with the list's own
// "out of date" words. A filter is a list of SQL conditions with named parameters (Where). Moved here from the
// admin accounts list (features/admin-users/accounts.ts, which ST4 points at these).

/** One page of an admin list: its rows, and the cursor of the next page while more follow. */
export interface AdminPage<T> {
  items: T[];
  nextCursor?: string;
}

/** A cursor for `value` (the last row's sort key and id). */
export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** The object a cursor holds; 400 validation_failed with `staleMessage` when it does not decode to one. */
export function decodeCursor(cursor: string, staleMessage: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw validationFailed(staleMessage);
}

/**
 * A page from rows read with LIMIT `limit + 1`: the first `limit` rows, and `nextCursor` (made by `cursorOf` from the
 * last row kept) when the extra row says more follow.
 */
export function pageOf<R, T = R>(
  rows: readonly R[],
  limit: number,
  cursorOf: (last: R) => Record<string, unknown>,
  map: (row: R) => T = (row) => row as unknown as T,
): AdminPage<T> {
  const kept = rows.slice(0, limit);
  const page: AdminPage<T> = { items: kept.map(map) };
  if (rows.length > limit && kept.length > 0) page.nextCursor = encodeCursor(cursorOf(kept[kept.length - 1]!));
  return page;
}

/**
 * The keyset condition "after the cursor's row" for a list sorted newest first by `sortColumn`, then `idColumn`, both
 * descending: `(sort < @cursorAt OR (sort = @cursorAt AND id < @cursorId))`, its parameters taken from the cursor's `c`
 * (the sort key) and `id`. 400 with `staleMessage` for a cursor without them.
 */
export function afterCursor(
  cursor: string,
  options: { sortColumn: string; idColumn: string; staleMessage: string },
): { sql: string; params: { cursorAt: string | number; cursorId: string | number } } {
  const { c, id } = decodeCursor(cursor, options.staleMessage);
  const key = (value: unknown) => typeof value === 'string' || typeof value === 'number';
  if (!key(c) || !key(id)) throw validationFailed(options.staleMessage);
  return {
    sql: `(${options.sortColumn} < @cursorAt OR (${options.sortColumn} = @cursorAt AND ${options.idColumn} < @cursorId))`,
    params: { cursorAt: c as string | number, cursorId: id as string | number },
  };
}

/** `%text%` for a LIKE with ESCAPE '\': `%`, `_` and `\` in `text` match themselves. */
export function likeText(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** A filter's conditions and their named parameters, joined with AND. */
export class Where {
  private readonly conditions: string[] = [];
  readonly params: Record<string, unknown> = {};

  /** Adds one condition (parenthesised when joined) and its named parameters. */
  add(condition: string, params: Record<string, unknown> = {}): this {
    this.conditions.push(condition);
    Object.assign(this.params, params);
    return this;
  }

  /** Adds the condition only when `when` is true (an optional filter). */
  addIf(when: boolean, condition: string, params: Record<string, unknown> = {}): this {
    return when ? this.add(condition, params) : this;
  }

  /** `WHERE (a) AND (b)`, or '' when there is no condition. */
  sql(): string {
    return this.conditions.length === 0 ? '' : `WHERE ${this.conditions.map((condition) => `(${condition})`).join(' AND ')}`;
  }
}
