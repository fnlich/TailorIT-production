import { z } from 'zod';
import { IsoDateTime } from '../core/list';

// AI work runs through the local Claude CLI and can take minutes, longer than Next's /api proxy waits. So every AI
// endpoint answers `202 { taskId }` and the page polls GET /api/ai/tasks/:id until the task finishes.

export const AI_TASK_KINDS = [
  'resume_import',
  'entry_bullets',
  'job_analysis',
  'cover_letter',
  'template_fill',
  'resume_analysis',
  // The TailorIT Autofill extension's (AUTOFILL_TASK_KINDS in @tailorit/shared/autofill): a tiebreak between a field's
  // options, what an unusual question asks, from Phase 6 a draft for a free-text question, and from v2 Phase D an
  // answer to a question the profile does not settle.
  'autofill_pick',
  'autofill_classify',
  'autofill_draft',
  'autofill_answer',
  // v1.4 D: tailoring a resume and its cover letter for a job (tailor_builder0's pipeline, features/tailor).
  'tailor',
  // end v1.4 D
  // v2.0: AI job search (a sentence into the classic search's filters) and the Custom prepare filter. Both on Haiku by
  // default (AI_KIND_DEFAULT_MODELS) and charged to the person; migration 0821 adds them to ai_tasks' kind CHECK.
  'job_search',
  'custom_filter',
  // end v2.0
  // v30 E3: company summaries written by AI (13 §8): a batch of companies per call, platform spend (charged to no one),
  // on COMPANY_AI_MODEL (Haiku 5.5 by default). The baseline's ai_task_kinds holds it.
  'company_summary',
] as const;
export type AiTaskKind = (typeof AI_TASK_KINDS)[number];

export const AI_TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AiTaskStatus = (typeof AI_TASK_STATUSES)[number];

/** The `.env` feature name for per-feature model/effort overrides: AI_MODEL_<FEATURE>, AI_EFFORT_<FEATURE>. */
export const AI_FEATURE_ENV: Record<AiTaskKind, string> = {
  resume_import: 'RESUME_IMPORT',
  entry_bullets: 'BULLETS',
  job_analysis: 'JOB_ANALYSIS',
  cover_letter: 'COVER_LETTER',
  template_fill: 'TEMPLATE_FILL',
  resume_analysis: 'RESUME_ANALYSIS',
  autofill_pick: 'AUTOFILL_PICK',
  autofill_classify: 'AUTOFILL_CLASSIFY',
  autofill_draft: 'AUTOFILL_DRAFT',
  autofill_answer: 'AUTOFILL_ANSWER',
  // v1.4 D: AI_MODEL_TAILOR / AI_EFFORT_TAILOR (tailoring runs on Sonnet 5.5).
  tailor: 'TAILOR',
  // end v1.4 D
  // v2.0: AI_MODEL_JOB_SEARCH, AI_MODEL_CUSTOM_FILTER (and their AI_EFFORT_ keys).
  job_search: 'JOB_SEARCH',
  custom_filter: 'CUSTOM_FILTER',
  // end v2.0
  company_summary: 'COMPANY_SUMMARY', // v30 E3: its model is COMPANY_AI_MODEL (the constant); AI_EFFORT_COMPANY_SUMMARY
};

export const AiTaskAcceptedSchema = z.object({ taskId: z.string() });
export type AiTaskAccepted = z.infer<typeof AiTaskAcceptedSchema>;

