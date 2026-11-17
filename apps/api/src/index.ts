import { createApp, setupServices, startFeatures } from './app';
import { apiBindHost, isLoopbackHost, urlHost } from './config/addresses';
import { createRuntimeDeps } from './deps';

async function main(): Promise<void> {
  const deps = await createRuntimeDeps();
  const { config, log } = deps;
  await setupServices(deps);
  const app = createApp(deps);

  // API_HOST (127.0.0.1 by default: this computer only). The web reaches the API through its /api proxy, so the API can
  // stay on loopback while the web server listens on a network address.
  const host = apiBindHost(config.apiHost);
  if (!isLoopbackHost(host)) {
    log.warn(`[api] API_HOST=${config.apiHost}: the API can be reached from other computers on the network.`);
    if (config.auth.devFixedCode) {
      log.warn('[api] AUTH_DEV_FIXED_CODE is set, so anyone on the network can sign in as any address through the API.');
    }
  }
  const server = app.listen(config.apiPort, host, () => {
    log.info(`[api] listening on http://${urlHost(host)}:${config.apiPort} (data: ${config.dataDir})`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      log.error(`[api] port ${config.apiPort} is already in use. Stop the other process or change API_PORT in .env.`);
    } else if (error.code === 'EADDRNOTAVAIL' || error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
      log.error(
        `[api] API_HOST=${config.apiHost} is not an address of this computer. Change API_HOST in .env ` +
          '(127.0.0.1 keeps the API on this computer).',
      );
    } else {
      log.error('[api] server error', error);
    }
    process.exit(1);
  });

  // v30 S1-API: the feature workers (the ingest due queue) run in the ingest worker process (`ingest:worker`), never here.
  const stopFeatures = await startFeatures(deps, undefined, { workers: false });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`[api] ${signal}: shutting down`);
    await stopFeatures();
    server.close(() => {
      void deps.db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
