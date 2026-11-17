// v3.0 PG-0: the embedded PostgreSQL's start and stop for the launchers (scripts/dev.mjs and start.mjs: the owner's
// cluster; scripts/test-servers.mjs: a test cluster). One small entry with no feature imports, so it starts fast.
//
//   cluster-cli start [--test] [--database <name> [--fresh]]   prints one JSON line: {"started":bool,"port",url?}
//                                                              (url, with its password: test clusters only)
//   cluster-cli stop  [--test] [--if-idle]                      --if-idle: only when no other session is open
//   cluster-cli status [--test]
//
// The owner's cluster: PG_DATA_DIR or <DATA_DIR>/pg, PG_PORT or 5442 (config/env.ts reads the root .env). --test: the
// test cluster of TEST_PG_PORT and TEST_PG_DATA_DIR (embedded.ts testClusterSettings).
import { getConfig } from '../../../config/env';
import {
  APP_DATABASE,
  appClusterSettings,
  ensureCluster,
  ensureDatabase,
  onAdmin,
  stopCluster,
  clusterRunning,
  testClusterSettings,
  urlOf,
  type ClusterSettings,
} from './embedded';

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const test = args.includes('--test');
  const cluster: ClusterSettings = test ? testClusterSettings() : appClusterSettings(getConfig().database);
  if (command === 'start') {
    const { started } = await ensureCluster(cluster);
    const database = option(args, '--database') ?? (test ? undefined : APP_DATABASE);
    if (database) await ensureDatabase(cluster, database, { fresh: args.includes('--fresh') });
    // The URL (with its password) only for a test cluster: the owner's password stays in its file.
    const url = test && database ? { url: urlOf(cluster, database) } : {};
    console.log(JSON.stringify({ started, port: cluster.port, ...url }));
    return;
  }
  if (command === 'stop') {
    if (args.includes('--if-idle') && (await clusterRunning(cluster))) {
      const others = await onAdmin(cluster, async (client) => {
        const found = await client.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
        );
        return (found.rows[0] as { n: number }).n;
      });
      if (others > 0) {
        console.log(JSON.stringify({ stopped: false, sessions: others }));
        return;
      }
    }
    await stopCluster(cluster);
    console.log(JSON.stringify({ stopped: true }));
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify({ running: await clusterRunning(cluster), port: cluster.port, dataDir: cluster.dataDir }));
    return;
  }
  console.error('Usage: cluster-cli start|stop|status [--test] [--database <name> [--fresh]] [--if-idle]');
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
