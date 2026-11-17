import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { AppDeps } from '../../core/context';
import { sleepFor } from './http';

// v30 FIX-A (REV-BEH BEH-4; 12-job-sourcing.md §9.2 "one worker"): the one ingest worker's lock. A second
// `ingest:worker` (a second terminal, a second `npm run dev`) would recover the first one's live runs at its start and
// run their sources again beside them, so it does not start: it finds the lock held and exits with a plain message.
//
// The lock is the one row of ingest_worker_lock (migrations-pg/0030): its owner (a random id per process), the
// machine's name and process id, and a lease the worker renews every WORKER_LOCK_RENEW_MS. A worker that stops gives it
// back; one that crashed leaves it to run out (WORKER_LOCK_MS), or, on the same machine, a new worker takes it over at
// once when the holder's process is gone (a restart under `tsx watch`, a killed terminal). A new worker on the same
// machine waits up to WORKER_LOCK_WAIT_MS for a holder that is stopping.
//
// (A PostgreSQL session advisory lock would need a connection held for the worker's life, which the data layer does not
// hand to features: core/db alone drives the driver. The lease row works through deps.db.)

/** How long the lock holds without a renewal. */
export const WORKER_LOCK_MS = 90_000;
/** How often the holder renews it. */
export const WORKER_LOCK_RENEW_MS = 20_000;
/** How long a new worker on the same machine waits for a holder that is stopping (a restart). */
export const WORKER_LOCK_WAIT_MS = 15_000;
/** The gap between two looks while it waits. */
const WORKER_LOCK_POLL_MS = 500;

/** The worker that holds the lock: where it runs, and until when its lease holds. */
export interface WorkerLockHolder {
  hostName: string;
  pid: number;
  startedAt: string;
  until: string;
}

/** Another ingest worker holds the lock: this one does not start. */
export class WorkerLockedError extends Error {
  readonly holder: WorkerLockHolder;
  constructor(holder: WorkerLockHolder) {
    super(
      `Another ingest worker is running (process ${holder.pid} on ${holder.hostName}, started ${holder.startedAt}): this one stops, ` +
        `so the two never read the same sources at once. Stop the other one first (Ctrl+C in its terminal); a worker that ` +
        `crashed gives its place up by ${holder.until}.`,
    );
    this.name = 'WorkerLockedError';
    this.holder = holder;
  }
}

export interface WorkerLock {
  /** Gives the lock back (the worker stops). */
  release(): Promise<void>;
}

export interface WorkerLockOptions {
  hostName?: string;
  pid?: number;
  /** Whether a process of this machine is alive (default: a signal-0 probe). */
  isAlive?: (pid: number) => boolean;
  /** How long to wait for a holder on this machine that is stopping (default WORKER_LOCK_WAIT_MS). */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Told when a renewal finds the lock taken (the lease ran out meanwhile): the worker should stop. */
  onLost?: () => void;
}

/** Whether a process of this machine is alive: signal 0 sends nothing and fails with ESRCH when there is none. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const CLAIM_SQL = `INSERT INTO ingest_worker_lock(id, owner, host_name, pid, started_at, lease_until)
  VALUES (1, CAST(@owner AS uuid), @hostName, @pid, CAST(@now AS timestamptz), CAST(@until AS timestamptz))
  ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, host_name = excluded.host_name, pid = excluded.pid,
    started_at = excluded.started_at, lease_until = excluded.lease_until
  WHERE ingest_worker_lock.lease_until < CAST(@now AS timestamptz) OR ingest_worker_lock.owner = CAST(@stale AS uuid)
  RETURNING owner`;

/**
 * Takes the ingest worker's lock, or throws WorkerLockedError naming the worker that holds it (see the top). The lock
 * is renewed until `release`.
 */
export async function acquireWorkerLock(deps: Pick<AppDeps, 'db' | 'now' | 'log'>, options: WorkerLockOptions = {}): Promise<WorkerLock> {
  const db = deps.db;
  const owner = randomUUID();
  const hostName = (options.hostName ?? hostname()).slice(0, 255);
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const waitMs = options.waitMs ?? WORKER_LOCK_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms));
  const at = () => deps.now().getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const started = at();
  const claim = async (stale: string | null) =>
    Boolean(await db.one(CLAIM_SQL, { owner, hostName, pid, now: iso(at()), until: iso(at() + WORKER_LOCK_MS), stale }));

  for (let waited = 0; ; waited += WORKER_LOCK_POLL_MS) {
    if (await claim(null)) break;
    const row = await db.one<{ owner: string; host_name: string; pid: number; started_at: string; lease_until: string }>(
      'SELECT owner, host_name, pid, started_at, lease_until FROM ingest_worker_lock WHERE id = 1',
    );
    if (!row) continue;
    // A holder on this machine whose process is gone (a crash, a restart): its place is free now.
    if (row.host_name === hostName && row.pid !== pid && !isAlive(row.pid) && (await claim(row.owner))) break;
    if (row.host_name !== hostName || waited >= waitMs || at() - started >= waitMs) {
      throw new WorkerLockedError({ hostName: row.host_name, pid: row.pid, startedAt: row.started_at, until: row.lease_until });
    }
    await sleep(WORKER_LOCK_POLL_MS);
  }

  const timer = setInterval(() => {
    db.run('UPDATE ingest_worker_lock SET lease_until = CAST(? AS timestamptz) WHERE id = 1 AND owner = CAST(? AS uuid)', [iso(at() + WORKER_LOCK_MS), owner])
      .then((result) => {
        if (result.changes > 0) return;
        clearInterval(timer);
        deps.log.error('[worker] another ingest worker took the lock (this one could not renew it in time): this one stops.');
        options.onLost?.();
      })
      .catch((error: unknown) => deps.log.warn('[worker] could not renew the ingest worker lock', error));
  }, WORKER_LOCK_RENEW_MS);
  timer.unref?.();
  return {
    async release() {
      clearInterval(timer);
      try {
        await db.run('DELETE FROM ingest_worker_lock WHERE id = 1 AND owner = CAST(? AS uuid)', [owner]);
      } catch {
        /* the database is closing: the lease runs out */
      }
    },
  };
}
