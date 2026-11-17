import type { DbClient } from '../../types';
import { DAY_MS } from '@tailorit/shared';

// v30 D5L (11-database.md §8.1-8.2): the partitioned tables' housekeeping. Plain declarative RANGE partitions with no
// default partition, so DETACH ... CONCURRENTLY stays available:
// - job_postings_raw (by fetched_at) and ai_task_payloads (by created_on): one partition a UTC day, named
//   `<table>_YYYYMMDD`; today and two days ahead are kept made, and a day older than its keep (JOB_RAW_KEEP_DAYS,
//   AI_TASK_PAYLOAD_KEEP_DAYS) is detached concurrently and dropped. A payload day that still holds a queued or
//   running AI task is kept.
// - job_texts (by job id): one partition per JOB_TEXT_PARTITION_IDS ids, named `job_texts_pNNN`; the one holding the
//   newest job id and two more are kept made. Texts are kept forever: nothing is dropped (8.3's tablespace move is a
//   runbook step).
//
// A new partition is made as a plain table LIKE its parent, then attached: ATTACH PARTITION takes SHARE UPDATE
// EXCLUSIVE on the parent (reads and writes go on), where CREATE TABLE ... PARTITION OF would take ACCESS EXCLUSIVE.
// Makers take an advisory lock, so two processes (the API and the worker) never make the same partition at once.
// Every statement here is DDL on names this module builds from its own table list, days and numbers: no value from a
// request ever reaches it.

/** How a partitioned table is split. */
export interface PartitionedTable {
  table: 'job_postings_raw' | 'ai_task_payloads' | 'job_texts';
  /** `day`: one partition a UTC day of a date or timestamptz key; `ids`: JOB_TEXT_PARTITION_IDS ids a partition. */
  by: 'day' | 'ids';
  /** The key's type (a day table's bounds are written as dates or as UTC midnights). */
  key: 'date' | 'timestamptz' | 'bigint';
}

export const JOB_POSTINGS_RAW: PartitionedTable = { table: 'job_postings_raw', by: 'day', key: 'timestamptz' };
export const AI_TASK_PAYLOADS: PartitionedTable = { table: 'ai_task_payloads', by: 'day', key: 'date' };
export const JOB_TEXTS: PartitionedTable = { table: 'job_texts', by: 'ids', key: 'bigint' };
/** Every partitioned table TailorIT keeps. */
export const PARTITIONED_TABLES: readonly PartitionedTable[] = [JOB_POSTINGS_RAW, AI_TASK_PAYLOADS, JOB_TEXTS];

/** Job ids a job_texts partition holds (the baseline's p000 and p001: 1-2,000,000 and 2,000,001-4,000,000). */
export const JOB_TEXT_PARTITION_IDS = 2_000_000;
/** Periods made ahead of the current one (11 §8.1: "two periods ahead"). */
export const PERIODS_AHEAD = 2;
/** pg_advisory_xact_lock's key for partition makers: a fixed number no other code uses (the migrations' is 7,320,011). */
const PARTITION_LOCK = 7_320_015;
/** How long a maker waits for the parent's lock before it gives up until the next pass. */
const LOCK_TIMEOUT = '10s';

/** A partition's range [from, to): epoch milliseconds for a day table, job ids for job_texts. */
export interface Range {
  from: number;
  to: number;
}

export interface Partition extends Range {
  name: string;
  /** DETACH ... CONCURRENTLY started and did not finish (FINALIZE completes it). */
  pending: boolean;
}

/** What one pass did, for the log and the daily step's count. */
export interface PartitionReport {
  made: string[];
  dropped: string[];
  /** Ranges that could not be made or dropped, with why (logged; the next pass tries again). */
  problems: string[];
}

/** Runs one statement and answers its rows: `db.all`, or a raw client's query in the restore's transaction. */
export type SqlRunner = (sql: string) => Promise<Array<Record<string, unknown>>>;

const runnerOf =
  (db: Pick<DbClient, 'all'>): SqlRunner =>
  (sql) =>
    db.all(sql);

// ── Days and names ───────────────────────────────────────────────────────────────────────────────────────────────

/** The UTC day of a time: `YYYY-MM-DD`. */
export function dayOf(at: Date | number | string): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a time: ${String(at)}`);
  return date.toISOString().slice(0, 10);
}

/** A UTC day's first millisecond. */
export function dayStart(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Not a day: ${day}`);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`Not a day: ${day}`);
  return ms;
}

/** The range of one UTC day. */
export const dayRange = (day: string): Range => ({ from: dayStart(day), to: dayStart(day) + DAY_MS });

/** The range of job_texts partition number `index` (0: ids 1-2,000,000). */
export const idRange = (index: number): Range => ({
  from: index * JOB_TEXT_PARTITION_IDS + 1,
  to: (index + 1) * JOB_TEXT_PARTITION_IDS + 1,
});

