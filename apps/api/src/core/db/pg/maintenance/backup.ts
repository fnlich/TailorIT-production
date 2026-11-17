import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pg from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { poolConfig, type PgConnection } from '../client';
import { migratePg, readPgMigrations, type PgMigrationFile } from '../migrate';

// v30 D5L: the single-person install's backups (coordinator's decision: the embedded bundle ships no pg_dump or
// pg_restore). Two kinds, both run by scripts/db-backup.mjs (backup-cli.ts); DEPLOY.md says when to use which, and
// that a hosted deployment uses pg_dump and pg_restore from a full PostgreSQL install instead.
//
// 1. The cold copy: the embedded cluster's data folder copied while the server is stopped (consistent: nothing writes
//    it), with its password file. Put back as it is, on the same PostgreSQL major version.
// 2. The logical export: every table written with COPY ... TO STDOUT in one REPEATABLE READ snapshot (the server keeps
//    running), gzip'd, one file a table, with a manifest (the schema's migrations, each table's columns, rows and
//    SHA-256 of its COPY text, the sequences, the partitions). The restore loads it into a NEW database at the same
//    migrations: the database is made and migrated to the manifest's files, the partitions the rows need are made,
//    every table is loaded with COPY ... FROM STDIN in one transaction (triggers and foreign keys off: the snapshot is
//    consistent, and the counters it holds are the ones to keep), each file checked against its SHA-256 and row
//    count, the sequences set; any mismatch rolls the whole load back. `use` then makes it the app's database.
//
// Both also copy the app's own data folders the database needs beside it (backup-cli.ts names them: DATA_DIR's
// `files`, the uploads, and `keys`, without which the saved job-site sign-ins cannot be read) into `<backup>/data/`.
// The cold copy puts them back with the cluster; after a logical restore they are copied back by hand (DEPLOY.md).
//
// v30 FIX-PG (PG-LOAD PGL-20, docs/design/part2/measurements.md §6): the logical export takes the schema the
// migrations make (`public`, where schema_migrations lives) and nothing else. Another schema is not the migrations'
// (E1's `refdata`, its monthly build of the open dumps, 1.3 GB at mix B; a build's `refdata_next`), so a restore,
// which makes its database by migrating it, could never load it: an install with a refdata build could not be
// restored ("schema refdata does not exist"). The manifest names what it left out (`leftOut`); after a restore,
// `npm run refdata:build` makes refdata again (until then enrichment waits for it, as on a new install). An export
// made before this (holding refdata) restores without it: the restore leaves out a table whose schema is not the
// migrations', and says so. The cold copy is the whole cluster, refdata included.

export const EXPORT_FORMAT = 'tailorit-pg-export';
export const COLD_FORMAT = 'tailorit-pg-cold';
export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST = 'manifest.json';
const COLD_MANIFEST = 'cold.json';

export interface ExportedTable {
  schema: string;
  name: string;
  /** The columns written (generated columns are left out: PostgreSQL computes them again). */
  columns: string[];
  rows: number;
  /** Bytes of COPY text (before gzip). */
  bytes: number;
  /** SHA-256 of the COPY text. */
  sha256: string;
  file: string;
}

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  createdAt: string;
  server: string;
  database: string;
  migrations: Array<{ version: number; name: string; checksum: string }>;
  tables: ExportedTable[];
  /** last_value as text (null: never used). */
  sequences: Array<{ schema: string; name: string; lastValue: string | null }>;
  partitions: Array<{ schema: string; parent: string; name: string; bound: string }>;
  /** The data folders copied into `data/` (after the snapshot: the server kept running). */
  data: CopiedFolder[];
  /**
   * v30 FIX-PG (PGL-20): the schemas holding tables that the export leaves out, not being the migrations' (E1's
   * `refdata`: `npm run refdata:build` makes it again). Missing in an export made before.
   */
  leftOut?: Array<{ schema: string; tables: number }>;
}

/** A folder of the app's data copied with a backup: `<backup>/data/<name>`. */
export interface DataFolder {
  name: string;
  path: string;
}

