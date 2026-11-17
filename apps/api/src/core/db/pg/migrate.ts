import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { apiRoot } from '../../paths';

// v3.0 PG-0 (11-database.md §9, PLAN §4): forward-only PostgreSQL migrations, apps/api/migrations-pg/NNNN_name.sql,
// applied in order and recorded with a checksum in schema_migrations. A recorded file that has since changed refuses
// startup: a schema change is a NEW file in the package's number (PLAN §4: 0001 the baseline, 0002-0009 W2, 0010 on
// the feature waves).
//
// Each file runs in one transaction (PostgreSQL's DDL is transactional), except a file whose first line is
//   -- tailorit:no-transaction
// (CREATE INDEX CONCURRENTLY and DETACH PARTITION ... CONCURRENTLY refuse a transaction block): its statements run
// one by one, and it is recorded after the last one. Write such a file so a rerun after a failure is harmless
// (IF NOT EXISTS, IF EXISTS).
//
// Two processes starting at once (the API and the worker) take turns: the runner holds an advisory lock while it
// reads and applies.
//
// v30 FIX-PG: a runner waits for that lock by trying it again every LOCK_RETRY_MS (pg_try_advisory_lock), never inside
// pg_advisory_lock. A statement blocked in pg_advisory_lock keeps its snapshot open, and CREATE INDEX CONCURRENTLY (in
// the other runner's no-transaction file, 0036's) waits for every older snapshot of the database: the two deadlocked,
// and PostgreSQL failed the index build ("deadlock detected"), so a fresh start of the API and the worker together
// would stop one of them. Between tries the waiting runner holds no snapshot.

export interface PgMigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
  /** False for a file marked `-- tailorit:no-transaction`. */
  transaction: boolean;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const NO_TRANSACTION = /^--\s*tailorit:no-transaction\b/;
/** pg_advisory_lock's key for the runner: any fixed number no other code uses. */
const MIGRATION_LOCK = 7_320_011;
/** v30 FIX-PG: how long a runner waits between tries for the lock (see the top). */
const LOCK_RETRY_MS = 100;

/** apps/api/migrations-pg */
export function migrationsPgDir(): string {
  return join(apiRoot(), 'migrations-pg');
}

export function readPgMigrations(dir = migrationsPgDir()): PgMigrationFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((file) => FILE_PATTERN.test(file))
    .sort();
  const seen = new Set<number>();
  return files.map((file) => {
    const [, version, name] = FILE_PATTERN.exec(file)!;
    const v = Number(version);
    if (seen.has(v)) throw new Error(`Two PostgreSQL migrations share version ${version} (${file}).`);
    seen.add(v);
    const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    return {
      version: v,
      name: name!,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      transaction: !NO_TRANSACTION.test(sql),
    };
  });
}

/** One hash of every file's version and checksum: names a test template made from exactly these files. */
export function migrationsFingerprint(files = readPgMigrations()): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.version}:${file.checksum}\n`);
  return hash.digest('hex');
}

/**
 * The statements of a script, split at top-level semicolons (outside strings, quoted names, comments and dollar
 * quotes), for files that run outside a transaction.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? n : end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 66));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? n : close + tag[0].length;
      } else i += 1;
    } else if (c === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement && !/^(--[^\n]*\n?\s*)*$/.test(statement)) out.push(statement);
      start = i + 1;
      i += 1;
    } else i += 1;
  }
  const rest = sql.slice(start).trim();
  if (rest && !/^(\s*--[^\n]*)*\s*$/.test(rest)) out.push(rest);
  return out;
}

const label = (file: PgMigrationFile) => `${String(file.version).padStart(4, '0')}_${file.name}`;

/** Applies the pending files on one connection of `pool` (see the module's note). */
export async function migratePg(pool: pg.Pool, files = readPgMigrations()): Promise<{ applied: string[] }> {
  const client = await pool.connect();
  try {
    // Tried, not waited for inside the statement (see the top): no snapshot is held while the other runner applies.
    while (!(await client.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [MIGRATION_LOCK])).rows[0]?.got) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    try {
      return await applyPending(client, files);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}

async function applyPending(client: pg.PoolClient, files: PgMigrationFile[]): Promise<{ applied: string[] }> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations(
    version integer PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const recorded = new Map(
    (await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map(
      (row) => [row.version, row.checksum],
    ),
  );
  const applied: string[] = [];
  for (const file of files) {
    const checksum = recorded.get(file.version);
    if (checksum !== undefined) {
      if (checksum !== file.checksum) {
        throw new Error(
          `PostgreSQL migration ${label(file)}.sql changed after it was applied. Restore the original file and put ` +
            'schema changes in a new migration.',
        );
      }
      continue;
    }
    const record = () =>
      client.query('INSERT INTO schema_migrations(version, name, checksum) VALUES ($1, $2, $3)', [
        file.version,
        file.name,
        file.checksum,
      ]);
    if (file.transaction) {
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await record();
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`PostgreSQL migration ${label(file)}.sql failed: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    } else {
      for (const statement of splitStatements(file.sql)) {
        try {
          await client.query(statement);
        } catch (error) {
          throw new Error(
            `PostgreSQL migration ${label(file)}.sql failed at "${statement.slice(0, 120)}": ` +
              `${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      await record();
    }
    applied.push(label(file));
  }
  return { applied };
}