export const AiTaskViewSchema = z.object({
  id: z.string(),
  kind: z.enum(AI_TASK_KINDS),
  status: z.enum(AI_TASK_STATUSES),
  /** Feature-specific result (validated by the feature's own schema on the client). Null until succeeded. */
  result: z.unknown().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type AiTaskView = z.infer<typeof AiTaskViewSchema>;

/** Staged progress lines the UI rotates through while a task runs (v31 FIX-DOCS: the letters' in TailorIT's words). */
export const AI_PROGRESS_MESSAGES: Record<AiTaskKind, readonly string[]> = {
  resume_import: ['Reading your resume...', 'Organizing your experience...', 'Opening your new resume...'],
  entry_bullets: ['Writing the bullets...'],
  job_analysis: ['Refining the job summary...'],
  cover_letter: [
    'Reading the job description...',
    'Matching your resume to what the job asks for...',
    'Writing your letter...',
  ],
  template_fill: [
    'Reading the job description...',
    'Filling in your template for this job...',
    'Smoothing the letter...',
  ],
  resume_analysis: ['Reading your resume...', 'Picking out skills, roles and dates...'],
  autofill_pick: ['Matching your answers to the options...'],
  autofill_classify: ['Reading the form...'],
  autofill_draft: ['Reading the job description...', 'Drafting your answer...'],
  autofill_answer: ['Reading the questions...', 'Answering from your resume...'],
  // v1.4 D
  tailor: [
    'Reading the job description...',
    'Picking out the keywords...',
    'Tailoring your resume...',
    'Writing your cover letter...',
    'Checking the ATS score...',
  ],
  // end v1.4 D
  // v2.0
  job_search: ['Reading your search...', 'Choosing the filters...'],
  custom_filter: ['Checking your custom filter...'],
  // end v2.0
  company_summary: ['Writing company summaries...'], // v30 E3
};

export const AiHealthSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  cliVersion: z.string().nullable(),
  loggedIn: z.boolean(),
  authMethod: z.string().nullable(),
  subscriptionType: z.string().nullable(),
  defaultModel: z.string(),
  models: z.record(z.string(), z.string()),
  message: z.string(),
  checkedAt: IsoDateTime,
});
export type AiHealth = z.infer<typeof AiHealthSchema>;

/** When Claude reads added jobs (AI_JOB_ANALYSIS): `ingest` and `saved` run the background backlog; `lazy`, `off` do not. */
export const AI_JOB_ANALYSIS_MODES = ['ingest', 'saved', 'lazy', 'off'] as const;
export type AiJobAnalysisMode = (typeof AI_JOB_ANALYSIS_MODES)[number];
/** Whether Claude reads each uploaded resume in the background (AI_RESUME_ANALYSIS). */
export const AI_RESUME_ANALYSIS_MODES = ['auto', 'off'] as const;
export type AiResumeAnalysisMode = (typeof AI_RESUME_ANALYSIS_MODES)[number];

const BacklogCount = z.number().int().nonnegative();

/**
 * Admin › AI › Background work (GET /api/admin/ai/background): what the background workers still have to do, counted
 * from the database (no AI call, no write). A mode without a backlog (jobs `lazy` or `off`, resumes `off`) counts 0.
 * Rows of disabled accounts are left out, as the workers skip them.
 */
export const AiBackgroundWorkSchema = z.object({
  jobs: z.object({
    mode: z.enum(AI_JOB_ANALYSIS_MODES),
    /** Jobs the add-time backlog would still read: live, enough text, no Claude analysis of their text yet. */
    waiting: BacklogCount,
    /** Of the rest, jobs whose text waits out a failed reading (30 or 60 minutes) or an outage. */
    backingOff: BacklogCount,
    /** Jobs whose text Claude failed on three times: it is tried again once a day. */
    gaveUp: BacklogCount,
    /** AI_JOB_ANALYSIS_PER_HOUR: the most the backlog starts in an hour; 0 = no cap. */
    perHourCap: BacklogCount,
  }),
  resumes: z.object({
    mode: z.enum(AI_RESUME_ANALYSIS_MODES),
    /** Uploads in line for Claude's reading (some wait out a failed one). */
    waiting: BacklogCount,
    /** Uploads being read now (one at a time on the server). */
    queued: BacklogCount,
    /** Uploads Claude failed on three times: tried again after a day. */
    failed: BacklogCount,
    /** AI_RESUME_ANALYSIS_PER_HOUR; 0 = no cap. */
    perHourCap: BacklogCount,
  }),
  matches: z.object({
    /** Saved applications whose best-matched resume TailorIT is to choose again (`resume_match_due`; no AI). */
    due: BacklogCount,
  }),
  /** Whether background AI work may start a task now; if not, why, and until when (null: until a setting changes). */
  gate: z.object({
    open: z.boolean(),
    reason: z.string().nullable(),
    retryAt: IsoDateTime.nullable(),
  }),
});
export type AiBackgroundWork = z.infer<typeof AiBackgroundWorkSchema>;

// v1.3 C ---------------------------------------------------------------------------------------------------------
// Admin › AI usage (GET /api/admin/ai/usage, decision 8): what the AI calls used per task kind over the last 1, 7 and
// 30 days, from the CLI's own usage reports. Tokens as the CLI reports them: `inputTokens` is the uncached part of the
// prompt; `cacheReadTokens` and `cacheWriteTokens` the parts read from and written to the prompt cache.

