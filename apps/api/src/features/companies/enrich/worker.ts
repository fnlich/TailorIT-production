import type { CompanyEnrichmentStep } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/index';
import { survivorOf } from '../aliases';
import { startCompanyCountDrain } from '../counts';
import { queueEnrichment } from '../resolve';
import { claimEnrichment, dropClaimed, finishEnrichment, type ClaimedRow } from './queue';
import { enabledSteps, stepsByName, type EnrichmentDeps, type EnrichmentStep } from './registry';
import { ENRICHMENT_STEPS } from './steps';

// v30 E1: the enrichment worker (docs/design/part2/13-company-enrichment.md §7; 12-job-sourcing.md §9.2): the
// companies feature's `worker` hook, so the `ingest:worker` process runs it beside ingest's due queue (never the API).
//
// Each pass: the steps that may run now (enabled), then up to COMPANY_ENRICH_BATCH due rows naming one of their
// names, claimed for COMPANY_ENRICH_LEASE_MINUTES (queue.ts); for each row, in turn: a company gone, merged (its names
// move to the company it was merged into), opted out or an account's own drops the row; else each step with names in
// the row runs once for them (registry.ts). Then the row is finished under its lease: the names done (and those given
// up) leave it, and it goes when none is left; a failure counts an attempt and the row is due again after
// COMPANY_ENRICH_BACKOFF_MINUTES x 2^(attempts - 1), at most COMPANY_ENRICH_BACKOFF_MAX_HOURS; after
// COMPANY_ENRICH_MAX_ATTEMPTS failures in a row the failing names are given up (logged). Names no step handles, or whose
// step is off, wait in the row untouched (a claim only takes rows with a name that may run).
//
// A pass runs every TICK_MS, and again at once when it took a full batch.

/** How often the worker looks for due rows. */
export const TICK_MS = 15_000;

export interface EnrichmentPass {
  claimed: number;
  done: number;
  failed: number;
  waited: number;
  dropped: number;
  lost: number;
}

/** The backoff after the n-th failure in a row (n >= 1), in ms. */
export function backoffMs(deps: EnrichmentDeps, attempts: number): number {
  const constants = constantsOf(deps);
  const base = constants.get('COMPANY_ENRICH_BACKOFF_MINUTES') * 60_000;
  const cap = constants.get('COMPANY_ENRICH_BACKOFF_MAX_HOURS') * 3_600_000;
  return Math.min(cap, base * 2 ** Math.max(0, Math.min(attempts - 1, 30)));
}

/** Drops a claimed row whose company may not be enriched (moving a merged company's names to its survivor). */
async function settleCompany(deps: EnrichmentDeps, row: ClaimedRow, at: string): Promise<boolean> {
  const company = await deps.db.one<{ owner_user_id: string | null; merged_into_id: number | null; do_not_fetch: boolean }>(
    'SELECT owner_user_id, merged_into_id, do_not_fetch FROM companies WHERE id = ?',
    [row.companyId],
  );
  if (company && company.owner_user_id === null && company.merged_into_id === null && !company.do_not_fetch) return false;
  await deps.db.tx(
    async (t) => {
      if (company?.merged_into_id) {
        const survivor = await survivorOf(t, row.companyId);
        if (survivor && survivor.id !== row.companyId) await queueEnrichment(t, survivor.id, at, row.steps);
      }
      await dropClaimed(t, row.companyId, row.lease);
    },
    { label: 'enrichment drop' },
  );
  return true;
}

