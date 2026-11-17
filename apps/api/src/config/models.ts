import type { AiTaskKind } from '@tailorit/shared';

// v1.3 C (decision 9): a suitable model per AI task. The tasks whose answer is a closed choice or an extraction that
// code checks run on Haiku 5.5 by default: a field's category (autofill_classify), an option tiebreak (autofill_pick),
// the reading of an uploaded resume (resume_analysis, grounded word for word against the resume) and of a job posting
// (job_analysis, finished and checked by finishAiAnalysis), and v2.0's AI job search and Custom filter. Every other
// kind (answers, drafts, letters, resume import, Write with AI, and kinds added later) runs on AI_CLI_MODEL, Sonnet 5.5
// by default.
//
// Which model a kind runs on (aiFeatureModel): AI_MODEL_<KIND> when set, else its default here, else AI_CLI_MODEL. So a
// .env that sets AI_CLI_MODEL alone keeps the Haiku defaults; AI_MODEL_JOB_ANALYSIS=claude-sonnet-5-5 (one line per
// kind) puts a kind back on Sonnet.

export const HAIKU_MODEL = 'claude-haiku-5-5';
export const SONNET_MODEL = 'claude-sonnet-5-5';

export const AI_KIND_DEFAULT_MODELS: Readonly<Partial<Record<AiTaskKind, string>>> = {
  autofill_classify: HAIKU_MODEL,
  autofill_pick: HAIKU_MODEL,
  resume_analysis: HAIKU_MODEL,
  job_analysis: HAIKU_MODEL,
  // v2.0 (03-ai-usage.md, 04-accounts-limits.md, 06-filters-analysis.md): a sentence turned into the classic search's
  // filters, and the Custom filter's pass or fail per job, both closed answers code checks.
  job_search: HAIKU_MODEL,
  custom_filter: HAIKU_MODEL,
  // end v2.0
  // v30 E3: company summaries (13 §8), checked in code before they are kept. The model that runs them is the admin
  // constant COMPANY_AI_MODEL (its default is this one: features/companies/summaries/task.ts passes it to runPrompt).
  company_summary: HAIKU_MODEL,
};

/**
 * v30 INT-4 (E3's open item 3): the kinds whose model is an admin constant read at each run (runPrompt's `model` option),
 * so Admin › AI's "Models by feature" shows the constant (blank: the configured model), as the runs use it.
 */
export const AI_KIND_MODEL_CONSTANTS: Readonly<Partial<Record<AiTaskKind, 'COMPANY_AI_MODEL'>>> = {
  company_summary: 'COMPANY_AI_MODEL',
};

/** The model a kind runs on: its AI_MODEL_<KIND> (`override`, blank for none), else its default, else AI_CLI_MODEL. */
export function aiFeatureModel(kind: AiTaskKind, override: string | undefined, cliModel: string): string {
  return override?.trim() || AI_KIND_DEFAULT_MODELS[kind] || cliModel;
}

/**
 * AI_CLI_THINKING: `on` (the default) passes nothing and leaves thinking to the CLI, as before v1.3; `off` passes the
 * CLI's thinking-off setting on every call (ai/provider/argv.ts).
 */
export const CLI_THINKING_MODES = ['off', 'on'] as const;
export type CliThinking = (typeof CLI_THINKING_MODES)[number];