/** The name TailorIT gives a partition of `range`. */
export function partitionName(spec: PartitionedTable, range: Range): string {
  if (spec.by === 'ids') {
    const index = Math.floor((range.from - 1) / JOB_TEXT_PARTITION_IDS);
    return `${spec.table}_p${String(index).padStart(3, '0')}`;
  }
  return `${spec.table}_${dayOf(range.from).replace(/-/g, '')}`;
}

/** A bound as SQL: a date, a UTC midnight, or a job id. */
function boundSql(spec: PartitionedTable, value: number): string {
  if (!Number.isFinite(value)) throw new Error(`An open bound is not made here (${spec.table}).`);
  if (spec.by === 'ids') return String(Math.trunc(value));
  const iso = new Date(value).toISOString();
  return spec.key === 'date' ? `'${iso.slice(0, 10)}'` : `'${iso}'`;
}

/** `FOR VALUES FROM (...) TO (...)` of a range. */
export function forValues(spec: PartitionedTable, range: Range): string {
  return `FOR VALUES FROM (${boundSql(spec, range.from)}) TO (${boundSql(spec, range.to)})`;
}

const BOUND = /^FOR VALUES FROM \((.+)\) TO \((.+)\)$/;

/** One side of pg_get_expr(relpartbound): `'2026-11-15'`, `'2026-11-15 00:00:00+00'`, `'1'`, MINVALUE or MAXVALUE. */
function boundValue(spec: PartitionedTable, raw: string): number {
  if (raw === 'MINVALUE') return -Infinity;
  if (raw === 'MAXVALUE') return Infinity;
  const quoted = /^'((?:[^']|'')*)'$/.exec(raw);
  const text = quoted ? quoted[1]!.replace(/''/g, "'") : raw;
  if (spec.by === 'ids') {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error(`${spec.table}: not an id bound: ${raw}`);
    return n;
  }
  // A date ('2026-11-15') or a timestamptz in the session's zone ('2026-11-15 00:00:00+00', '... -07:30').
  let iso = text.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += 'T00:00:00Z';
  else if (/[+-]\d{2}$/.test(iso)) iso += ':00';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`${spec.table}: not a time bound: ${raw}`);
  return ms;
}

/** A partition's range from pg_get_expr(relpartbound); null for a DEFAULT partition (TailorIT makes none). */
export function parseBound(spec: PartitionedTable, bound: string): Range | null {
  if (bound.trim() === 'DEFAULT') return null;
  const match = BOUND.exec(bound.trim());
  if (!match) throw new Error(`${spec.table}: a partition bound TailorIT does not read: ${bound}`);
  return { from: boundValue(spec, match[1]!), to: boundValue(spec, match[2]!) };
}

// ── Reading the catalogue ────────────────────────────────────────────────────────────────────────────────────────

interface PartitionRow {
  parent: string;
  name: string;
  bound: string;
  pending: boolean;
}

/** The partitions of the given tables, in one catalogue read (`pendingOnly`: half-done detaches alone). */
async function partitionRows(run: SqlRunner, specs: readonly PartitionedTable[], pendingOnly = false): Promise<PartitionRow[]> {
  if (specs.length === 0) return [];
  return (await run(
    `SELECT p.relname AS parent, c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound, i.inhdetachpending AS pending
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      WHERE i.inhparent IN (${specs.map((spec) => `'public.${spec.table}'::regclass`).join(', ')}) AND c.relkind IN ('r', 'p')
        ${pendingOnly ? 'AND i.inhdetachpending' : ''}`,
  )) as unknown as PartitionRow[];
}