export interface CopiedFolder {
  name: string;
  files: number;
  bytes: number;
}

export interface ColdManifest {
  format: typeof COLD_FORMAT;
  formatVersion: number;
  createdAt: string;
  /** The PG_VERSION file of the copied cluster (its major version). */
  pgVersion: string;
  /** Where it was copied from. */
  source: string;
  files: number;
  bytes: number;
  passwordFile: boolean;
  /** The data folders copied into `data/` with the cluster. */
  data: CopiedFolder[];
}

/** `"name"` with quotes doubled. */
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qualified = (schema: string, name: string) => `${ident(schema)}.${ident(name)}`;
/** `'text'` with quotes doubled (catalogue names only). */
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** A folder that is missing or empty. */
function assertEmptyFolder(dir: string, what: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${what} ${dir} is not empty: choose a new folder.`);
}

/** A client with TailorIT's session settings (UTC, ISO dates): the COPY text is the same on every run. */
export async function connect(connection: PgConnection): Promise<pg.Client> {
  const client = new pg.Client(poolConfig(connection));
  await client.connect();
  return client;
}

/** Counts the rows (lines) and hashes the COPY text that passes through it. */
class Tally extends Transform {
  rows = 0;
  bytes = 0;
  private readonly hash = createHash('sha256');
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null, data?: Buffer) => void): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, at + 1)) this.rows += 1;
    done(null, chunk);
  }
  digest(): string {
    return this.hash.digest('hex');
  }
}

// ── The logical export ───────────────────────────────────────────────────────────────────────────────────────────

/** v30 FIX-PG (PGL-20): the one schema the migrations make, and so the one a restore can load (see the top). */
export const MIGRATED_SCHEMA = 'public';

/** The user tables of every schema (the export takes MIGRATED_SCHEMA's; the others are named as left out). */
const TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.oid::bigint AS oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relpersistence <> 't'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND NOT (n.nspname = 'public' AND c.relname = 'schema_migrations')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
   ORDER BY 1, 2`;
const COLUMNS_SQL = `SELECT attname AS name FROM pg_attribute
   WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`;
const PRIMARY_KEY_SQL = `SELECT a.attname AS name FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE i.indrelid = $1 AND i.indisprimary ORDER BY k.ord`;
const SEQUENCES_SQL = `SELECT schemaname AS schema, sequencename AS name, last_value::text AS "lastValue" FROM pg_sequences
   WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`;
const PARTITIONS_SQL = `SELECT n.nspname AS schema, p.relname AS parent, c.relname AS name,
         pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relispartition AND c.relkind IN ('r', 'p') AND NOT i.inhdetachpending ORDER BY 1, 2, 3`;

/**
 * Writes every table of the database `client` is connected to into `dir` (missing or empty), in one snapshot.
 * Read-only: the server and the app may keep running. Answers the manifest it wrote last.
 */
export async function exportDatabase(
  client: pg.Client,
  dir: string,
  options: { now?: Date; log?: (line: string) => void; data?: DataFolder[] } = {},
): Promise<ExportManifest> {
  assertEmptyFolder(dir, 'The export folder');
  mkdirSync(dir, { recursive: true });
  const log = options.log ?? (() => undefined);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const found = await client.query<{ found: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS found");
    if (!found.rows[0]?.found) throw new Error('This database has no schema_migrations table: it is not a TailorIT database.');
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: (options.now ?? new Date()).toISOString(),
      server: (await client.query<{ v: string }>('SELECT version() AS v')).rows[0]!.v,
      database: (await client.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d,
      migrations: (
        await client.query<{ version: number; name: string; checksum: string }>(
          'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
        )
      ).rows,
      tables: [],
      sequences: (await client.query<{ schema: string; name: string; lastValue: string | null }>(SEQUENCES_SQL)).rows.filter(
        (sequence) => sequence.schema === MIGRATED_SCHEMA,
      ),
      partitions: (await client.query<{ schema: string; parent: string; name: string; bound: string }>(PARTITIONS_SQL)).rows.filter(
        (part) => part.schema === MIGRATED_SCHEMA,
      ),
      data: [],
      leftOut: [],
    };
    const all = (await client.query<{ schema: string; name: string; oid: number }>(TABLES_SQL)).rows;
    for (const table of all) {
      if (table.schema === MIGRATED_SCHEMA) continue;
      const left = manifest.leftOut!.find((entry) => entry.schema === table.schema);
      if (left) left.tables += 1;
      else manifest.leftOut!.push({ schema: table.schema, tables: 1 });
    }
    for (const left of manifest.leftOut!) log(`${left.schema}: left out (${left.tables} tables; no migration makes it)`);
    const tables = all.filter((table) => table.schema === MIGRATED_SCHEMA);
    for (const table of tables) {
      const columns = (await client.query<{ name: string }>(COLUMNS_SQL, [table.oid])).rows.map((row) => row.name);
      const key = (await client.query<{ name: string }>(PRIMARY_KEY_SQL, [table.oid])).rows.map((row) => row.name);
      const order = key.length ? ` ORDER BY ${key.map(ident).join(', ')}` : '';
      const file = `${table.schema}.${table.name}.copy.gz`;
      const tally = new Tally();
      const select = `SELECT ${columns.map(ident).join(', ')} FROM ${qualified(table.schema, table.name)}${order}`;
      await pipeline(client.query(copyTo(`COPY (${select}) TO STDOUT`)), tally, createGzip(), createWriteStream(join(dir, file)));
      manifest.tables.push({ schema: table.schema, name: table.name, columns, rows: tally.rows, bytes: tally.bytes, sha256: tally.digest(), file });
      if (tally.rows > 0) log(`${table.schema}.${table.name}: ${tally.rows} rows`);
    }
    await client.query('COMMIT');
    manifest.data = copyData(options.data ?? [], dir);
    writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Reads and checks an export's manifest. */
export function readExportManifest(dir: string): ExportManifest {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) throw new Error(`${dir} has no ${MANIFEST}: it is not a finished TailorIT export.`);
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as ExportManifest;
  if (manifest.format !== EXPORT_FORMAT) throw new Error(`${file} is not a TailorIT export (format ${String(manifest.format)}).`);
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`${file} is export format ${manifest.formatVersion}; this TailorIT reads format ${BACKUP_FORMAT_VERSION}.`);
  }
  return manifest;
}

