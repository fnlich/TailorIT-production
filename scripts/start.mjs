#!/usr/bin/env node
// `npm start`: the production build of both apps (run `npm run build` first).
// v3.0 PG-0: with no DATABASE_URL the embedded PostgreSQL (PG_DATA_DIR or <DATA_DIR>/pg on
// PG_PORT, 5442) is started first and stopped last when this script started it (dist/cluster-cli.js).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { databaseSettings, loadRootEnv, repoRoot } from './env.mjs';
import { killTree, paint, runNode } from './proc.mjs';

loadRootEnv();
process.env.NODE_ENV ??= 'production';

const apiEntry = join(repoRoot, 'apps', 'api', 'dist', 'index.js');
if (!existsSync(apiEntry) || !existsSync(join(repoRoot, 'apps', 'web', '.next'))) {
  console.error(paint('red', '[start] No production build found. Run `npm run build` first.'));
  process.exit(1);
}

const children = [];
let stopping = false;

/** The API's cluster command (dist/cluster-cli.js): its JSON line, or null after saying why. */
function cluster(command) {
  const result = spawnSync(process.execPath, [join(repoRoot, 'apps', 'api', 'dist', 'cluster-cli.js'), command], {
    cwd: join(repoRoot, 'apps', 'api'),
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(paint('red', `[start] PostgreSQL ${command} failed: ${(result.stderr || result.stdout).trim()}`));
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
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  if (startedCluster) cluster('stop');
  setTimeout(() => process.exit(code), 300);
}

for (const [name, color, args, cwd] of [
  ['api', 'cyan', [apiEntry], join(repoRoot, 'apps', 'api')],
  // v30 S1-API: the ingest worker (the due queue of job sources, purges), which the API no longer runs.
  ['worker', 'yellow', [join(repoRoot, 'apps', 'api', 'dist', 'cli.js'), 'ingest:worker'], join(repoRoot, 'apps', 'api')],
  ['web', 'magenta', [join(repoRoot, 'scripts', 'next-launch.mjs'), 'start'], join(repoRoot, 'apps', 'web')],
]) {
  const child = runNode(name, color, args, { cwd });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(paint('red', `[start] ${name} exited (${signal ?? code}).`));
      stop(code ?? 1);
    }
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
