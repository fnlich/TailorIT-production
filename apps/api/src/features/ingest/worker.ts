import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { Feature } from '../../core/feature';
import { startWorkers } from '../../core/feature-hooks';
import { workPurges } from './purge';
import { DUE_TICK_MS, dueSources, postponeHeldSources, refreshRobotsStatuses } from './scheduler';
import { requireIngest, WORKER_TRIGGERS, type IngestService } from './service';
import { acquireWorkerLock, WorkerLockedError, type WorkerLockOptions } from './worker-lock';

// v30 S1-API: the ingest worker (12-job-sourcing.md §9.2): a process of its own, `tsx src/cli.ts ingest:worker`
// (`node dist/cli.js ingest:worker` once built), which `npm run dev` and `npm start` start beside the API. The API
// starts its features with `{ workers: false }` (src/index.ts), so only this process runs Feature.worker hooks: the
// ingest feature's is startDueQueue below. Same code and database as the API; pacing per host, holds and robots.txt are
// shared through the database (crawl_hosts, site_robots), so the two processes keep one pace per host.
//
// Each tick (DUE_TICK_MS, and at once when a run ends):
//   - recover the runs whose lease ran out (a crashed process's), never one this worker runs;
//   - move the sources of held hosts past the hold (scheduler.ts postponeHeldSources);
//   - give robots.txt verdicts to the sources that need one (refreshRobotsStatuses: a host read at most once a day);
//   - start the due sources: at most INGEST_HOSTS_IN_FLIGHT hosts at once, one source per host at a time;
//   - every PURGE_EVERY_MS, work the open purges (purge.ts workPurges) for a while.
// With INGEST_ENABLED=false no source is read (the purges, which read no outside host, still run).
// v30 FIX-A (REV-BEH BEH-4): one worker at a time: `ingest:worker` takes the worker lock first (worker-lock.ts); a
// second one names the running worker and exits (code 1), so it never recovers the first one's live runs.

/** How often the worker works the open purges. */
export const PURGE_EVERY_MS = 60_000;

export interface DueQueue {
  /** One tick now (tests; a run's end). Answers the runs it started. */
  tick(): Promise<number>;
  stop(): Promise<void>;
}

/** Starts the due queue in this process (see the top). */
export function startDueQueue(
  deps: AppDeps,
  service: IngestService = requireIngest(deps),
  options: { everyMs?: number; purgeEveryMs?: number } = {},
): DueQueue {
  const enabled = deps.config.ingest.enabled;
  const controller = new AbortController();
  /** Hosts (or `source:<id>` for a source with no host) with a run going here. */
  const inFlight = new Map<number, string>();
  let ticking: Promise<number> | null = null;
  let again = false;
  let lastPurge = 0;
  let stopped = false;

  if (!enabled) deps.log.info('[ingest] the ingest worker reads no source (INGEST_ENABLED=false); run sources from Admin > Sources.');

  async function once(): Promise<number> {
    let started = 0;
    try {
      await service.recoverInterrupted({ triggers: [] });
      if (Date.now() - lastPurge >= (options.purgeEveryMs ?? PURGE_EVERY_MS)) {
        lastPurge = Date.now();
        await workPurges(deps, { signal: controller.signal });
      }
      if (!enabled || stopped) return 0;
      await postponeHeldSources(deps);
      // v30 INT-4: the new kinds' hosts are read with BOT_USER_AGENT (S3's edit B, S5's edit D).
      await refreshRobotsStatuses(deps, service.http, { signal: controller.signal, newKindsHttp: service.botHttp });
      const room = constantsOf(deps).get('INGEST_HOSTS_IN_FLIGHT') - inFlight.size;
      if (room <= 0) return 0;
      const busy = new Set(inFlight.values());
      for (const source of await dueSources(deps)) {
        if (stopped || started >= room) break;
        const lane = source.host ?? `source:${source.id}`;
        if (busy.has(lane) || service.isRunning(source.id)) continue;
        try {
          const run = await service.run(source.id, 'schedule', { bypassSlots: true });
          busy.add(lane);
          inFlight.set(source.id, lane);
          started += 1;
          void run.done.finally(() => {
            inFlight.delete(source.id);
            if (!stopped) kick();
          });
        } catch (error) {
          // Leased by another process meanwhile, or no longer runnable: the next look decides again.
          deps.log.info(`[ingest] the worker did not start source ${source.id}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      if (!stopped) deps.log.error('[ingest] the due queue failed a look; it looks again at the next tick', error);
    }
    return started;
  }

  function kick(): void {
    if (ticking) {
      again = true;
      return;
    }
    void tick();
  }

  function tick(): Promise<number> {
    if (ticking) {
      again = true;
      return ticking;
    }
    ticking = once().finally(() => {
      ticking = null;
      if (again && !stopped) {
        again = false;
        kick();
      }
    });
    return ticking;
  }

  const timer = setInterval(kick, options.everyMs ?? DUE_TICK_MS);
  timer.unref?.();
  kick();

  return {
    tick,
    async stop() {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      await ticking?.catch(() => undefined);
    },
  };
}

/**
 * The ingest feature's worker hook: the runs a stopped worker left are failed first, then the due queue starts. The
 * recovery of every `schedule` run at the start is safe because only one worker runs at a time (runIngestWorker takes
 * the worker lock first: worker-lock.ts), so a schedule run still marked running belongs to a worker that stopped.
 */
export function ingestWorker(deps: AppDeps): () => Promise<void> {
  const service = requireIngest(deps);
  let queue: DueQueue | null = null;
  const starting = service
    .recoverInterrupted({ triggers: WORKER_TRIGGERS })
    .catch((error: unknown) => {
      deps.log.error('[ingest] the worker could not recover interrupted runs', error);
      return 0;
    })
    .then(() => {
      queue = startDueQueue(deps, service);
    });
  return async () => {
    await starting;
    await queue?.stop();
    await service.stop();
  };
}

/**
 * `ingest:worker`: this process runs every feature's worker hook (Feature.worker) until SIGINT or SIGTERM, with the
 * constants' reload; it serves no route. The API (src/index.ts) runs none of them.
 */
export async function runIngestWorker(
  deps: AppDeps,
  features: readonly Feature[],
  options: { lock?: WorkerLockOptions; signals?: Pick<NodeJS.Process, 'once'> } = {},
): Promise<void> {
  // v30 FIX-A (BEH-4): one worker at a time. A second one says which worker runs and stops (exit code 1).
  let stopFor: ((why: string) => void) | null = null;
  let lock;
  try {
    lock = await acquireWorkerLock(deps, { ...options.lock, onLost: () => stopFor?.('the worker lock was lost') });
  } catch (error) {
    if (!(error instanceof WorkerLockedError)) throw error;
    deps.log.error(`[worker] ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const stopConstants = constantsOf(deps).start();
  const stopWorkers = startWorkers(deps, [...features]);
  deps.log.info('[worker] the ingest worker is running (Ctrl+C stops it).');
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      deps.log.info(`[worker] ${signal}: stopping`);
      void (async () => {
        try {
          await stopWorkers();
        } finally {
          stopConstants();
          await lock.release();
          resolve();
        }
      })();
    };
    stopFor = stop;
    const signals = options.signals ?? process;
    signals.once('SIGINT', () => stop('SIGINT'));
    signals.once('SIGTERM', () => stop('SIGTERM'));
  });
}