const UsageCount = z.number().int().nonnegative();

export const AiUsageRowSchema = z.object({
  /** An AI task kind, `echo` for the admin test, or `total`. A string, so a kind added later reads as well. */
  kind: z.string(),
  /** The models that answered in the window. */
  models: z.array(z.string()),
  /** Prompt runs, and the CLI calls they made (a repair retry is a second call). */
  runs: UsageCount,
  calls: UsageCount,
  /** Calls whose usage the CLI reported (a killed or stalled call reports none). */
  reported: UsageCount,
  inputTokens: UsageCount,
  outputTokens: UsageCount,
  cacheReadTokens: UsageCount,
  cacheWriteTokens: UsageCount,
  /** At API prices, as the CLI computed it (the subscription is not billed per call). */
  costUsd: z.number().nonnegative(),
  /** Items answered from TailorIT's result cache instead of the AI. */
  cachedItems: UsageCount,
  /** cacheReadTokens over every prompt token (input, cache reads and writes); null when none were reported. */
  cacheHitRate: z.number().min(0).max(1).nullable(),
});
export type AiUsageRow = z.infer<typeof AiUsageRowSchema>;

export const AiUsageSummarySchema = z.object({
  windows: z.array(
    z.object({
      days: z.number().int().positive(),
      /** The window's start: the top of the UTC hour `days` days ago. */
      since: IsoDateTime,
      kinds: z.array(AiUsageRowSchema),
      total: AiUsageRowSchema,
    }),
  ),
  checkedAt: IsoDateTime,
});
export type AiUsageSummary = z.infer<typeof AiUsageSummarySchema>;
// end v1.3 C -----------------------------------------------------------------------------------------------------

// v2.0 ------------------------------------------------------------------------------------------------------------
// Admin › AI › "Server AI status" (GET /api/admin/ai/capacity, admin only; docs/design/v2.0/03-ai-usage.md). The seat's
// usage readings, from the CLI's rate_limit_event (`event`), its limit text (`text`) or TailorIT's own spend against
// SERVER_AI_CAPACITY_USD_PER_WINDOW (`ledger`). At or above the threshold every server-AI action is refused. Only
// admins ever see any of this.

export const AI_CAPACITY_SOURCES = ['event', 'text', 'ledger'] as const;
export type AiCapacitySource = (typeof AI_CAPACITY_SOURCES)[number];

/** One live reading: a usage window the CLI names ('five_hour', 'seven_day', ...; 'unknown'), or 'ledger'. */
export const AiCapacityReadingSchema = z.object({
  window: z.string(),
  /** 0..1 (a `rejected` status reads 1). */
  utilization: z.number().min(0).max(1),
  status: z.string(),
  source: z.enum(AI_CAPACITY_SOURCES),
  /** When the window resets; null: the reading lives SERVER_AI_READING_TTL_MINUTES from `seenAt`. */
  resetsAt: IsoDateTime.nullable(),
  seenAt: IsoDateTime,
});
export type AiCapacityReading = z.infer<typeof AiCapacityReadingSchema>;

export const AiCapacitySchema = z.object({
  /** The current utilization: the highest live reading of the highest-priority source; null with no live reading. */
  utilization: z.number().min(0).max(1).nullable(),
  /** utilization >= threshold: every server-AI action is refused. */
  blocked: z.boolean(),
  /** SERVER_AI_BLOCK_THRESHOLD. */
  threshold: z.number().gt(0).lte(1),
  /** The current reading's source and window, and when it resets; null with no live reading. */
  source: z.enum(AI_CAPACITY_SOURCES).nullable(),
  window: z.string().nullable(),
  resetsAt: IsoDateTime.nullable(),
  readings: z.array(AiCapacityReadingSchema),
  /** Today's (the day key's) charged total and write-offs over every account, from ai_spend_daily. */
  today: z.object({
    dayKey: z.string(),
    chargedMicros: z.number().int().nonnegative(),
    writtenOffMicros: z.number().int().nonnegative(),
  }),
  checkedAt: IsoDateTime,
});
export type AiCapacity = z.infer<typeof AiCapacitySchema>;
// end v2.0 --------------------------------------------------------------------------------------------------------
