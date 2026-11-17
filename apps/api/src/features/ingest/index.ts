import { constantsOf } from '../../core/constants/index';
import type { Feature } from '../../core/feature';
import { createHostsRouter } from './hosts';
import { createPurgesRouter, purgesDailyStep, rawKeepDailyStep } from './purge';
import { createImportRouter, createRunsRouter, createSourcesRouter, createSourcingReportRouter } from './router';
import { API_TRIGGERS, createIngestService, requireIngest } from './service';
import { createGoogleSheetsClient } from './sheets/client';
import { unverifiedDailyStep } from './unverified';
import { ingestWorker, runIngestWorker } from './worker';
import { careerSitesStep } from './career/discover'; // v30 S5
import { runHistoryDailyStep } from './run-history'; // v30 FIX-A

// Job ingestion: sources, runs, CSV/JSON import, the one-time Google Sheet import, reports. Work package J1
// (docs/ARCHITECTURE.md §8); the Sheet import is WP12. v30 ST4: the demo seed is behind the dev-only seam (dev-only/index.ts).
//
// v30 S1-API (12-job-sourcing.md §9): the schedule moved to the ingest worker (worker.ts: the due queue, the purges),
// a process of its own (`ingest:worker`) that runs this feature's `worker` hook; the API keeps the runs a person
// starts and Add job's reads. Admin › Hosts, Purges and the sourcing report join Sources, Runs, Import and Reports; the
// daily housekeeping sweeps unverified jobs and works purges a stopped worker left.
export const ingestFeature: Feature = {
  name: 'ingest',
  services(deps) {
    deps.services.ingest = createIngestService(deps);
    // Reads the service account key only when an admin uses the Sheet import (nothing at startup).
    deps.services.sheets = createGoogleSheetsClient({
      keyFile: deps.config.ingest.googleServiceAccountKeyFile,
      userAgent: deps.config.ingest.userAgent,
      log: deps.log,
      message: (key, params) => constantsOf(deps).message(key, params),
    });
  },
  routes: [
    { path: '/api/admin/sources', router: createSourcesRouter },
    { path: '/api/admin/runs', router: createRunsRouter },
    { path: '/api/admin/import', router: createImportRouter },
    // v30 S1-API
    { path: '/api/admin/hosts', router: createHostsRouter },
    { path: '/api/admin/purges', router: createPurgesRouter },
    { path: '/api/admin/sourcing', router: createSourcingReportRouter },
  ],
  async start(deps) {
    const service = requireIngest(deps);
    // The API's own runs a stopped API left (Run now, uploads, the seed at start), and any whose lease ran out.
    await service.recoverInterrupted({ triggers: API_TRIGGERS });
    return async () => {
      await service.stop();
    };
  },
  // v30 S1-API: the due queue and the purges, in the worker process.
  worker: ingestWorker,
  // v30 S5: ingest.career_sites (off with its switch); v30 FIX-A: ingest.run_history (runs past JOB_SOURCE_RUN_KEEP_DAYS).
  daily: [unverifiedDailyStep, purgesDailyStep, rawKeepDailyStep, careerSitesStep, runHistoryDailyStep],
  commands: {
    // v30 S1-API: the worker process (`npm run dev` and `npm start` start it beside the API).
    'ingest:worker': async (deps) => {
      // The features' list, read when the command runs (features/index imports this file).
      const { FEATURES } = await import('../index');
      await runIngestWorker(deps, FEATURES);
    },
  },
};
