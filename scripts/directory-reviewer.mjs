#!/usr/bin/env node
// v34 DIRKIT (PLAN G8): `npm run directory:reviewer -- --email <address>` makes or refreshes the account a reviewer of
// Claude's Connectors Directory signs in with, on the server it runs on (apps/api/src/features/directory/reviewer.ts:
// Paid, TailorIT's AI on, the prepare filters on, a made-up person's sample resume, saved jobs from the job lake, a few
// Tracker entries). Run it on the production server, in TailorIT's folder, as the user that runs TailorIT (its .env).
//
// Before anything runs, it checks that this machine has TailorIT's database (DATABASE_URL, or the embedded cluster in
// PG_DATA_DIR or <DATA_DIR>/pg): an API command would otherwise make a new, empty embedded database (a wrong folder or
// user), and the account would land there. Then the command runs with the API's log at warn, so it prints the account's
// address and nothing else; a refusal goes to stderr (exit 1). Runs with tsx's loader (`node --import tsx`, as the npm
// script does): it reads the API's own settings (config/env.ts) to find the database. A relative DATA_DIR or
// PG_DATA_DIR is read from apps/api, as the API reads it (it runs there, as `npm start` and `npm run dev` start it), and
// the command gets the same absolute folders: the folder checked is the folder opened.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildConfig } from '../apps/api/src/config/env.ts';
import { clusterInitialised } from '../apps/api/src/core/db/pg/embedded.ts';
import { loadRootEnv, repoRoot } from './env.mjs';

/** The API's folder: its working directory, which a relative DATA_DIR or PG_DATA_DIR is read from. */
export const API_DIR = join(repoRoot, 'apps', 'api');

/** `env` with a relative DATA_DIR and PG_DATA_DIR made absolute as the API reads them (from apps/api). */
export function apiEnvOf(env) {
  const out = { ...env };
  for (const key of ['DATA_DIR', 'PG_DATA_DIR']) {
    const value = env[key]?.trim();
    if (value && !isAbsolute(value)) out[key] = resolve(API_DIR, value);
  }
  return out;
}

/** Why there is no database to run against here (a sentence), or null. `env` is the API's environment (apiEnvOf). */
export function databaseProblem(env) {
  let config;
  try {
    config = buildConfig(env);
  } catch (error) {
    return `TailorIT's settings do not read here: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (config.database.url) return null;
  if (clusterInitialised(config.database.pgDataDir)) return null;
  return (
    `There is no TailorIT database here: DATABASE_URL is not set and ${config.database.pgDataDir} holds no embedded database. ` +
    "Run this on the server TailorIT runs on, in TailorIT's folder, as the user that runs it."
  );
}

/** Runs the command; resolves with its exit code. */
export async function main(argv, env = process.env) {
  const apiEnv = apiEnvOf(env);
  const problem = databaseProblem(apiEnv);
  if (problem) {
    console.error(problem);
    return 1;
  }
  const require = createRequire(join(repoRoot, 'package.json'));
  const child = spawn(process.execPath, [require.resolve('tsx/cli'), 'src/cli.ts', 'directory:reviewer', ...argv], {
    cwd: API_DIR,
    env: { ...apiEnv, LOG_LEVEL: 'warn' },
    stdio: 'inherit',
    windowsHide: true,
  });
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadRootEnv();
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
