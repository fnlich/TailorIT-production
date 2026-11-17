#!/usr/bin/env node
// `npm run dev`: the API (tsx watch) and the web app (Next dev) side by side, with the root `.env` loaded. v30 S1-API:
// and the ingest worker (`src/cli.ts ingest:worker`: the due queue of job sources, purges), which the API no longer runs.
// `npm run dev:webpack` starts Next with webpack instead of Turbopack.
// Ctrl-C (or either server exiting) stops both, including their child processes.
// v3.0 PG-0: with no DATABASE_URL the embedded PostgreSQL (PG_DATA_DIR or <DATA_DIR>/pg on
// PG_PORT, 5442) is started first, so it outlives the API's restarts, and stopped last when this script started it.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { databaseSettings, loadRootEnv, repoRoot } from './env.mjs';
import { killTree, paint, runNode } from './proc.mjs';

loadRootEnv();

const useWebpack = process.argv.includes('--webpack');
const require = createRequire(join(repoRoot, 'package.json'));
const tsxCli = require.resolve('tsx/cli');

const children = [];
let stopping = false;

/** The API's cluster command (apps/api/src/core/db/pg/cluster-cli.ts): its JSON line, or exit with its error. */
function cluster(command) {
  const result = spawnSync(process.execPath, [tsxCli, 'src/core/db/pg/cluster-cli.ts', command], {
    cwd: join(repoRoot, 'apps', 'api'),
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(paint('red', `[dev] PostgreSQL ${command} failed: ${(result.stderr || result.stdout).trim()}`));
    return null;
  }
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? '{}');
}

const embedded = databaseSettings().embedded;
let startedCluster = false;
if (embedded) {
  const started = cluster('start');
  if (!started) process.exit(1);
  startedCluster = started.started === true;
  console.log(paint('gray', `[dev] PostgreSQL 127.0.0.1:${started.port}${startedCluster ? ' (started)' : ' (already running)'}`));
}

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  if (startedCluster) cluster('stop');
  setTimeout(() => process.exit(exitCode), 300);
}

function watch(name, child) {
  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(paint('red', `[dev] ${name} exited (${signal ?? code}); stopping the other server.`));
    stop(code ?? 1);
  });
}

/** A host setting (WEB_HOST, API_HOST) as a URL writes it: an IPv6 address in brackets. */
const urlHost = (host) => {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  return bare.includes(':') ? `[${bare}]` : bare;
};
// Where each server listens (WEB_HOST and WEB_PORT, API_HOST and API_PORT), and APP_ORIGIN, the address to open, when it
// is not the web server's own (a LAN address with WEB_HOST=0.0.0.0, or a reverse proxy).
const web = `http://${urlHost(process.env.WEB_HOST?.trim() || 'localhost')}:${process.env.WEB_PORT?.trim() || 3100}`;
const api = `http://${urlHost(process.env.API_HOST?.trim() || '127.0.0.1')}:${process.env.API_PORT?.trim() || 4100}`;
const open = process.env.APP_ORIGIN?.trim().replace(/\/+$/, '');
console.log(paint('gray', `[dev] web ${web}  api ${api}${open && open !== web ? `  open ${open}` : ''}`));

watch(
  'api',
  runNode('api', 'cyan', [tsxCli, 'watch', '--clear-screen=false', 'src/index.ts'], {
    cwd: join(repoRoot, 'apps', 'api'),
  }),
);
// v30 S1-API: the ingest worker process (features/ingest/worker.ts), beside the API.
watch(
  'worker',
  runNode('worker', 'yellow', [tsxCli, 'watch', '--clear-screen=false', 'src/cli.ts', 'ingest:worker'], {
    cwd: join(repoRoot, 'apps', 'api'),
  }),
);
watch(
  'web',
  runNode('web', 'magenta', [join(repoRoot, 'scripts', 'next-launch.mjs'), useWebpack ? 'dev-webpack' : 'dev'], {
    cwd: join(repoRoot, 'apps', 'web'),
  }),
);

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
