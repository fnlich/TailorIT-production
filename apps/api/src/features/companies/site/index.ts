import type { AppDeps } from '../../../core/context';
import type { CompanyEnrichmentStep } from '@tailorit/shared';
import { runLogoDevStep } from '../logos/logo-dev';
import type { EnrichmentStepInput, EnrichmentStepOutcome } from './outcome';
import { runCompanySiteStep } from './step';

// v30 E2: company websites (docs/design/part2/13-company-enrichment.md §3.3, §4, §11 phase 2), off behind
// SITE_READER_COMPANY_SITES and BOT_USER_AGENT; and the logo steps (../logos). The files:
//   step.ts     the `company_site` step: homepage, about page, logo, through the shared reader (core/seams siteReader)
//   page.ts     what a page says: schema.org Organization (JSON-LD, microdata), meta, icons, profile links
//   facts.ts    a page's facts as the company_site row's values (NAICS, LEI, headquarters, employees)
//   html.ts     the tokenizer page.ts reads with (nothing is run or loaded)
//   budget.ts   COMPANY_SITE_FETCH_PER_MINUTE in the worker process
//   queue.ts    the daily refresh: due sites and logo.dev asks onto the enrichment queue
//   outcome.ts  what a step answers the enrichment worker (done, or retry at)
// E1's enrichment worker (features/companies/enrich) runs the steps; INT-4 registers E2_ENRICHMENT_STEPS there and
// the daily step in the companies feature (E2's handoff, the exact edits).

export interface EnrichmentStepDefinition {
  step: CompanyEnrichmentStep;
  run: (deps: AppDeps, input: EnrichmentStepInput) => Promise<EnrichmentStepOutcome>;
}

/** E2's enrichment steps: the company's own website, and logo.dev for the logos it does not give. */
export const E2_ENRICHMENT_STEPS: readonly EnrichmentStepDefinition[] = [
  { step: 'company_site', run: (deps, input) => runCompanySiteStep(deps, input) },
  { step: 'logo_dev', run: (deps, input) => runLogoDevStep(deps, input) },
];

export { companySitesDailyStep, queueDueCompanySites } from './queue';
export { runCompanySiteStep, homepageOf, retryDaysAfter, type CompanySiteOptions } from './step';
export { parseSitePage, type SitePage, type LogoCandidate } from './page';
export { siteFields, naicsIndustry, leiOf } from './facts';
export { createSiteBudget, type SiteBudget } from './budget';
export { stepDone, stepRetry, type EnrichmentStepInput, type EnrichmentStepOutcome } from './outcome';
