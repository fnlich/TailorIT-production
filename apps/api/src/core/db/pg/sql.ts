import type { SqlParam, SqlParams } from '../types';

// v3.0 PG-0: the app's SQL keeps v2.0's placeholders (`?` with an array, `@name` with an object), and PostgreSQL
// numbers them ($1, $2, ...). This module rewrites a statement once (cached by its text) and binds the values in that
// order.
//
// The scanner skips what is not code: 'strings' ('' inside), "identifiers", -- line comments, /* block comments */
// and $tag$ dollar quotes $tag$. Outside them:
// - every `?` is a placeholder. PostgreSQL's jsonb operators `?`, `?|` and `?&` therefore cannot be written in app SQL:
//   use jsonb_exists(), jsonb_exists_any() or jsonb_exists_all() instead;
// - `@name` is a placeholder when the `@` follows no operator character (so `@>`, `<@`, `@@` and `a @@ b` stay
//   operators) and a letter or `_` starts the name. One name used twice is one parameter.
// A statement uses one kind: `?` with an array, `@name` with an object (better-sqlite3's rule).

export interface PreparedSql {
  /** The statement with $n placeholders. */
  text: string;
  /** `?` placeholders: how many. */
  positional: number;
  /** `@name` placeholders: the names in $n order. */
  names: readonly string[];
}

const OPERATOR_CHARS = new Set(['@', '<', '>', '!', '=', '~', '#', '%', '^', '&', '|', '`', '?', '-', '+', '*', '/']);
const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Rewrites `?` and `@name` into $n (see the module's note). Throws on a statement that mixes the two kinds. */
export function prepareSql(sql: string): PreparedSql {
  let out = '';
  let positional = 0;
  const names: string[] = [];
  const numberOf = new Map<string, number>();
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      // A string or a quoted identifier; a doubled quote stays inside.
      let j = i + 1;
      for (;;) {
        if (j >= n) break;
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (c === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 66));
      if (tag && !(i > 0 && NAME_PART.test(sql[i - 1]!))) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const stop = close < 0 ? n : close + tag[0].length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
      if (/[0-9]/.test(sql[i + 1] ?? '')) {
        throw new Error('Write placeholders as ? or @name: the adapter numbers them ($1 found in app SQL).');
      }
    }
    if (c === '?') {
      if (names.length) throw new Error('A statement uses ? or @name placeholders, not both.');
      positional += 1;
      out += `$${positional}`;
      i += 1;
      continue;
    }
    if (c === '@' && NAME_START.test(sql[i + 1] ?? '')) {
      const before = i > 0 ? sql[i - 1]! : ' ';
      if (!OPERATOR_CHARS.has(before)) {
        let j = i + 2;
        while (j < n && NAME_PART.test(sql[j]!)) j += 1;
        const name = sql.slice(i + 1, j);
        if (positional) throw new Error('A statement uses ? or @name placeholders, not both.');
        let number = numberOf.get(name);
        if (number === undefined) {
          names.push(name);
          number = names.length;
          numberOf.set(name, number);
        }
        out += `$${number}`;
        i = j;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return { text: out, positional, names };
}

/** A value as node-postgres sends it: booleans and numbers as they are, a Date as ISO text, a bigint as its digits. */
export function pgValue(value: SqlParam): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** The values in $n order. Throws as better-sqlite3 does on a missing named value or a wrong count. */
export function bindValues(prepared: PreparedSql, params: SqlParams | undefined): unknown[] {
  if (prepared.names.length) {
    if (params === undefined || Array.isArray(params)) {
      throw new RangeError(`This statement takes named values (@${prepared.names[0]}): pass an object.`);
    }
    const named = params as Readonly<Record<string, SqlParam>>;
    return prepared.names.map((name) => {
      if (!(name in named)) throw new RangeError(`Missing named parameter "${name}"`);
      return pgValue(named[name]);
    });
  }
  const list = params === undefined ? [] : Array.isArray(params) ? (params as readonly SqlParam[]) : null;
  if (list === null) {
    if (prepared.positional === 0) return [];
    throw new RangeError('This statement takes ? values: pass an array.');
  }
  if (list.length < prepared.positional) throw new RangeError('Too few parameter values were provided');
  if (list.length > prepared.positional) throw new RangeError('Too many parameter values were provided');
  return list.map(pgValue);
}

/** Rewritten statements by text, least recently used dropped first. */
export class SqlCache {
  private readonly map = new Map<string, PreparedSql>();
  constructor(private readonly size = 2000) {}
  get(sql: string): PreparedSql {
    const found = this.map.get(sql);
    if (found) {
      this.map.delete(sql);
      this.map.set(sql, found);
      return found;
    }
    const made = prepareSql(sql);
    this.map.set(sql, made);
    if (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
    return made;
  }
}
