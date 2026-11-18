import { refdataStep } from '../refdata/step'; // v30 E1
import { E2_ENRICHMENT_STEPS } from '../site/index'; // v30 E2
import { summaryEnrichmentStep } from '../summaries/enrich-step'; // v30 E3
import { atsBoardStep } from './ats-board'; // v30 E1
import { defineEnrichmentStep, type EnrichmentStep } from './registry';

// v30 E1: the enrichment steps the worker runs (registry.ts explains a step). A registration file: each package
// appends its step with one marked import and one marked entry (`// v30 <id>`); each queue name (COMPANY_ENRICHMENT_STEPS)
// is handled by one step only (the worker refuses two). Wave 4 adds E2's company site and logo step (`company_site`,
// `logo_dev`) and E3's summary step (`ai`); a name without a step waits in the queue untouched.

/**
 * v30 E2 (registered by INT-4): the company's own website (`company_site`) and logo.dev for the logos it does not give
 * (`logo_dev`), one step each. E2's steps answer `done` (read, skipped, or failed for good: the failure is kept in E2's
 * own company_sources row with its next read) or `retry` at a time ("not now": a held host, robots.txt unreadable now,
 * the minute's budget, logo.dev's 202), which is the registry's `wait`: due again then, no attempt counted. A throw is
 * a failed attempt (backoff). While SITE_READER_COMPANY_SITES is off, LOGO_DEV_KEY empty or BOT_USER_AGENT a
 * placeholder, E2's steps answer done ("off") and read nothing; its daily refresh queues them again once they may run.
 */
const E2_STEPS: readonly EnrichmentStep[] = E2_ENRICHMENT_STEPS.map(({ step, run }) =>
  defineEnrichmentStep({
    name: step,
    handles: [step],
    readsOutside: () => true, // v31 RUNS: the company's website, logo.dev
    async run(deps, work) {
      const outcome = await run(deps, { companyId: work.companyId, at: work.at });
      return outcome.status === 'done' ? { kind: 'done' } : { kind: 'wait', until: outcome.retryAt, reason: outcome.note };
    },
  }),
);

export const ENRICHMENT_STEPS: readonly EnrichmentStep[] = [
  atsBoardStep, // v30 E1
  refdataStep, // v30 E1
  ...E2_STEPS, // v30 E2
  defineEnrichmentStep(summaryEnrichmentStep), // v30 E3: the queue's `ai` name (a look; the batches run in the API)
];