/** Re-reads every file of an export against its manifest (rows and SHA-256). Answers what does not match. */
export async function checkExport(dir: string): Promise<string[]> {
  const manifest = readExportManifest(dir);
  const problems: string[] = [];
  for (const table of manifest.tables) {
    const tally = new Tally();
    try {
      await pipeline(createReadStream(join(dir, table.file)), createGunzip(), tally, async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) void chunk;
      });
    } catch (error) {
      problems.push(`${table.file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (tally.rows !== table.rows || tally.digest() !== table.sha256) {
      problems.push(`${table.file}: ${tally.rows} rows read, ${table.rows} written, or its checksum differs`);
    }
  }
  problems.push(...checkData(manifest.data ?? [], dir));
  return problems;
}

// ── The restore ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface RestoreOptions {
  /** The export's folder. */
  from: string;
  /** The new database's name. */
  database: string;
  /** Connection settings to a database of the server, given a database name (the server's own, or the new one). */
  connectionTo: (database: string) => PgConnection;
  /** The migration files the code has (apps/api/migrations-pg by default). */
  migrations?: PgMigrationFile[];
  log?: (line: string) => void;
}

export interface RestoreReport {
  database: string;
  tables: number;
  rows: number;
  /** The data folders the export holds (copied back by hand: DEPLOY.md). */
  data: string[];
  /**
   * v30 FIX-PG (PGL-20): the export's tables left out, their schema not being the migrations' (an export made before
   * FIX-PG holds E1's `refdata`: `npm run refdata:build` makes it again).
   */
  leftOut: string[];
}

/** The code's migration files for a manifest's: each recorded file must be the same file (same checksum). */
function migrationsFor(manifest: ExportManifest, files: PgMigrationFile[]): PgMigrationFile[] {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  return manifest.migrations.map((recorded) => {
    const file = byVersion.get(recorded.version);
    if (!file || file.checksum !== recorded.checksum) {
      const label = `${String(recorded.version).padStart(4, '0')}_${recorded.name}`;
      throw new Error(
        `This export was made at migration ${label}, which this TailorIT ${file ? 'has in another form' : 'does not have'}. ` +
          'Restore it with the TailorIT version that made it.',
      );
    }
    return file;
  });
}

/**
 * Loads an export into a new database (`database` must not exist, or exist with no table: a server's empty database).
 * Made and migrated to the export's migrations, loaded in one transaction, then analysed. A failure leaves no
 * half-loaded database: the load is rolled back, and a database this call made is dropped.
 */
export async function restoreDatabase(options: RestoreOptions): Promise<RestoreReport> {
  const manifest = readExportManifest(options.from);
  const log = options.log ?? (() => undefined);
  const files = migrationsFor(manifest, options.migrations ?? readPgMigrations());
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.database)) throw new Error(`Not a database name to restore into: ${options.database}`);
  const admin = await connect(options.connectionTo('postgres'));
  let made = false;
  try {
    const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [options.database])).rowCount! > 0;
    if (!exists) {
      await admin.query(`CREATE DATABASE ${ident(options.database)}`);
      made = true;
    }
    const target = await connect(options.connectionTo(options.database));
    try {
      if (!made) {
        const tables = await target.query(
          "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'",
        );
        if ((tables.rows[0] as { n: number }).n > 0) {
          throw new Error(`The database ${options.database} already holds tables: restore into a new database, then "use" it.`);
        }
      }
      const pool = new pg.Pool({ ...poolConfig(options.connectionTo(options.database)), max: 1 });
      try {
        await migratePg(pool, files);
      } finally {
        await pool.end();
      }
      log(`${options.database}: migrated to ${files.at(-1) ? String(files.at(-1)!.version).padStart(4, '0') : 'nothing'}`);
      const leftOut: string[] = [];
      const rows = await restoreInto(target, options.from, { log, leftOut });
      return {
        database: options.database,
        tables: manifest.tables.length - leftOut.length,
        rows,
        data: (manifest.data ?? []).map((folder) => folder.name),
        leftOut,
      };
    } finally {
      await target.end().catch(() => undefined);
    }
  } catch (error) {
    if (made) await admin.query(`DROP DATABASE IF EXISTS ${ident(options.database)} WITH (FORCE)`).catch(() => undefined);
    throw error;
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/**
 * Loads an export into the database `target` is connected to, which must be at exactly the export's migrations and
 * hold no account (restoreDatabase makes such a database; a test clones its migrated template). Then analyses it.
 * Answers the rows loaded.
 */
export async function restoreInto(
  target: pg.Client,
  from: string,
  options: { log?: (line: string) => void; leftOut?: string[] } = {},
): Promise<number> {
  const manifest = readExportManifest(from);
  const have = (await target.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
  const same =
    have.length === manifest.migrations.length &&
    have.every((row, i) => row.version === manifest.migrations[i]!.version && row.checksum === manifest.migrations[i]!.checksum);
  if (!same) throw new Error("The target database is not at the export's migrations.");
  if ((await target.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
    throw new Error('The target database already holds accounts: restore into a new database, then "use" it.');
  }
  const log = options.log ?? (() => undefined);
  const rows = await load(target, loadable(manifest, options.leftOut ?? [], log), from, log);
  await target.query('ANALYZE');
  return rows;
}

/**
 * v30 FIX-PG (PGL-20): the part of an export a migrated database can load: MIGRATED_SCHEMA's tables, sequences and
 * partitions. An export made before FIX-PG may hold E1's `refdata` (a schema no migration makes): its tables are left
 * out, named in `leftOut` and the log.
 */
function loadable(manifest: ExportManifest, leftOut: string[], log: (line: string) => void): ExportManifest {
  const ours = <T extends { schema: string }>(items: readonly T[]) => items.filter((item) => item.schema === MIGRATED_SCHEMA);
  for (const table of manifest.tables) {
    if (table.schema === MIGRATED_SCHEMA) continue;
    leftOut.push(`${table.schema}.${table.name}`);
    log(`${table.schema}.${table.name}: left out (no migration makes its schema; npm run refdata:build makes refdata again)`);
  }
  return { ...manifest, tables: ours(manifest.tables), sequences: ours(manifest.sequences), partitions: ours(manifest.partitions) };
}

/** The load itself, in one transaction on `target` (migrated, empty but for its reference rows). */
async function load(target: pg.Client, manifest: ExportManifest, dir: string, log: (line: string) => void): Promise<number> {
  await target.query('BEGIN');
  try {
    try {
      // Triggers (the counters, the snapshots, the match marks) and foreign keys off for the load: superuser only.
      await target.query('SET LOCAL session_replication_role = replica');
    } catch (error) {
      throw new Error(
        'The restore needs a superuser (it loads with triggers and foreign keys off). On a hosted server use pg_dump ' +
          `and pg_restore instead (DEPLOY.md). ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await makePartitions(target, manifest);
    if (manifest.tables.length) {
      await target.query(`TRUNCATE ${manifest.tables.map((table) => qualified(table.schema, table.name)).join(', ')}`);
    }
    let total = 0;
    for (const table of manifest.tables) {
      const tally = new Tally();
      const copy = copyFrom(`COPY ${qualified(table.schema, table.name)} (${table.columns.map(ident).join(', ')}) FROM STDIN`);
      await pipeline(createReadStream(join(dir, table.file)), createGunzip(), tally, target.query(copy));
      if (tally.rows !== table.rows || copy.rowCount !== table.rows || tally.digest() !== table.sha256) {
        throw new Error(`${table.file} does not match the manifest (${copy.rowCount} rows loaded, ${table.rows} exported, or its checksum differs).`);
      }
      total += table.rows;
      if (table.rows > 0) log(`${table.schema}.${table.name}: ${table.rows} rows`);
    }
    for (const sequence of manifest.sequences) {
      const name = literal(qualified(sequence.schema, sequence.name));
      if (sequence.lastValue === null) {
        await target.query(
          `SELECT setval(${name}, (SELECT min_value FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2), false)`,
          [sequence.schema, sequence.name],
        );
      } else {
        await target.query(`SELECT setval(${name}, $1::bigint, true)`, [sequence.lastValue]);
      }
    }
    await target.query('COMMIT');
    return total;
  } catch (error) {
    await target.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Makes the export's partitions the target lacks (the rows of other days and id ranges need them), LIKE + ATTACH. */
async function makePartitions(target: pg.Client, manifest: ExportManifest): Promise<void> {
  const have = (await target.query<{ schema: string; parent: string; name: string; bound: string }>(PARTITIONS_SQL)).rows;
  for (const part of manifest.partitions) {
    if (have.some((h) => h.schema === part.schema && h.parent === part.parent && h.bound === part.bound)) continue;
    const exists = (await target.query<{ found: boolean }>(`SELECT to_regclass(${literal(qualified(part.schema, part.name))}) IS NOT NULL AS found`)).rows[0]!.found;
    if (!exists) {
      await target.query(`CREATE TABLE ${qualified(part.schema, part.name)} (LIKE ${qualified(part.schema, part.parent)} INCLUDING ALL)`);
    }
    await target.query(`ALTER TABLE ${qualified(part.schema, part.parent)} ATTACH PARTITION ${qualified(part.schema, part.name)} ${part.bound}`);
  }
}

/**
 * Makes `database` the app's database (`app`): the current one is renamed `<app>_before_<stamp>` (kept), then
 * `database` takes its name. Refused while either has a session open (stop TailorIT first). Answers the old one's new name.
 */
export async function useDatabase(admin: pg.Client, app: string, database: string, now = new Date()): Promise<string | null> {
  const names = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1)', [[app, database]]);
  const found = new Set(names.rows.map((row) => row.datname));
  if (!found.has(database)) throw new Error(`There is no database ${database} to use.`);
  const sessions = await admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ANY($1) AND pid <> pg_backend_pid()',
    [[app, database]],
  );
  if (sessions.rows[0]!.n > 0) throw new Error(`${app} or ${database} has sessions open: stop TailorIT first.`);
  let before: string | null = null;
  if (found.has(app)) {
    before = `${app}_before_${now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)}`;
    await admin.query(`ALTER DATABASE ${ident(app)} RENAME TO ${ident(before)}`);
  }
  await admin.query(`ALTER DATABASE ${ident(database)} RENAME TO ${ident(app)}`);
  return before;
}

