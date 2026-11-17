// v30 D5L: the backups' commands (scripts/db-backup.mjs runs this file; DEPLOY.md says when to use which).
//
//   export --to <folder>                     a logical export of the app's database (the server may keep running)
//   check --from <folder>                    re-read an export against its manifest
//   restore --from <folder> --database <db>  load an export into a NEW database of the same server
//   use --database <db>                      make <db> the app's database (the old one kept as tailorit_before_<stamp>)
//   cold --to <folder> [--stop]              copy the embedded cluster's data folder (the server stopped; --stop stops
//                                            an idle one first and starts it again after)
//   cold-restore --from <folder> [--replace] put a cold copy back (the server stopped)
//
// Each backup also copies DATA_DIR's `files` (the uploads) and `keys` (the saved sign-ins' key) into <folder>/data/,
// unless --database-only; cold-restore puts them back, after a logical restore they are copied back by hand.
//
// The database: DATABASE_URL when set (export, check and restore only: a hosted server's backups are pg_dump's and its
// provider's), else the owner's embedded cluster (PG_DATA_DIR or <DATA_DIR>/pg, PG_PORT), started for the command
// when it is not running and stopped again after. Passwords are never printed.
import { join, resolve } from 'node:path';
import { getConfig } from '../../../../config/env';
import type { PgConnection } from '../client';
import {
  APP_DATABASE,
  appClusterSettings,
  clusterRunning,
  connectionOf,
  ensureCluster,
  onAdmin,
  startCluster,
  stopCluster,
} from '../embedded';
import { checkExport, coldCopy, coldRestore, connect, exportDatabase, restoreDatabase, useDatabase, type DataFolder } from './backup';

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  const value = at >= 0 ? args[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} <value> is required.`);
  return value;
}

/** A folder argument, from the folder the command was typed in (scripts/db-backup.mjs runs this in apps/api). */
function folderArg(args: string[], name: string): string {
  return resolve(process.env.TAILORIT_BACKUP_CWD || process.cwd(), required(args, name));
}

/** The owner's cluster folder and its password file (embedded.ts's rule: `<PG_DATA_DIR>.password`). */
function clusterFolder(): { dataDir: string; passwordFile: string } {
  const dataDir = getConfig().database.pgDataDir;
  return { dataDir, passwordFile: `${dataDir.replace(/[\\/]+$/, '')}.password` };
}

/** The app's data folders a backup copies beside the database (none with --database-only). */
function dataFolders(args: string[]): DataFolder[] {
  if (args.includes('--database-only')) return [];
  const dataDir = getConfig().dataDir;
  return ['files', 'keys'].map((name) => ({ name, path: join(dataDir, name) }));
}

interface Server {
  appDatabase: string;
  hosted: boolean;
  connectionTo(database: string): PgConnection;
  /** Stops the embedded cluster when this command started it. */
  done(): Promise<void>;
}

async function openServer(): Promise<Server> {
  const url = getConfig().database.url;
  if (url) {
    const appDatabase = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || 'postgres';
    return {
      appDatabase,
      hosted: true,
      connectionTo(database) {
        const at = new URL(url);
        at.pathname = `/${encodeURIComponent(database)}`;
        return { connectionString: at.toString() };
      },
      done: async () => undefined,
    };
  }
  const cluster = appClusterSettings(getConfig().database);
  const { started } = await ensureCluster(cluster);
  if (started) console.log(`Started the embedded PostgreSQL in ${cluster.dataDir} for this command.`);
  return {
    appDatabase: APP_DATABASE,
    hosted: false,
    connectionTo: (database) => connectionOf(cluster, database),
    done: async () => {
      if (started) await stopCluster(cluster);
    },
  };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'export' || command === 'restore' || command === 'use') {
    const server = await openServer();
    try {
      if (command === 'export') {
        const to = folderArg(args, '--to');
        const client = await connect(server.connectionTo(server.appDatabase));
        try {
          const manifest = await exportDatabase(client, to, { log: (line) => console.log(line), data: dataFolders(args) });
          const rows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);
          console.log(`Exported ${manifest.tables.length} tables (${rows} rows) of ${manifest.database} to ${to}.`);
        } finally {
          await client.end();
        }
      } else if (command === 'restore') {
        const from = folderArg(args, '--from');
        const database = required(args, '--database');
        const report = await restoreDatabase({ from, database, connectionTo: server.connectionTo, log: (line) => console.log(line) });
        console.log(`Restored ${report.tables} tables (${report.rows} rows) into the new database ${report.database}.`);
        if (report.data.length) {
          console.log(`The export also holds ${report.data.join(', ')} (in ${join(from, 'data')}): copy them into DATA_DIR with TailorIT stopped.`);
        }
        // v30 FIX-PG (PGL-20): E1's refdata is not in a logical export (or is left out of an older one).
        console.log('The refdata of company enrichment is not in a logical export: run npm run refdata:build to make it again.');
        console.log(`To make it the app's database, stop TailorIT and run: node scripts/db-backup.mjs use --database ${report.database}`);
      } else {
        if (server.hosted) throw new Error('With DATABASE_URL, rename the databases on your server (DEPLOY.md).');
        const database = required(args, '--database');
        const admin = await connect(server.connectionTo('postgres'));
        try {
          const before = await useDatabase(admin, server.appDatabase, database);
          console.log(`${database} is now the app's database${before ? `; the previous one is kept as ${before}` : ''}.`);
        } finally {
          await admin.end();
        }
      }
    } finally {
      await server.done();
    }
    return;
  }
  if (command === 'check') {
    const from = folderArg(args, '--from');
    const problems = await checkExport(from);
    for (const problem of problems) console.log(`Problem: ${problem}`);
    console.log(problems.length ? `${from} does not match its manifest.` : `${from} matches its manifest.`);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (command === 'cold' || command === 'cold-restore') {
    if (getConfig().database.url) {
      throw new Error("DATABASE_URL is set: a cold copy is the embedded cluster's. Use pg_dump or your provider's backups (DEPLOY.md).");
    }
    const { dataDir, passwordFile } = clusterFolder();
    const running = () => clusterRunning({ dataDir });
    if (command === 'cold') {
      const to = folderArg(args, '--to');
      let restart = false;
      if (args.includes('--stop') && (await running())) {
        const cluster = appClusterSettings(getConfig().database);
        const sessions = await onAdmin(cluster, async (client) => {
          const found = await client.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
          );
          return (found.rows[0] as { n: number }).n;
        });
        if (sessions > 0) throw new Error(`PostgreSQL has ${sessions} session(s) open: stop TailorIT first.`);
        await stopCluster(cluster);
        restart = true;
      }
      try {
        const manifest = await coldCopy({ dataDir, passwordFile, to, running, data: dataFolders(args) });
        console.log(`Copied ${manifest.files} files (${manifest.bytes} bytes, PostgreSQL ${manifest.pgVersion}) to ${to}.`);
      } finally {
        if (restart) await startCluster(appClusterSettings(getConfig().database));
      }
    } else {
      const from = folderArg(args, '--from');
      const replace = args.includes('--replace');
      const { movedAside } = await coldRestore({ from, dataDir, passwordFile, running, replace, data: dataFolders(args) });
      console.log(`Restored the cold copy into ${dataDir}${movedAside ? `; the cluster that was there is now ${movedAside}` : ''}.`);
    }
    return;
  }
  console.error(
    'Usage: db-backup export --to <folder> [--database-only] | check --from <folder> | ' +
      'restore --from <folder> --database <db> | use --database <db> | ' +
      'cold --to <folder> [--stop] [--database-only] | cold-restore --from <folder> [--replace] [--database-only]',
  );
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
