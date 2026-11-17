import type { CompanyEnrichmentStep } from '@tailorit/shared';
import { summaryStep, type SummaryDeps } from './step';

// v30 E3: the summary's step for the enrichment queue's worker (E1's features/companies/enrich/: registry.ts
// defineEnrichmentStep, steps.ts ENRICHMENT_STEPS). It handles the queue's `ai` name: one look at the company (step.ts),
// which marks it pending when its summary is due; the batch runner writes the summaries COMPANY_AI_BATCH at a time, in
// the API process (runner.ts). So the step is always done: it never calls the AI, never reads an outside host, and its
// own transaction is short. Built to E1's shape without importing it (E1 builds the registry in the same wave); INT-4
// lists it in steps.ts (E3's handoff has the exact edit):
//
//   import { summaryEnrichmentStep } from '../summaries/enrich-step'; // v30 E3
//   ...
//   defineEnrichmentStep(summaryEnrichmentStep), // v30 E3

/** The worker's work for one company, as E1's registry gives it (EnrichmentWork). */
export interface SummaryEnrichmentWork {
  companyId: number;
  steps: readonly CompanyEnrichmentStep[];
  attempts: number;
  at: string;
  signal: AbortSignal;
}

/** What the step answers (E1's EnrichmentOutcome: always done; a throw is a failed attempt the worker retries). */
export type SummaryEnrichmentOutcome = { kind: 'done' };

export const summaryEnrichmentStep = {
  name: 'company_summary',
  handles: ['ai'] as const satisfies readonly CompanyEnrichmentStep[],
  async run(deps: SummaryDeps, work: SummaryEnrichmentWork): Promise<SummaryEnrichmentOutcome> {
    await summaryStep(deps, work.companyId);
    return { kind: 'done' };
  },
};
