// v30 E1: the company enrichment queue's worker (docs/design/part2/13-company-enrichment.md §7).
//   registry.ts  a step (defineEnrichmentStep: name, handled queue names, enabled, run) and the registry's checks
//   steps.ts     the steps the worker runs (a registration file: one marked line per package)
//   queue.ts     company_enrichment_queue: claim under a lease, finish, drop
//   worker.ts    the passes, the backoff, the companies feature's worker hook (the ingest:worker process)
//   ats-board.ts the `ats_board` name: the company's board sources made due now
export { defineEnrichmentStep, enabledSteps, stepsByName, type EnrichmentOutcome, type EnrichmentStep, type EnrichmentWork } from './registry';
export { ENRICHMENT_STEPS } from './steps';
export { claimEnrichment, finishEnrichment, type ClaimedRow } from './queue';
export { backoffMs, enrichmentWorker, startEnrichmentQueue, workEnrichment, TICK_MS, type EnrichmentPass, type EnrichmentQueue } from './worker';