// ── The cold copy ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every file under `dir` with its size (relative paths, forward slashes), `skip` aside. */
function filesOf(dir: string, skip: (path: string) => boolean = () => false): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const rel = relative(dir, full).split('\\').join('/');
      if (skip(rel)) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.set(rel, stat.size);
    }
  };
  walk(dir);
  return out;
}

/** postmaster.pid is a running server's: never part of a copy. */
const skipPid = (rel: string) => rel === 'postmaster.pid';

/** The copy must hold every file of the source, at the same size. */
function assertSameFiles(source: string, copy: string): { files: number; bytes: number } {
  const want = filesOf(source, skipPid);
  const got = filesOf(copy, skipPid);
  for (const [path, size] of want) {
    if (got.get(path) !== size) throw new Error(`The copy of ${path} is ${got.has(path) ? 'not the same size' : 'missing'}.`);
  }
  let bytes = 0;
  for (const size of want.values()) bytes += size;
  return { files: want.size, bytes };
}

/** Copies each data folder that exists into `<to>/data/<name>`, checked file by file (sizes). */
function copyData(folders: DataFolder[], to: string): CopiedFolder[] {
  const out: CopiedFolder[] = [];
  for (const folder of folders) {
    if (!existsSync(folder.path)) continue;
    const target = join(to, 'data', folder.name);
    cpSync(folder.path, target, { recursive: true });
    out.push({ name: folder.name, ...assertSameFiles(folder.path, target) });
  }
  return out;
}

