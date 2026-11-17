#!/usr/bin/env node
// v30 D5L: the database's backups (DEPLOY.md), with the root `.env` loaded.
//
//   node scripts/db-backup.mjs export --to <folder>                     a logical export (the server may run)
//   node scripts/db-backup.mjs check --from <folder>                    re-read an export against its manifest
//   node scripts/db-backup.mjs restore --from <folder> --database <db>  load an export into a new database
//   node scripts/db-backup.mjs use --database <db>                      make <db> the app's database (TailorIT stopped)
//   node scripts/db-backup.mjs cold --to <folder> [--stop]              copy the stopped embedded cluster's folder
//   node scripts/db-backup.mjs cold-restore --from <folder> [--replace] put a cold copy back (TailorIT stopped)
//
// It runs apps/api/src/core/db/pg/maintenance/backup-cli.ts with tsx (a dev dependency, there after `npm ci`), or the
// built apps/api/dist/backup-cli.js when tsx is missing.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadRootEnv, repoRoot } from './env.mjs';

loadRootEnv();
const require = createRequire(join(repoRoot, 'package.json'));
const apiRoot = join(repoRoot, 'apps', 'api');
let entry;
try {
  entry = [require.resolve('tsx/cli'), join('src', 'core', 'db', 'pg', 'maintenance', 'backup-cli.ts')];
} catch {
  const built = join(apiRoot, 'dist', 'backup-cli.js');
  if (!existsSync(built)) {
    console.error('Neither tsx (npm ci) nor apps/api/dist/backup-cli.js (npm run build) is there to run the backup.');
    process.exit(1);
  }
  entry = [built];
}
const child = spawn(process.execPath, [...entry, ...process.argv.slice(2)], {
  cwd: apiRoot,
  // Folder arguments are read from the folder the command was typed in.
  env: { ...process.env, TAILORIT_BACKUP_CWD: process.cwd() },
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
