import { constantsOf } from '../../../core/constants/index'; // v31 RUNS
import type { AppDeps } from '../../../core/context';
import type { Feature } from '../../../core/feature';
import { newReadsAllowed } from '../../../core/http/identity';
import { pauseAwareSignal, runsPaused } from '../pause-state'; // v31 RUNS
import { commonCrawlPass } from './common-crawl';
import { sweepLinks } from './links';
import { measureBoards } from './measures';
import { probePass } from './probes';
import { DISCOVERY_ACTING } from './acting'; // v33 SHARE-6
import { createCandidatesRouter } from './router';
import { pruneCounters } from './state';
import { validateCandidates, validationAllowed } from './validate';

// v30 S2: discovery, finding job boards at scale (docs/design/part2/12-job-sourcing.md §4, §11 phase 2). A feature of
// its own beside ingest (registered after it in features/index.ts), its module map:
// - boards.ts       the board kinds, their names and configs; boardOfUrl (the board an address names)
// - offer.ts        offerToDiscovery (the seam every signal and X1-API's approvals call): a candidate, never a person
// - links.ts        signals 2 and 5: applications' and page jobs' links, cross-links (daily, by high-water marks)
// - common-crawl.ts signal 3: Common Crawl's URL index (monthly; a NEW outside read behind the identity guard)
// - probes.ts       signal 6: name probes, built and OFF (DISCOVERY_PROBES_PER_HOST_PER_DAY = 0)
// - validate.ts     validation under DISCOVERY_VALIDATIONS_PER_DAY (a NEW outside read): the outcomes, the tiers
// - measures.ts     each board's open life and postings (daily), and the summary by kind
// - admin.ts, router.ts  Admin › Candidates (/api/admin/candidates): the list and funnel, retry/drop, add, measures
// - state.ts        the signals' progress and the caps' per-day counts (migration 0020)
// Signals 1 (Add job) and 4 (company websites' Careers links) are other features' calls: X1-API's approvals call
// offerToDiscovery; a homepage reader calls links.ts offerLink.
//
// The worker process (`ingest:worker`) runs the outside reads, each pass on its own so one failing never stops the
// others: validation, then Common Crawl, then probes, every DISCOVERY_TICK_MS while INGEST_ENABLED and only once
// BOT_USER_AGENT is set (the guard refuses before anything is sent; the passes are not even tried while it is a
// placeholder). v30 FIX-A (DECISIONS P6.1): validation of the v2.0 kinds' boards runs before that, with today's
// identity, while DISCOVERY_VALIDATE_V2_KINDS_TODAY is on. The API process's daily housekeeping runs the link sweep, the
// measures and the counters' pruning (no outside read).
// v31 RUNS: none of these passes runs while an admin paused every run (pause-state.ts), and a pass going on stops at
// its next candidate within RUN_STOP_POLL_MS of the pause.

/** How often the worker runs discovery's passes. */
export const DISCOVERY_TICK_MS = 60_000;

/** The worker hook: discovery's outside reads, every DISCOVERY_TICK_MS (see the top). */
export function discoveryWorker(deps: AppDeps, options: { everyMs?: number } = {}): () => Promise<void> {
  const controller = new AbortController();
  let running: Promise<void> | null = null;
  const tick = async () => {
    if (!deps.config.ingest.enabled || !validationAllowed(deps) || controller.signal.aborted) return;
    if (await runsPaused(deps)) return; // v31 RUNS
    // v31 RUNS: the passes' signal also aborts once an admin pauses every run.
    const pass = pauseAwareSignal(deps, controller.signal, constantsOf(deps).get('RUN_STOP_POLL_MS'));
    const signal = pass.signal;
    const passes: Array<[string, () => Promise<unknown>]> = [['validation', () => validateCandidates(deps, { signal })]];
    // Common Crawl and the name probes are new reads only (no v2.0 read is like them).
    if (newReadsAllowed(deps)) {
      passes.push(['Common Crawl', () => commonCrawlPass(deps, { signal })], ['name probes', () => probePass(deps)]);
    }
    try {
      for (const [name, run] of passes) {
        if (signal.aborted) return;
        try {
          await run();
        } catch (error) {
          if (!signal.aborted) deps.log.error(`[discovery] the ${name} pass failed; it runs again at the next tick`, error);
        }
      }
    } finally {
      pass.done();
    }
  };
  const kick = () => {
    if (running) return;
    running = tick().finally(() => {
      running = null;
    });
  };
  const timer = setInterval(kick, options.everyMs ?? DISCOVERY_TICK_MS);
  timer.unref?.();
  kick();
  return async () => {
    controller.abort();
    clearInterval(timer);
    await running?.catch(() => undefined);
  };
}

export const discoveryFeature: Feature = {
  name: 'discovery',
  routes: [{ path: '/api/admin/candidates', router: createCandidatesRouter, acting: DISCOVERY_ACTING /* v33 SHARE-6 */ }],
  worker: discoveryWorker,
  daily: [
    { name: 'links', run: async (deps) => (await sweepLinks(deps)).added },
    { name: 'measures', run: (deps) => measureBoards(deps) },
    { name: 'counters', run: (deps) => pruneCounters(deps) },
  ],
};
