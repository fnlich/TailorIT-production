import type { AppConfig } from '../../config/env';
import { createPgClient, createPgPool, type PgConnection } from './pg/client';
import { APP_DATABASE, appClusterSettings, connectionOf, ensureCluster, ensureDatabase } from './pg/embedded';
import { migratePg } from './pg/migrate';
import type { DbClient, IoGuardMode } from './types';

// v3.0 PG-0: which PostgreSQL the API, the worker and the CLI open (PLAN §8, §0.3). v30 SCH: from the configuration
// (config/env.ts's `database`: DATABASE_URL, PG_PORT, PG_DATA_DIR, PG_POOL_MAX), never process.env.
// - DATABASE_URL set: that PostgreSQL 18 server (a managed service once there is a host).
// - Otherwise the embedded cluster in PG_DATA_DIR or <DATA_DIR>/pg on PG_PORT (5442): made and started when it is not
//   running (the launchers, scripts/dev.mjs and start.mjs, start it first and stop it at the end; one started here
//   keeps running after this process).
// Pending migrations (apps/api/migrations-pg) are applied either way. v3.0 RET retired SQLite: there is no other engine.

export interface OpenedDatabase {
  db: DbClient;
  /** The migration files applied now. */
  applied: string[];
  /** Where it is, for the start-up line (no password). */
  where: string;
}

export interface OpenDatabaseOptions {
  /** v30 SCH: config.database. */
  database: AppConfig['database'];
  ioGuard?: IoGuardMode;
  warn?: (message: string) => void;
  /** Said once the embedded cluster had to be started by this process. */
  info?: (message: string) => void;
}

/** Opens and migrates the app's database (see the module's note). */
export async function openAppDatabase(options: OpenDatabaseOptions): Promise<OpenedDatabase> {
  const ioGuard = options.ioGuard ?? 'warn';
  let connection: PgConnection;
  let where: string;
  const url = options.database.url;
  if (url) {
    connection = { connectionString: url };
    where = `PostgreSQL ${redact(url)}`;
  } else {
    const cluster = appClusterSettings(options.database);
    const { started } = await ensureCluster(cluster);
    if (started) options.info?.(`[db] started the embedded PostgreSQL in ${cluster.dataDir} on port ${cluster.port}`);
    await ensureDatabase(cluster, APP_DATABASE);
    connection = connectionOf(cluster, APP_DATABASE);
    where = `PostgreSQL 127.0.0.1:${cluster.port}/${APP_DATABASE} (embedded, ${cluster.dataDir})`;
  }
  const pool = createPgPool({ ...connection, max: options.database.poolMax }, (error) =>
    options.warn?.(`[db] idle connection: ${error.message}`),
  );
  try {
    const { applied } = await migratePg(pool);
    return { db: createPgClient({ pool, endPool: true, ioGuard, warn: options.warn }), applied, where };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/** A postgres:// URL without its password. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(DATABASE_URL)';
  }
}