/** What does not match among a backup's data folders (file counts and bytes). */
function checkData(copied: CopiedFolder[], dir: string): string[] {
  return copied.flatMap((folder) => {
    const path = join(dir, 'data', folder.name);
    const files = existsSync(path) ? filesOf(path) : new Map<string, number>();
    let bytes = 0;
    for (const size of files.values()) bytes += size;
    return files.size === folder.files && bytes === folder.bytes ? [] : [`data/${folder.name}: ${files.size} files, ${folder.files} copied`];
  });
}

export interface ColdCopyOptions {
  /** The cluster's data folder (PGDATA). */
  dataDir: string;
  /** Its password file (`<PG_DATA_DIR>.password`), copied beside it when there is one. */
  passwordFile: string;
  /** The backup folder (missing or empty). */
  to: string;
  /** Whether the server runs on that folder now (pg_ctl status). */
  running: () => Promise<boolean>;
  /** The app's data folders copied with it, into `<to>/data/<name>`. */
  data?: DataFolder[];
  now?: Date;
}

/**
 * Copies the stopped cluster's data folder to `<to>/pg` (its password file to `<to>/pg.password`, the data folders to
 * `<to>/data/`).
 */
export async function coldCopy(options: ColdCopyOptions): Promise<ColdManifest> {
  if (!existsSync(join(options.dataDir, 'PG_VERSION'))) throw new Error(`${options.dataDir} holds no PostgreSQL cluster.`);
  if (await options.running()) {
    throw new Error(`PostgreSQL is running on ${options.dataDir}: stop TailorIT first (a cold copy needs the server stopped).`);
  }
  assertEmptyFolder(options.to, 'The backup folder');
  mkdirSync(options.to, { recursive: true });
  const target = join(options.to, 'pg');
  cpSync(options.dataDir, target, { recursive: true, filter: (source) => !skipPid(relative(options.dataDir, source)) });
  const hasPassword = existsSync(options.passwordFile);
  if (hasPassword) copyFileSync(options.passwordFile, join(options.to, 'pg.password'));
  const { files, bytes } = assertSameFiles(options.dataDir, target);
  const data = copyData(options.data ?? [], options.to);
  const manifest: ColdManifest = {
    format: COLD_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: (options.now ?? new Date()).toISOString(),
    pgVersion: readFileSync(join(options.dataDir, 'PG_VERSION'), 'utf8').trim(),
    source: options.dataDir,
    files,
    bytes,
    passwordFile: hasPassword,
    data,
  };
  writeFileSync(join(options.to, COLD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export interface ColdRestoreOptions {
  /** The backup folder coldCopy wrote. */
  from: string;
  dataDir: string;
  passwordFile: string;
  running: () => Promise<boolean>;
  /** Where each data folder of the copy goes back (by name); a folder the copy holds and this does not name stays out. */
  data?: DataFolder[];
  /** Move a cluster (and data folders) already in place aside (`<path>.before-restore-<stamp>`) instead of refusing. */
  replace?: boolean;
  now?: Date;
}

/** Puts a cold copy back (the server stopped). Answers where a cluster that was there went, if one was. */
export async function coldRestore(options: ColdRestoreOptions): Promise<{ movedAside: string | null }> {
  const manifestFile = join(options.from, COLD_MANIFEST);
  if (!existsSync(manifestFile)) throw new Error(`${options.from} has no ${COLD_MANIFEST}: it is not a finished cold copy.`);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as ColdManifest;
  if (manifest.format !== COLD_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`${manifestFile} is not a cold copy this TailorIT reads.`);
  }
  const source = join(options.from, 'pg');
  const copied = assertSameFiles(source, source);
  if (copied.files !== manifest.files || copied.bytes !== manifest.bytes) {
    throw new Error(`The cold copy in ${options.from} is not whole (${copied.files} files, ${manifest.files} copied).`);
  }
  const folders = (manifest.data ?? []).flatMap((copied) => {
    const place = options.data?.find((folder) => folder.name === copied.name);
    return place ? [{ copied, place }] : [];
  });
  for (const { copied } of folders) {
    if (filesOf(join(options.from, 'data', copied.name)).size !== copied.files) {
      throw new Error(`The cold copy's data/${copied.name} is not whole.`);
    }
  }
  if (await options.running()) throw new Error(`PostgreSQL is running on ${options.dataDir}: stop TailorIT first.`);
  const taken = (path: string) => existsSync(path) && readdirSync(path).length > 0;
  const occupied = [options.dataDir, ...folders.map(({ place }) => place.path)].filter(taken);
  if (occupied.length > 0 && !options.replace) {
    throw new Error(`${occupied.join(', ')}: already in use. Pass --replace to move it aside and restore the copy.`);
  }
  const stamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const aside = (path: string) => `${path.replace(/[\\/]+$/, '')}.before-restore-${stamp}`;
  let movedAside: string | null = null;
  if (taken(options.dataDir)) {
    movedAside = aside(options.dataDir);
    renameSync(options.dataDir, movedAside);
    if (existsSync(options.passwordFile)) renameSync(options.passwordFile, `${movedAside}.password`);
  }
  for (const { place } of folders) if (taken(place.path)) renameSync(place.path, aside(place.path));
  cpSync(source, options.dataDir, { recursive: true });
  if (manifest.passwordFile) copyFileSync(join(options.from, 'pg.password'), options.passwordFile);
  assertSameFiles(source, options.dataDir);
  for (const { copied, place } of folders) {
    cpSync(join(options.from, 'data', copied.name), place.path, { recursive: true });
    assertSameFiles(join(options.from, 'data', copied.name), place.path);
  }
  return { movedAside };
}