/** One pass (see the module's note). `steps` defaults to the registry (steps.ts). */
export async function workEnrichment(
  deps: EnrichmentDeps,
  options: { steps?: readonly EnrichmentStep[]; signal?: AbortSignal } = {},
): Promise<EnrichmentPass> {
  const pass: EnrichmentPass = { claimed: 0, done: 0, failed: 0, waited: 0, dropped: 0, lost: 0 };
  const registry = options.steps ?? ENRICHMENT_STEPS;
  stepsByName(registry);
  const { steps, names } = await enabledSteps(deps, registry);
  if (names.length === 0) return pass;
  const constants = constantsOf(deps);
  const now = deps.now();
  const at = now.toISOString();
  const leaseUntil = new Date(now.getTime() + constants.get('COMPANY_ENRICH_LEASE_MINUTES') * 60_000).toISOString();
  const rows = await claimEnrichment(deps.db, { at, leaseUntil, names, limit: constants.get('COMPANY_ENRICH_BATCH') });
  pass.claimed = rows.length;
  const signal = options.signal ?? new AbortController().signal;
  const maxAttempts = constants.get('COMPANY_ENRICH_MAX_ATTEMPTS');

  for (const row of rows) {
    if (signal.aborted) break;
    if (await settleCompany(deps, row, at)) {
      pass.dropped += 1;
      continue;
    }
    const done: CompanyEnrichmentStep[] = [];
    const failures: Array<{ step: EnrichmentStep; names: CompanyEnrichmentStep[]; error: string }> = [];
    let waitUntil: string | null = null;
    for (const step of steps) {
      const mine = row.steps.filter((name) => step.handles.includes(name));
      if (mine.length === 0) continue;
      try {
        const outcome = await step.run(deps, { companyId: row.companyId, steps: mine, attempts: row.attempts, at, signal });
        if (outcome.kind === 'done') done.push(...mine);
        else {
          pass.waited += 1;
          if (!waitUntil || outcome.until > waitUntil) waitUntil = outcome.until;
          deps.log.info(`[enrich] company ${row.companyId}: ${step.name} waits until ${outcome.until} (${outcome.reason})`);
        }
      } catch (error) {
        failures.push({ step, names: mine, error: error instanceof Error ? error.message : String(error) });
      }
    }
    let failed: { error: string; retryAt: string } | null = null;
    const dropped: CompanyEnrichmentStep[] = [];
    if (failures.length > 0) {
      pass.failed += 1;
      const attempt = row.attempts + 1;
      const error = failures.map((failure) => `${failure.step.name}: ${failure.error}`).join('; ');
      if (attempt >= maxAttempts) {
        for (const failure of failures) dropped.push(...failure.names);
        deps.log.error(`[enrich] company ${row.companyId}: ${failures.map((f) => f.step.name).join(', ')} failed ${attempt} times; given up (${error})`);
      } else {
        deps.log.warn(`[enrich] company ${row.companyId}: attempt ${attempt} failed; tried again later (${error})`);
      }
      failed = { error, retryAt: new Date(now.getTime() + backoffMs(deps, attempt)).toISOString() };
    }
    if (done.length > 0) pass.done += 1;
    const finished = await finishEnrichment(deps.db, { companyId: row.companyId, lease: row.lease, at, done, dropped, failed, waitUntil });
    if (finished === 'lost') {
      pass.lost += 1;
      deps.log.warn(`[enrich] company ${row.companyId}: its lease ran out before the work ended; the row is left to its new holder`);
    }
  }
  return pass;
}

export interface EnrichmentQueue {
  /** One pass now (tests). */
  tick(): Promise<EnrichmentPass>;
  stop(): Promise<void>;
}

/** Starts the worker's passes in this process (see the module's note). */
export function startEnrichmentQueue(
  deps: EnrichmentDeps,
  options: { steps?: readonly EnrichmentStep[]; everyMs?: number } = {},
): EnrichmentQueue {
  const controller = new AbortController();
  const empty: EnrichmentPass = { claimed: 0, done: 0, failed: 0, waited: 0, dropped: 0, lost: 0 };
  let running: Promise<EnrichmentPass> | null = null;
  let stopped = false;

  const once = async (): Promise<EnrichmentPass> => {
    try {
      return await workEnrichment(deps, { steps: options.steps, signal: controller.signal });
    } catch (error) {
      if (!stopped) deps.log.error('[enrich] a pass failed; the next one tries again', error);
      return empty;
    }
  };

  const tick = (): Promise<EnrichmentPass> => {
    if (running) return running;
    running = once().finally(() => {
      running = null;
    });
    return running;
  };

  const loop = () => {
    if (stopped || running) return;
    void tick().then((pass) => {
      // A full batch: more rows are due now.
      if (!stopped && pass.claimed > 0 && pass.claimed >= constantsOf(deps).get('COMPANY_ENRICH_BATCH')) loop();
    });
  };

  const timer = setInterval(loop, options.everyMs ?? TICK_MS);
  timer.unref?.();
  loop();

  return {
    tick,
    async stop() {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      await running?.catch(() => undefined);
    },
  };
}

/**
 * The companies feature's worker hook (Feature.worker): the enrichment queue, in the ingest:worker process, and (v30
 * FIX-C UX-1) the drain that keeps company_job_counts current (counts.ts).
 */
export function enrichmentWorker(deps: EnrichmentDeps): () => Promise<void> {
  const queue = startEnrichmentQueue(deps);
  const counts = startCompanyCountDrain(deps);
  deps.log.info('[enrich] the company enrichment worker is running');
  return async () => {
    await queue.stop();
    await counts();
  };
}