/** One table's partitions from its rows, oldest range first. Throws on a DEFAULT one. */
function partitionsOf(spec: PartitionedTable, rows: readonly PartitionRow[]): Partition[] {
  const out: Partition[] = [];
  for (const row of rows) {
    if (row.parent !== spec.table) continue;
    const range = parseBound(spec, row.bound);
    if (!range) throw new Error(`${spec.table} has a DEFAULT partition (${row.name}): TailorIT's housekeeping needs none.`);
    out.push({ name: row.name, pending: row.pending === true, ...range });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The partitions attached to a table (pending detaches included), oldest range first. Throws on a DEFAULT one. */
export async function listPartitions(run: SqlRunner, spec: PartitionedTable): Promise<Partition[]> {
  return partitionsOf(spec, await partitionRows(run, [spec]));
}

/** True when `range` lies inside one attached partition. */
export const covered = (parts: readonly Partition[], range: Range) =>
  parts.some((part) => !part.pending && part.from <= range.from && range.to <= part.to);

/** True when `range` overlaps any partition (attached or pending) without lying inside one. */
const overlapsPartly = (parts: readonly Partition[], range: Range) =>
  parts.some((part) => part.from < range.to && range.from < part.to) && !covered(parts, range);

/** The newest job id in use or handed out (ids have gaps: a conflicting insert still spends one). */
export async function newestJobId(run: SqlRunner): Promise<number> {
  const rows = (await run(
    `SELECT greatest(coalesce((SELECT max(id) FROM jobs), 0),
              coalesce(pg_sequence_last_value(CAST(pg_get_serial_sequence('public.jobs', 'id') AS regclass)), 0)) AS n`,
  )) as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

// ── What should exist ────────────────────────────────────────────────────────────────────────────────────────────

/** The day ranges from `today` through PERIODS_AHEAD days ahead. */
export function wantedDays(today: string, ahead = PERIODS_AHEAD): Range[] {
  const first = dayStart(today);
  return Array.from({ length: ahead + 1 }, (_, i) => ({ from: first + i * DAY_MS, to: first + (i + 1) * DAY_MS }));
}

/** job_texts' ranges from the first through the one holding `newestId`, and PERIODS_AHEAD more. */
export function wantedIdRanges(newestId: number, ahead = PERIODS_AHEAD): Range[] {
  const current = Math.max(0, Math.floor((Math.max(newestId, 1) - 1) / JOB_TEXT_PARTITION_IDS));
  return Array.from({ length: current + ahead + 1 }, (_, index) => idRange(index));
}

/** Every table's wanted ranges at `now`. */
export async function wantedRanges(run: SqlRunner, now: Date): Promise<Array<{ spec: PartitionedTable; ranges: Range[] }>> {
  const days = wantedDays(dayOf(now));
  return [
    { spec: JOB_POSTINGS_RAW, ranges: days },
    { spec: AI_TASK_PAYLOADS, ranges: days },
    { spec: JOB_TEXTS, ranges: wantedIdRanges(await newestJobId(run)) },
  ];
}

// ── Making ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Days known to exist, per client (the AI queue asks for its day at every enqueue). Dropping a day forgets it. */
const known = new WeakMap<object, Set<string>>();
const knownOf = (db: object) => {
  let set = known.get(db);
  if (!set) {
    set = new Set();
    known.set(db, set);
  }
  return set;
};
const knownKey = (spec: PartitionedTable, range: Range) => `${spec.table}:${range.from}`;

/**
 * The statements that make one partition: a table LIKE the parent (its columns, defaults, checks, compression and
 * indexes), attached with its bounds. A leftover table of that name that is not attached (a drop that stopped half
 * way) is attached as it is (ATTACH checks its rows fit).
 */
export function makePartitionSql(spec: PartitionedTable, range: Range, exists: boolean): string[] {
  const name = partitionName(spec, range);
  return [
    ...(exists ? [] : [`CREATE TABLE public.${name} (LIKE public.${spec.table} INCLUDING ALL)`]),
    `ALTER TABLE public.${spec.table} ATTACH PARTITION public.${name} ${forValues(spec, range)}`,
  ];
}

/** True when a table of that name exists in public (attached or not). */
async function tableExists(run: SqlRunner, name: string): Promise<boolean> {
  const rows = await run(`SELECT to_regclass('public.${name}') IS NOT NULL AS found`);
  return rows[0]?.found === true;
}

/**
 * Makes the ranges of `spec` that no partition covers, inside the caller's transaction (`run` on its connection).
 * Answers the names made; a range that overlaps a partition partly is a problem, never made.
 */
export async function makeMissingPartitions(
  run: SqlRunner,
  spec: PartitionedTable,
  ranges: readonly Range[],
  report: PartitionReport,
): Promise<void> {
  const parts = await listPartitions(run, spec);
  for (const range of ranges) {
    if (covered(parts, range)) continue;
    const name = partitionName(spec, range);
    if (overlapsPartly(parts, range)) {
      report.problems.push(`${name}: its range overlaps a partition of ${spec.table} that is not TailorIT's shape`);
      continue;
    }
    for (const sql of makePartitionSql(spec, range, await tableExists(run, name))) await run(sql);
    parts.push({ name, pending: false, ...range });
    report.made.push(name);
  }
}

/**
 * Makes every range of `wanted` that no partition covers (each table in a short transaction of its own, under the
 * makers' lock and a lock timeout). Outside any transaction. A table whose maker fails is a problem in the report
 * (the next pass tries again); the others still run. `cached`: skip the ranges this client already knew to exist
 * (the AI queue's every enqueue); the housekeeping and the start-up check always read the catalogue.
 */
export async function ensurePartitions(
  db: DbClient,
  wanted: ReadonlyArray<{ spec: PartitionedTable; ranges: readonly Range[] }>,
  report: PartitionReport = { made: [], dropped: [], problems: [] },
  { cached = false }: { cached?: boolean } = {},
): Promise<PartitionReport> {
  const run = runnerOf(db);
  const cache = knownOf(db);
  const asked = wanted
    .map(({ spec, ranges }) => ({ spec, missing: cached ? ranges.filter((range) => !cache.has(knownKey(spec, range))) : [...ranges] }))
    .filter(({ missing }) => missing.length > 0);
  // One catalogue read for every table asked about (the start-up check runs in every test context).
  let rows: PartitionRow[];
  try {
    rows = await partitionRows(run, asked.map(({ spec }) => spec));
  } catch (error) {
    report.problems.push(error instanceof Error ? error.message : String(error));
    return report;
  }
  for (const { spec, missing } of asked) {
    try {
      let parts = partitionsOf(spec, rows);
      const todo = missing.filter((range) => !covered(parts, range));
      if (todo.length > 0) {
        await db.tx(
          async (t) => {
            await t.run(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
            await t.run(`SELECT pg_advisory_xact_lock(${PARTITION_LOCK})`);
            await makeMissingPartitions((sql) => t.all(sql), spec, todo, report);
          },
          { label: `partitions of ${spec.table}` },
        );
        parts = await listPartitions(run, spec);
      }
      for (const range of missing) if (covered(parts, range)) cache.add(knownKey(spec, range));
    } catch (error) {
      report.problems.push(`${spec.table}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

/** The AI queue's day (and a test clock's): its partition made when missing. Outside any transaction. */
export async function ensureDayPartition(db: DbClient, spec: PartitionedTable, day: string): Promise<void> {
  const report = await ensurePartitions(db, [{ spec, ranges: [dayRange(day)] }], undefined, { cached: true });
  if (report.problems.length > 0) throw new Error(`The ${spec.table} partition for ${day} could not be made: ${report.problems.join('; ')}`);
}

// ── Dropping ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Finishes a DETACH ... CONCURRENTLY that stopped half way (the partition is left marked pending). */
async function finalizeDetach(db: DbClient, spec: PartitionedTable, name: string): Promise<void> {
  await db.run(`ALTER TABLE public.${spec.table} DETACH PARTITION public.${name} FINALIZE`);
}

/**
 * Detaches (concurrently: reads and writes of the table go on) and drops the partitions of `spec` that end on or
 * before `cutoffMs`, except those `keep` holds back. Outside any transaction: DETACH ... CONCURRENTLY refuses one.
 */
export async function dropExpiredPartitions(
  db: DbClient,
  spec: PartitionedTable,
  cutoffMs: number,
  report: PartitionReport,
  keep: (range: Range) => Promise<boolean> = async () => false,
): Promise<void> {
  db.assertNoTx('dropping a partition');
  const cache = knownOf(db);
  for (const part of await listPartitions(runnerOf(db), spec)) {
    if (!(part.to <= cutoffMs)) continue;
    try {
      if (part.pending) await finalizeDetach(db, spec, part.name);
      else {
        if (await keep(part)) continue;
        await db.run(`ALTER TABLE public.${spec.table} DETACH PARTITION public.${part.name} CONCURRENTLY`);
      }
      cache.delete(knownKey(spec, part));
      await db.run(`DROP TABLE IF EXISTS public.${part.name}`);
      report.dropped.push(part.name);
    } catch (error) {
      report.problems.push(`${part.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Drops the tables named like a day partition of `spec` that are no longer attached and end on or before `cutoffMs`:
 * a drop that stopped between its DETACH and its DROP, or a half-done detach finished by finalizePendingDetaches.
 */
export async function dropLeftovers(db: DbClient, spec: PartitionedTable, cutoffMs: number, report: PartitionReport): Promise<void> {
  if (spec.by !== 'day') return;
  const rows = await db.all<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT c.relispartition
        AND c.relname ~ '^${spec.table}_[0-9]{8}$'`,
  );
  for (const { name } of rows) {
    const digits = name.slice(spec.table.length + 1);
    const day = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    let range: Range;
    try {
      range = dayRange(day);
    } catch {
      continue;
    }
    if (range.to > cutoffMs) continue;
    try {
      await db.run(`DROP TABLE IF EXISTS public.${name}`);
      report.dropped.push(name);
    } catch (error) {
      report.problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Finishes every half-done detach (any table). The table is left detached: ensurePartitions attaches it again while
 * its range is still wanted, and dropLeftovers drops it once it has expired.
 */
export async function finalizePendingDetaches(db: DbClient, report: PartitionReport): Promise<void> {
  const rows = await partitionRows(runnerOf(db), PARTITIONED_TABLES, true);
  for (const row of rows) {
    const spec = PARTITIONED_TABLES.find((table) => table.table === row.parent)!;
    try {
      await finalizeDetach(db, spec, row.name);
      const range = parseBound(spec, row.bound);
      if (range) knownOf(db).delete(knownKey(spec, range));
    } catch (error) {
      report.problems.push(`${row.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
