// v3.0 D2: the SQL helpers. A feature asks `deps.db.dialect` for the spellings it shares with others (JSON reads and
// writes, flags, times, IN lists, case-insensitive matches, the insertion order), so each lives in one place. D2 wrote
// them for two engines; v3.0 RET retired SQLite, and these are PostgreSQL's (the adapter: core/db/pg/client.ts). The
// statements themselves follow the house style:
// - `INSERT ... ON CONFLICT(cols) DO UPDATE SET col = <table>.col + excluded.col`: name the table on the right side
//   (PostgreSQL finds a bare column ambiguous there);
// - `INSERT ... RETURNING id` (with `one`) instead of a driver's last row id;
// - `?` and `@name` placeholders (the adapter numbers them);
// - times as ISO-8601 text from `nowIso(deps)`, passed as parameters, so a frozen test clock holds.

export interface Dialect {
  /**
   * A JSON value's text at a path, `jsonText('input', '$.prepare.id')`: PostgreSQL's `#>>` over the value as jsonb.
   * The path is `$` then `.name` or `[index]` steps. Compare it with text (cast it to compare a number).
   */
  jsonText(expr: string, path: string): string;
  /**
   * The elements of a JSON array as a table with one text column `value`, from a placeholder or an expression:
   * `... IN (SELECT value FROM ${d.jsonEach('?')})` with `JSON.stringify(list)` bound.
   */
  jsonEach(expr: string): string;
  /** `INSERT INTO <rest> ON CONFLICT DO NOTHING`: a row whose key is taken is skipped (only unique keys; no CHECK). */
  insertOrIgnore(rest: string): string;
  /** SQL literals of a flag (`WHERE archived = ${d.true}`). */
  readonly true: string;
  readonly false: string;
  /** A flag as a bound value. */
  bool(value: boolean): boolean;
  /** A flag as read (a boolean column; 1 and 't' are taken too) as a boolean. */
  isTrue(value: unknown): boolean;
  /** A time as a bound value: ISO-8601 text. */
  time(at: Date): string;
  /** A time as read (ISO text from the adapter, or a Date) as ISO-8601 text; null stays null. */
  iso(value: unknown): string | null;
  /**
   * The database's own clock, a timestamptz (read back as ISO text). Prefer a bound `nowIso(deps)`: tests freeze the
   * app's clock, not the database's. For defaults and housekeeping that has no request.
   */
  readonly now: string;
  /** `n` placeholders for an IN list: `IN (${d.list(ids.length)})` with the ids spread into the params. */
  list(n: number): string;
  /** A case-insensitive match (ILIKE), with `\` as the escape. */
  like(expr: string, pattern: string): string;
  // v3.0 PG-0: the helpers INT-1's PostgreSQL list asks for (its kinds A, D, E, F, H and J).
  /** `needle` occurs in `expr` (strpos(...) > 0); both are SQL expressions. */
  contains(expr: string, needle: string): string;
  /**
   * The values of a group joined by `separator` (an SQL string literal such as `';'`), in `orderBy`'s order when
   * given: string_agg (the value read as text).
   */
  groupConcat(expr: string, separator: string, orderBy?: string): string;
  /**
   * `expr` (JSON) with the value at `path` set from JSON text (`value`, an SQL expression such as `?`): jsonb_set (its
   * parent object must exist; the last key is made when missing). jsonb: write it back to the column it came from.
   */
  jsonSet(expr: string, path: string, value: string): string;
  /** The same with a plain text value, stored as a JSON string. */
  jsonSetText(expr: string, path: string, value: string): string;
  /** `expr` compared in byte order (the link-key ranges): COLLATE "C". */
  collateC(expr: string): string;
  /**
   * The order rows were inserted in, for a tie-break or a cursor: the baseline's `seq` identity column (on the tables
   * of INT-1's list A). `alias` names the table in a join: `seq('q')` is `q.seq`.
   */
  seq(alias?: string): string;
  /** Every row from the `param`-th on (`param` an SQL expression): `OFFSET` with no limit. */
  offsetOnly(param: string): string;
}

/** `$.a.b[2]` as its steps; refuses anything else (a path is code, never a person's text). */
export function jsonPathSteps(path: string): Array<string | number> {
  if (!path.startsWith('$')) throw new Error(`A JSON path starts with $: ${path}`);
  const steps: Array<string | number> = [];
  const pattern = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/y;
  let at = 1;
  while (at < path.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(path);
    if (!match) throw new Error(`Not a JSON path this dialect writes: ${path}`);
    steps.push(match[1] ?? Number(match[2]));
    at = pattern.lastIndex;
  }
  return steps;
}

function list(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`An IN list needs 1 or more placeholders, not ${n}.`);
  return Array.from({ length: n }, () => '?').join(', ');
}

/** PostgreSQL's spellings (v3.0 PG-0: the adapter in core/db/pg/client.ts). */
export const postgresDialect: Dialect = {
  jsonText(expr, path) {
    const steps = jsonPathSteps(path);
    return `(${expr})::jsonb #>> '{${steps.join(',')}}'`;
  },
  jsonEach: (expr) => `jsonb_array_elements_text((${expr})::jsonb) AS je(value)`,
  insertOrIgnore: (rest) => `INSERT INTO ${rest} ON CONFLICT DO NOTHING`,
  true: 'true',
  false: 'false',
  bool: (value) => value,
  isTrue: (value) => value === true || value === 1 || value === 't',
  time: (at) => at.toISOString(),
  iso: (value) => isoOf(value),
  // A timestamptz, as every time column of the baseline; the adapter reads it back as ISO text.
  now: 'now()',
  list,
  like: (expr, pattern) => `${expr} ILIKE ${pattern} ESCAPE '\\'`,
  contains: (expr, needle) => `strpos(${expr}, ${needle}) > 0`,
  groupConcat: (expr, separator, orderBy) =>
    `string_agg((${expr})::text, ${separator}${orderBy ? ` ORDER BY ${orderBy}` : ''})`,
  jsonSet: (expr, path, value) =>
    `jsonb_set((${expr})::jsonb, '{${jsonPathSteps(path).join(',')}}', (${value})::jsonb, true)`,
  jsonSetText: (expr, path, value) =>
    `jsonb_set((${expr})::jsonb, '{${jsonPathSteps(path).join(',')}}', to_jsonb((${value})::text), true)`,
  collateC: (expr) => `${expr} COLLATE "C"`,
  seq: (alias) => (alias ? `${alias}.seq` : 'seq'),
  offsetOnly: (param) => `OFFSET ${param}`,
};

function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    // Already ISO-8601 UTC as the app writes it: kept byte for byte (no reformatting a stored value).
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return value;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  throw new Error(`Not a time: ${String(value)}`);
}
