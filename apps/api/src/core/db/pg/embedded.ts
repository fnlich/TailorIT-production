import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { PgConnection } from './client';
import { poolConfig } from './client';

// v3.0 PG-0 (PLAN §0.3, DECISIONS P1 Q2): a PostgreSQL 18 cluster from npm (`embedded-postgres`' zonky binaries), so
// the owner's install and every test run get PostgreSQL with no manual setup. Any PostgreSQL 18 replaces it through
// DATABASE_URL.
//
// - The binaries come from the platform package (`@embedded-postgres/windows-x64` on this machine); embedded-postgres'
//   own `initialise()` makes the cluster (it also repairs the packages' symlinks on Linux and macOS).
// - Start and stop go through `pg_ctl` (start -w, stop -m fast): the server runs detached, outlives the process that
//   started it, shuts down cleanly, and a second process finds it running (`pg_ctl status`). embedded-postgres' own
//   start() would tie the server to one Node process and stop it with a forced kill on Windows.
// - The cluster listens on 127.0.0.1 only, with scram-sha-256 passwords: the owner's install keeps a random password
//   in a file next to its data folder (`<PG_DATA_DIR>.password`); test clusters use a fixed one (test data only).
// - initdb: UTF-8 with the builtin C.UTF-8 locale (PostgreSQL 17+): byte-order sorting and Unicode case mapping, the
//   same on every machine. Code that needs byte order (link-key ranges) still says COLLATE "C" (dialect.collateC).
// - Windows needs the Microsoft Visual C++ 2015-2022 x64 runtime, 14.44 or later (an older msvcp140 crashes initdb).

export interface ClusterSettings {
  /** The cluster's data folder (PGDATA). */
  dataDir: string;
  port: number;
  user: string;
  password: string;
  /** Extra server settings, as `-c name=value` at start. */
  settings?: Record<string, string | number>;
  /**
   * v30 SCH: server settings TailorIT ships as its defaults, given at start like `settings` unless the cluster's own
   * postgresql.auto.conf names them (`ALTER SYSTEM SET name = value`), so an owner's change wins (a `-c` option would
   * outrank it).
   */
  defaults?: Readonly<Record<string, string | number>>;
}

/** The superuser every TailorIT cluster is made with. */
export const CLUSTER_USER = 'tailorit';
/** The database the app uses in the owner's cluster. */
export const APP_DATABASE = 'tailorit';
/** The owner's cluster's port (PLAN §0.3); tests never use it. */
export const DEFAULT_PG_PORT = 5442;
/** The test clusters' password: loopback only, test data only. */
export const TEST_CLUSTER_PASSWORD = 'tailorit-test';
/** The test cluster's port when TEST_PG_PORT is unset (each builder sets its own 55NN). */
export const DEFAULT_TEST_PG_PORT = 5543;

/** Fast and unsafe on a crash: a test cluster's data is thrown away anyway. */
export const TEST_SERVER_SETTINGS: Record<string, string | number> = {
  fsync: 'off',
  synchronous_commit: 'off',
  full_page_writes: 'off',
  max_connections: 300,
  shared_buffers: '128MB',
  max_locks_per_transaction: 256,
};

interface Binaries {
  initdb: string;
  pg_ctl: string;
  postgres: string;
}

let binariesFound: Promise<Binaries> | null = null;

