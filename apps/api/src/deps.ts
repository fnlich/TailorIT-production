import { getConfig, type AppConfig } from './config/env';
import type { AppDeps } from './core/context';
import { openAppDatabase } from './core/db/engine';
import { createLogger } from './core/log';

/**
 * Opens the database, applies migrations and builds the dependency bag shared by the server and the CLI. v3.0 D2:
 * `deps.db` is the async client (core/db); a transaction that awaits outside I/O is logged ('warn'). v3.0 PG-0:
 * PostgreSQL (DATABASE_URL, or the embedded cluster in <DATA_DIR>/pg: core/db/engine.ts).
 */
export async function createRuntimeDeps(config: AppConfig = getConfig()): Promise<AppDeps> {
  const log = createLogger(config.logLevel);
  const { db, applied, where } = await openAppDatabase({
    database: config.database,
    ioGuard: 'warn',
    warn: (message) => log.warn(message),
    info: (message) => log.info(message),
  });
  log.info(`[api] database: ${where}`);
  if (applied.length) log.info(`[api] applied migrations: ${applied.join(', ')}`);
  return { db, config, log, now: () => new Date(), services: {} };
}
