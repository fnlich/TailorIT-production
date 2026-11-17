// v30 E2: what one enrichment step answers its worker (E1's step registry, features/companies/enrich: claim, run each
// step of a company's `steps`, back off). `done` takes the step off the company's queue row (read, skipped or failed
// for good: a failure is recorded in the step's own company_sources row with its next read date); `retry` keeps it,
// due again at `retryAt` (a held host, a robots.txt that cannot be read now, a budget spent for the minute).

export interface EnrichmentStepInput {
  companyId: number;
  /** The worker's "now" (ISO). */
  at: string;
}

export type EnrichmentStepOutcome = { status: 'done'; note: string } | { status: 'retry'; retryAt: string; note: string };

export const stepDone = (note: string): EnrichmentStepOutcome => ({ status: 'done', note });
export const stepRetry = (retryAt: string, note: string): EnrichmentStepOutcome => ({ status: 'retry', retryAt, note });
