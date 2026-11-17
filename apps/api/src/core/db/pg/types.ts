import pg from 'pg';

// v3.0 PG-0: what a PostgreSQL value reads as, so a row looks as it did on SQLite (11-database.md §5.1's types):
// - int8 (bigint ids, counts, sums of integers) and numeric (sums, salaries) as JS numbers;
// - timestamptz as ISO-8601 UTC text with milliseconds, the form the app writes ("2026-10-22T12:00:00.000Z");
// - date (day keys) as its "YYYY-MM-DD" text, never a JS Date at local midnight;
// - json and jsonb as their text (the app parses what it reads, as it parsed SQLite's TEXT);
// - interval and time as their text;
// - boolean as a JS boolean (SQLite gave 1/0: read flags with Boolean() or dialect.isTrue);
// - bytea as a Buffer (as SQLite's BLOB).
// Every connection runs with TimeZone UTC and DateStyle ISO (client.ts), which this parsing relies on.

const OID = {
  bool: 16,
  bytea: 17,
  int8: 20,
  int2: 21,
  int4: 23,
  json: 114,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  numeric: 1700,
  jsonb: 3802,
  int8Array: 1016,
  numericArray: 1231,
  timestamptzArray: 1185,
  dateArray: 1182,
  jsonArray: 199,
  jsonbArray: 3807,
} as const;

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2}){0,2})?$/;

/** PostgreSQL's timestamptz text (ISO DateStyle) as the app's ISO-8601 UTC text; 'infinity' and years past 9999 as written. */
export function isoFromPg(text: string): string {
  const match = TIMESTAMP.exec(text);
  if (!match) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : text;
  }
  const [, y, mo, d, h, mi, s, fraction = '', zone = '+00'] = match;
  const millis = (fraction + '000').slice(0, 3);
  if (zone === '+00' || zone === 'Z' || zone === '+00:00' || zone === '-00') {
    return `${y}-${mo}-${d}T${h}:${mi}:${s}.${millis}Z`;
  }
  const offset = zone.length === 3 ? `${zone}:00` : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${millis}${offset}`).toISOString();
}

const number = (text: string): number => Number(text);
const same = (text: string): string => text;

function arrayOf<T>(parse: (text: string) => T): (text: string) => Array<T | null> {
  const textArray = pg.types.getTypeParser(1009 as Parameters<typeof pg.types.getTypeParser>[0], 'text') as (text: string) => Array<string | null>;
  return (text) => textArray(text).map((item) => (item === null ? null : parse(item)));
}

const PARSERS: Record<number, (text: string) => unknown> = {
  [OID.int8]: number,
  [OID.numeric]: number,
  [OID.timestamptz]: isoFromPg,
  [OID.timestamp]: (text) => isoFromPg(`${text}+00`),
  [OID.date]: same,
  [OID.json]: same,
  [OID.jsonb]: same,
  [OID.interval]: same,
  [OID.time]: same,
  [OID.timetz]: same,
  [OID.int8Array]: arrayOf(number),
  [OID.numericArray]: arrayOf(number),
  [OID.timestamptzArray]: arrayOf(isoFromPg),
  [OID.dateArray]: arrayOf(same),
  [OID.jsonArray]: arrayOf(same),
  [OID.jsonbArray]: arrayOf(same),
};

/** The `types` option of every pool and client (never pg's global parsers: other code in the process keeps its own). */
export const pgTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (format !== 'binary') {
      const own = PARSERS[oid];
      if (own) return own;
    }
    return pg.types.getTypeParser(oid as Parameters<typeof pg.types.getTypeParser>[0], format ?? 'text');
  },
} as pg.CustomTypesConfig;