/** The platform package's binaries (the same lookup as embedded-postgres' own). */
export function pgBinaries(): Promise<Binaries> {
  binariesFound ??= (async () => {
    const os = platform() === 'win32' ? 'windows' : platform();
    const name = `@embedded-postgres/${os}-${arch()}`;
    try {
      const found = (await import(name)) as Partial<Binaries>;
      if (!found.pg_ctl || !found.initdb || !found.postgres) throw new Error(`${name} names no pg_ctl, initdb or postgres.`);
      return { initdb: found.initdb, pg_ctl: found.pg_ctl, postgres: found.postgres };
    } catch (error) {
      throw new Error(
        `The embedded PostgreSQL for ${platform()}-${arch()} is not installed (${name}): run npm ci, or set ` +
          `DATABASE_URL to a PostgreSQL 18 server. (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  })();
  return binariesFound;
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    // No pipes: pg_ctl's server would inherit them and hold them open after pg_ctl exits.
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** True once initdb has made the folder a cluster. */
export function clusterInitialised(dataDir: string): boolean {
  return existsSync(join(dataDir, 'PG_VERSION'));
}

const logFileOf = (dataDir: string) => join(dataDir, 'server.log');

/** The end of the server's log, for an error message. */
function logTail(dataDir: string): string {
  try {
    return readFileSync(logFileOf(dataDir), 'utf8').split(/\r?\n/).slice(-15).join('\n');
  } catch {
    return '(no server log)';
  }
}

/** Makes the cluster (initdb) in an empty or missing folder. */
export async function initCluster(cluster: ClusterSettings): Promise<void> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  mkdirSync(dirname(cluster.dataDir), { recursive: true });
  const messages: string[] = [];
  const maker = new EmbeddedPostgres({
    databaseDir: cluster.dataDir,
    port: cluster.port,
    user: cluster.user,
    password: cluster.password,
    authMethod: 'scram-sha-256',
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--locale=C'],
    onLog: (message: string) => messages.push(message),
    onError: (message: unknown) => messages.push(String(message)),
  });
  try {
    await maker.initialise();
  } catch (error) {
    throw new Error(
      `initdb could not make the PostgreSQL cluster in ${cluster.dataDir}. On Windows this needs the Microsoft ` +
        'Visual C++ 2015-2022 x64 runtime (14.44 or later). ' +
        `${error instanceof Error ? error.message : String(error)}\n${messages.join('').slice(-2000)}`,
    );
  }
}

/** Whether the cluster's server is running (pg_ctl status). */
export async function clusterRunning(cluster: Pick<ClusterSettings, 'dataDir'>): Promise<boolean> {
  if (!clusterInitialised(cluster.dataDir)) return false;
  const { pg_ctl } = await pgBinaries();
  return (await run(pg_ctl, ['status', '-D', cluster.dataDir])) === 0;
}

/** v30 SCH: the setting names a postgresql.auto.conf text sets (ALTER SYSTEM's `name = 'value'` lines), in lower case. */
export function autoConfNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(line);
    if (match) names.add(match[1]!.toLowerCase());
  }
  return names;
}

/**
 * v30 SCH: the settings a start gives (pure): loopback only, the defaults the cluster's postgresql.auto.conf
 * (`autoConf`, its text) does not set, then `settings`.
 */
export function startSettingsOf(cluster: Pick<ClusterSettings, 'settings' | 'defaults'>, autoConf = ''): Record<string, string | number> {
  const owned = autoConfNames(autoConf);
  const defaults = Object.entries(cluster.defaults ?? {}).filter(([name]) => !owned.has(name.toLowerCase()));
  return { listen_addresses: '127.0.0.1', ...Object.fromEntries(defaults), ...cluster.settings };
}

function serverOptions(cluster: ClusterSettings): string {
  let autoConf = '';
  try {
    autoConf = readFileSync(join(cluster.dataDir, 'postgresql.auto.conf'), 'utf8');
  } catch {
    autoConf = '';
  }
  const settings = startSettingsOf(cluster, autoConf);
  return [`-p ${cluster.port}`, ...Object.entries(settings).map(([name, value]) => `-c ${name}=${value}`)].join(' ');
}

/** Starts the server (detached) and waits until it takes connections. */
export async function startCluster(cluster: ClusterSettings): Promise<void> {
  const { pg_ctl } = await pgBinaries();
  const code = await run(pg_ctl, [
    'start',
    '-D',
    cluster.dataDir,
    '-l',
    logFileOf(cluster.dataDir),
    '-w',
    '-t',
    '120',
    '-o',
    serverOptions(cluster),
  ]);
  if (code !== 0 && !(await clusterRunning(cluster))) {
    throw new Error(
      `PostgreSQL did not start on 127.0.0.1:${cluster.port} (${cluster.dataDir}). Is the port taken? Its log:\n` +
        logTail(cluster.dataDir),
    );
  }
  await waitForConnections(cluster);
}

/** Stops the server: fast mode (open sessions are ended, their transactions rolled back), then waits for it. */
export async function stopCluster(cluster: Pick<ClusterSettings, 'dataDir'>): Promise<void> {
  if (!(await clusterRunning(cluster))) return;
  const { pg_ctl } = await pgBinaries();
  const code = await run(pg_ctl, ['stop', '-D', cluster.dataDir, '-m', 'fast', '-w', '-t', '60']);
  if (code !== 0 && (await clusterRunning(cluster))) {
    throw new Error(`PostgreSQL in ${cluster.dataDir} did not stop. Its log:\n${logTail(cluster.dataDir)}`);
  }
}

async function waitForConnections(cluster: ClusterSettings, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const client = new pg.Client(poolConfig(connectionOf(cluster, 'postgres')));
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error(`PostgreSQL on port ${cluster.port} takes no connections: ${String(last)}`);
}

/**
 * Makes the cluster when its folder has none, and starts it when it is not running. `started` says whether this call
 * started it (the caller that started it may stop it). Two processes racing to start one cluster both succeed.
 */
export async function ensureCluster(cluster: ClusterSettings): Promise<{ started: boolean }> {
  if (!clusterInitialised(cluster.dataDir)) await initCluster(cluster);
  if (await clusterRunning(cluster)) {
    await waitForConnections(cluster);
    return { started: false };
  }
  await startCluster(cluster);
  return { started: true };
}

/** Connection settings for a database of the cluster (loopback). */
export function connectionOf(cluster: Pick<ClusterSettings, 'port' | 'user' | 'password'>, database: string): PgConnection {
  return { host: '127.0.0.1', port: cluster.port, user: cluster.user, password: cluster.password, database };
}

/** A postgres:// URL for a database of the cluster. */
export function urlOf(cluster: Pick<ClusterSettings, 'port' | 'user' | 'password'>, database: string): string {
  return `postgres://${encodeURIComponent(cluster.user)}:${encodeURIComponent(cluster.password)}@127.0.0.1:${cluster.port}/${encodeURIComponent(database)}`;
}

/** A database name the harness and the scripts may make and drop: lower case letters, digits and `_`. */
export function assertDatabaseName(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Not a database name TailorIT makes: ${name}`);
  return name;
}

/** Runs `fn` on a connection to the cluster's `postgres` database. */
export async function onAdmin<T>(cluster: ClusterSettings, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(poolConfig(connectionOf(cluster, 'postgres')));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Makes the database when it does not exist (`fresh`: drops it first, ending its sessions). */
export async function ensureDatabase(cluster: ClusterSettings, name: string, { fresh = false } = {}): Promise<void> {
  assertDatabaseName(name);
  await onAdmin(cluster, async (client) => {
    if (fresh) await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount) return;
    try {
      await client.query(`CREATE DATABASE "${name}"`);
    } catch (error) {
      // Another process made it a moment ago.
      if ((error as { code?: string }).code !== '42P04') throw error;
    }
  });
}

// ── The owner's cluster ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * v30 SCH: the owner's cluster's server settings (DEPLOY.md §5.1, a desktop with an SSD), given at each
 * start unless the cluster's postgresql.auto.conf sets them (ClusterSettings.defaults): a forgotten open transaction
 * never holds its locks for long; sorts, facets, index builds and vacuums in memory; an SSD's index reads; fewer
 * checkpoints in a big ingest; smaller WAL. Each of those costs memory only while it is used.
 *
 * v30 FIX-PG (PG-LOAD's measurements, docs/design/part2/measurements.md §5): `shared_buffers` 1GB (memory held for the
 * server's whole life: a 16 GB desktop keeps 15) instead of PostgreSQL's 128MB, measured at mix B's base size: the
 * filtered Jobs-page count 505 → 88 ms, a large company's closed history 554 → 63 ms, the job page 29 → 11 ms. And
 * `default_toast_compression` lz4 instead of pglz: the posting texts and the search vectors, the largest values, are
 * stored compressed with lz4 (faster to write and read; the bundle has lz4, as `wal_compression` shows). It applies to
 * the values written from then on. An owner's `ALTER SYSTEM` still wins over each.
 */
export const APP_SERVER_DEFAULTS: Readonly<Record<string, string | number>> = {
  idle_in_transaction_session_timeout: '10min',
  shared_buffers: '1GB',
  work_mem: '32MB',
  maintenance_work_mem: '512MB',
  effective_cache_size: '6GB',
  random_page_cost: 1.1,
  max_wal_size: '2GB',
  wal_compression: 'lz4',
  default_toast_compression: 'lz4',
};

/**
 * Where the owner's cluster lives and listens (config/env.ts reads them: PG_DATA_DIR or `<DATA_DIR>/pg`, PG_PORT or
 * 5442), with TailorIT's server defaults.
 */
export function appClusterSettings(database: { pgDataDir: string; pgPort: number }): ClusterSettings {
  return {
    dataDir: database.pgDataDir,
    port: database.pgPort,
    user: CLUSTER_USER,
    password: appClusterPassword(database.pgDataDir),
    defaults: APP_SERVER_DEFAULTS,
  };
}

/** The owner's cluster's password: made once (random), kept in `<PG_DATA_DIR>.password` beside the data folder. */
export function appClusterPassword(pgDataDir: string): string {
  const file = `${pgDataDir.replace(/[\\/]+$/, '')}.password`;
  if (existsSync(file)) {
    const kept = readFileSync(file, 'utf8').trim();
    if (kept) return kept;
  }
  if (clusterInitialised(pgDataDir)) {
    throw new Error(`${pgDataDir} holds a PostgreSQL cluster but its password file ${file} is missing.`);
  }
  const made = randomBytes(24).toString('base64url');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${made}\n`, { mode: 0o600 });
  return made;
}

// ── Test clusters (vitest's global setup, scripts/test-servers.mjs) ──────────────────────────────────────────────

/** TEST_PG_PORT (each builder's 55NN) and TEST_PG_DATA_DIR (default: a folder in the OS temp folder per port). */
export function testClusterSettings(env: NodeJS.ProcessEnv = process.env): ClusterSettings {
  const port = Number(env.TEST_PG_PORT?.trim() || DEFAULT_TEST_PG_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TEST_PG_PORT=${env.TEST_PG_PORT} is not a port number.`);
  }
  if (port === DEFAULT_PG_PORT) throw new Error(`TEST_PG_PORT=${port} is the owner's PostgreSQL port: choose a 55NN port.`);
  const dataDir = env.TEST_PG_DATA_DIR?.trim() || join(tmpdir(), `tailorit-test-pg-${port}`);
  return { dataDir, port, user: CLUSTER_USER, password: TEST_CLUSTER_PASSWORD, settings: TEST_SERVER_SETTINGS };
}

/** Removes a stopped cluster's folder (a test cluster that will not start, say). */
export function removeCluster(dataDir: string): void {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
