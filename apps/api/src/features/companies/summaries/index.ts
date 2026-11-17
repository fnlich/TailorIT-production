import type { Feature } from '../../../core/feature';
import { startSummaryRunner } from './runner';
import { summarySweepStep } from './sweep';
import { companySummaryTask } from './task';

// v30 E3: company summaries written by AI (docs/design/part2/13-company-enrichment.md §8, §11 phase 3), a feature of
// its own beside the companies feature (features/index.ts lists it right after it):
//   inputs.ts  what the AI may read about a company (its own allowed texts and its facts), and whether it may now
//   checks.ts  the checks before an answer is kept (an invented number, name or address refused; lengths; industry)
//   label.ts   "Summary written by AI from …" (the web's words), the AI row's attribution
//   state.ts   company_summaries (migrations-pg/0026): the last answer's inputs hash and time, the pending mark
//   step.ts    the enrichment queue's `ai` step: a company due (inputs or prompt changed; at most once in
//              COMPANY_AI_REFRESH_DAYS) is marked pending (E1's step registry calls it: the exact edit in E3's handoff)
//   sweep.ts   the daily look at companies whose sources changed
//   task.ts    the `company_summary` AI task: one batch, checked, asked once more, kept (or the company's own words)
//   budget.ts  COMPANY_AI_DAILY_BUDGET_USD against today's `company_summary` spend in the AI ledger
//   runner.ts  the batches, in the API process beside the AI queue (Feature.start)
export const companySummariesFeature: Feature = {
  name: 'company-summaries',
  aiTasks: [companySummaryTask],
  start: (deps) => startSummaryRunner(deps),
  daily: [summarySweepStep],
};
