import { z } from 'zod';
import { AiUsePercentSchema } from '../accounts/index'; // v32 ADMINAPP (E7)
import {
  AUTOFILL_AGENT_REASONS,
  AUTOFILL_AGENT_RUN_KINDS,
  AUTOFILL_AGENT_SOURCES,
  AUTOFILL_AGENT_STATES,
} from '../autofill/agent';
import { AUTOFILL_FIELD_KINDS } from '../autofill/common';
import {
  AUTOFILL_DRAFT_PROVENANCES,
  AutofillSubmittedAnswerValueSchema,
  type AutofillDraftProvenance,
} from '../autofill/forms';
import { AUTOFILL_COVER_LETTER_MODES, type AutofillCoverLetterMode } from '../autofill/profile';
import type { MessageKey } from '../constants/constants';
import { messageError } from '../constants/public/defaults';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';
import { IsoDate, IsoDateTime } from '../core/list';
import { JobVerificationSchema } from '../jobs/add'; // v31 INT-2
import { JobCreditSchema } from '../jobs/dto'; // v30 FIX-B

// v2.0: Prepare & Queue (docs/design/v2.0/05-prepare-flow.md), which replaces v1.5's Prebuild. A job reaches the
// auto-apply queue only through Prepare & Queue on a saved job (a Tracker entry at Saved with a job): the prepare
// filters, then the tailored resume, the cover letter (by the person's letter mode) and answers to the job's known
// questions, then the queue row, inserted when the required parts are ready. One `prepare_jobs` row per Prepare of one
// saved job (0822); its parts are kept in the application's draft (application_drafts), the "kit". Two modes: `server`
// (TailorIT's AI, a background runner paced by FREE_/PAID_PREPARE_PER_HOUR) and `mcp` (the person's own AI through
// TailorIT's MCP server, never charged). Routes (session):
//   POST /api/prepare                    PrepareStartRequest → 202 PrepareStartResponse (or one error for all)
//   GET  /api/prepare/settings           → PrepareSettings
//   PUT  /api/prepare/settings           PrepareSettingsBody → PrepareSettings, as saved
//   POST /api/prepare/:id/cancel         → PrepareJob
//   GET  /api/applications/:id/draft     → ApplicationDraftResponse (the Tracker's "Prepared" tab)
//   GET  /api/auto-apply/saved           SavedJobListQuery → SavedJobList (the Saved Jobs pane)
//   GET  /api/auto-apply/queue           QueuePaneQuery → QueuePane (the Queue pane)
//   GET  /api/auto-apply/items/:id/kit   → PreparedKit (the manual flow's copy-ready kit)

/** `server`: TailorIT's AI. `mcp`: the person's own AI, through TailorIT's MCP server. */
export const PREPARE_MODES = ['server', 'mcp'] as const;
export type PrepareMode = (typeof PREPARE_MODES)[number];

/**
 * A kit part's status. `pending`: to be made. `building`: being made now. `ready`: made. `not_ready` (answers only):
 * some or all answers could not be prepared (the questions are not known yet, or the AI gave none): they are made
 * during the application. `failed`: it could not be made (the draft's `error` says why). `skipped`: not made
 * (cancelled, or the person's own AI skipped it). `off` (the letter only): no letter is wanted.
 */
export const PREPARE_PART_STATUSES = ['pending', 'building', 'ready', 'not_ready', 'failed', 'skipped', 'off'] as const;
export type PreparePartStatus = (typeof PREPARE_PART_STATUSES)[number];

/**
 * A Prepare's state (prepare_jobs.state). Active: `waiting` (for the server runner, or for the person's own AI),
 * `filtering` (the Custom filter judges it), `analyzing` (its job analysis is read again to version 2), `building`
 * (the resume, the letter, the answers). Finished: `queued` (its queue row was inserted), `prepared` (the kit is ready
 * but it was not queued: the queue was full), `filtered` (a filter failed), `failed` (a required part could not be
 * made), `cancelled` (the person cancelled it, or the update interrupted it).
 */
export const PREPARE_JOB_STATES = [
  'waiting',
  'filtering',
  'analyzing',
  'building',
  'queued',
  'prepared',
  'filtered',
  'failed',
  'cancelled',
] as const;
export type PrepareJobState = (typeof PREPARE_JOB_STATES)[number];
/** The states of a Prepare that is not over: an application has at most one (idx_prepare_jobs_active). */
export const PREPARE_ACTIVE_STATES = [
  'waiting',
  'filtering',
  'analyzing',
  'building',
] as const satisfies readonly PrepareJobState[];
export type PrepareActiveState = (typeof PREPARE_ACTIVE_STATES)[number];
export const isActivePrepareState = (state: PrepareJobState): state is PrepareActiveState =>
  (PREPARE_ACTIVE_STATES as readonly string[]).includes(state);

/** What an active server Prepare is doing, for the Queue pane's "Preparing" line. */
export const PREPARE_STEPS = ['filters', 'analysis', 'resume', 'letter', 'answers'] as const;
export type PrepareStep = (typeof PREPARE_STEPS)[number];

/** How often the Auto-Apply page reads the panes again while anything is preparing or applying. */
export const PREPARE_POLL_MS = 3000;
/** The answers one AI batch asks (the answer task's own cap): a job with more known questions asks in a few batches. */
export const PREPARE_ANSWER_BATCH = 10;
/**
 * The most saved jobs one request names: PREPARE_BATCH_MAX's own ceiling, read from its bounds (v30 CT, audit B2); the
 * route checks the resolved constant.
 */
export const PREPARE_REQUEST_CEILING = PUBLIC_CONSTANT_SPECS.PREPARE_BATCH_MAX.max;

/**
 * The cover-letter mode (A6): `required`, a letter only when the application requires one (the default); `always`, a
 * letter for every job. Kept in the autofill profile's documents.coverLetters (API 8).
 */
export const COVER_LETTER_MODES = AUTOFILL_COVER_LETTER_MODES;
export type CoverLetterMode = AutofillCoverLetterMode;

// v20 A29
/**
 * The resume mode (DECISIONS A29), the person's setting (user_settings.prepare_resume_mode, 0827; a new account's is
 * the constant PREPARE_RESUME_MODE_DEFAULT, `tailor`), fixed on each Prepare when it starts (prepare_jobs.resume_mode):
 * - `default`: the person's default resume as it is (the profile's documents.resumeId, else the account's default
 *   resume). No AI, no new resume.
 * - `similar`: the person's existing resume (any kind) that best matches the job, by the rule-based resume match (no
 *   AI); the default resume when nothing scores. No AI, no new resume.
 * - `tailor`: a new resume tailored to the job by the AI from the source resume (v1.5's behaviour).
 *
 * The rule: the cover letter and every drafted answer are written from the CHOSEN resume's content (the tailored one,
 * or the chosen resume's document, or an upload's extracted text), on the server-AI and the MCP path alike, so they
 * agree with the resume the application uses. The profile still supplies what the resume lacks, never invented. No
 * resume to choose refuses the Prepare (MSG_PREPARE_NO_RESUME); the Free resume limit refuses only `tailor`, the one
 * mode that makes a resume.
 */
export const PREPARE_RESUME_MODES = ['default', 'similar', 'tailor'] as const;
export type PrepareResumeMode = (typeof PREPARE_RESUME_MODES)[number];
/** Each mode's words (constants): Settings › Prepare & Queue's choices, and the mode a prepared kit used. */
export const PREPARE_RESUME_MODE_LABELS = {
  default: 'LABEL_RESUME_MODE_DEFAULT',
  similar: 'LABEL_RESUME_MODE_SIMILAR',
  tailor: 'LABEL_RESUME_MODE_TAILOR',
} as const satisfies Record<PrepareResumeMode, MessageKey>;
// end v20 A29

// The request ---------------------------------------------------------------------------------------------------------

/** POST /api/prepare: the saved jobs (Tracker entries) to prepare, each once; `rebuild` makes their kits again. */
export const PrepareStartRequestSchema = z.object({
  applicationIds: z
    .array(z.string().min(1).max(64))
    .min(1, 'Choose at least one saved job')
    .max(PREPARE_REQUEST_CEILING, messageError('MSG_PREPARE_BATCH_MAX', { max: PREPARE_REQUEST_CEILING }))
    .refine((ids) => new Set(ids).size === ids.length, 'Choose each saved job once'),
  rebuild: z.boolean().default(false),
});
export type PrepareStartRequest = z.infer<typeof PrepareStartRequestSchema>;

/** One job's outcome: a Prepare started, queued at once (its kit was reusable), filtered, or skipped. */
export const PREPARE_OUTCOMES = ['started', 'queued', 'filtered', 'skipped'] as const;
export type PrepareOutcome = (typeof PREPARE_OUTCOMES)[number];

/**
 * Why a job was skipped. `not_found`: not the person's entry. `not_saved`: past Saved, or archived. `no_job`: the entry
 * has no job. `active`: a Prepare of it is active. `already_queued`: its job's queue row is queued or running.
 * `custom_pending` (MCP only): the Custom filter has not judged it.
 */
export const PREPARE_SKIP_CODES = [
  'not_found',
  'not_saved',
  'no_job',
  'active',
  'already_queued',
  'custom_pending',
] as const;
export type PrepareSkipCode = (typeof PREPARE_SKIP_CODES)[number];

/** The message each skip shows (`label`); `not_found` shows none, as an unknown entry. */
export const PREPARE_SKIP_MESSAGES = {
  not_found: null,
  not_saved: 'MSG_PREPARE_NOT_SAVED',
  no_job: 'MSG_PREPARE_NO_JOB',
  active: 'MSG_PREPARE_ACTIVE',
  already_queued: 'MSG_PREPARE_ALREADY_QUEUED',
  custom_pending: 'MSG_CUSTOM_FILTER_PENDING',
} as const satisfies Record<PrepareSkipCode, MessageKey | null>;

/** A reason as the page shows it: a FILTER_REASONS or skip code, and its words (rendered by the server). */
export const PrepareReasonSchema = z.object({ code: z.string().min(1).max(40), label: z.string() });
export type PrepareReason = z.infer<typeof PrepareReasonSchema>;

/**
 * POST /api/prepare's 202: each job's outcome, in the request's order. `prepareId` for `started` and `queued`;
 * `reason` for `filtered` (its first filter reason) and `skipped`.
 */
export const PrepareStartResponseSchema = z.object({
  results: z.array(
    z.object({
      applicationId: z.string(),
      outcome: z.enum(PREPARE_OUTCOMES),
      prepareId: z.string().optional(),
      reason: PrepareReasonSchema.optional(),
    }),
  ),
});
export type PrepareStartResponse = z.infer<typeof PrepareStartResponseSchema>;

// v31 AUTO (D10): Prepare All -----------------------------------------------------------------------------------------
//   GET  /api/prepare/all   → PrepareAllPlan (the confirm's numbers and the jobs it names; nothing starts)
//   POST /api/prepare/all   PrepareAllRequest → 202 PrepareAllResponse: of the jobs the confirm named, the ones still
//                             in To prepare that pass the filters, within the caps (v31 FIX-AUTH, BEH-8: never a job
//                             the person was not asked about); or one error for the whole request (as POST /api/prepare)

/**
 * Why Prepare All leaves passing jobs for later: one request's batch (PREPARE_BATCH_MAX), the room left in the
 * auto-apply queue (QUEUE_SIZE_MAX), or the plan's resume storage (the `tailor` mode makes one resume per job).
 */
export const PREPARE_ALL_HELD_REASONS = ['batch', 'queue', 'resumes'] as const;
export type PrepareAllHeldReason = (typeof PREPARE_ALL_HELD_REASONS)[number];
/** The words of each reason (constants), with {count} and {max} / {limit} filled in by the server. */
export const PREPARE_ALL_HELD_MESSAGES = {
  batch: 'MSG_PREPARE_ALL_HELD_BATCH',
  queue: 'MSG_PREPARE_ALL_HELD_QUEUE',
  resumes: 'MSG_PREPARE_ALL_HELD_RESUMES',
} as const satisfies Record<PrepareAllHeldReason, MessageKey>;

const Count = z.number().int().nonnegative();

/** The passing jobs Prepare All leaves for later, why, and what to do (rendered). */
export const PrepareAllHeldSchema = z.object({
  count: z.number().int().positive(),
  reason: z.enum(PREPARE_ALL_HELD_REASONS),
  message: z.string(),
});
export type PrepareAllHeld = z.infer<typeof PrepareAllHeldSchema>;

/** The counts both answers carry. */
const PrepareAllCounts = {
  /** The person's saved jobs in To prepare (no Prepare yet, filtered, or preparation failed) whose job is open. */
  toPrepare: Count,
  /** Of them, the ones the saved filters let through now (a Custom filter judges the rest while they are prepared). */
  passing: Count,
  /** Passing jobs left for later; absent when Prepare All takes them all. */
  held: PrepareAllHeldSchema.optional(),
};

/** GET /api/prepare/all: what Prepare All would take now, and today's AI budget for the confirm's note. */
export const PrepareAllPlanSchema = z.object({
  ...PrepareAllCounts,
  /** Of the passing jobs, how many one Prepare All takes now (the newest saved first). */
  taking: Count,
  /** v31 FIX-AUTH (BEH-8): the saved jobs (Tracker entries) it takes, `taking` of them, in the pane's order: the confirm
   *  sends them back, and Prepare All starts no other. */
  applicationIds: z.array(z.string().min(1).max(64)),
  /**
   * The person's AI use today: `percent` its share of the daily budget (aiUsePercent; null: no daily limit);
   * `creditMicros` the extra credit left. v32 ADMINAPP (E7): the amounts (`usedMicros`, `budgetMicros`, null: no daily
   * limit) are sent to admins only.
   */
  ai: z.object({
    usedMicros: Count.optional(),
    budgetMicros: Count.nullable().optional(),
    percent: AiUsePercentSchema.optional(), // v32 ADMINAPP (E7)
    creditMicros: Count,
  }),
});
export type PrepareAllPlan = z.infer<typeof PrepareAllPlanSchema>;

/**
 * v31 FIX-AUTH (BEH-8): POST /api/prepare/all, the jobs the confirm named (its plan's `applicationIds`). The server takes
 * the ones still in To prepare that pass the filters now, within the caps: never more, and never another.
 */
export const PrepareAllRequestSchema = PrepareStartRequestSchema.pick({ applicationIds: true });
export type PrepareAllRequest = z.infer<typeof PrepareAllRequestSchema>;

/** POST /api/prepare/all: each taken job's outcome (as POST /api/prepare's), and the counts (of the confirmed jobs). */
export const PrepareAllResponseSchema = PrepareStartResponseSchema.extend(PrepareAllCounts);
export type PrepareAllResponse = z.infer<typeof PrepareAllResponseSchema>;
// end v31 AUTO

// Settings ------------------------------------------------------------------------------------------------------------

/**
 * GET and PUT /api/prepare/settings: the letter mode (the profile's documents.coverLetters), the resume mode
 * (user_settings.prepare_resume_mode, v20 A29) and "Don't show this again" of the Prepare & Queue confirm
 * (user_settings.skip_prepare_confirm).
 */
export const PrepareSettingsSchema = z.object({
  letterMode: z.enum(COVER_LETTER_MODES),
  resumeMode: z.enum(PREPARE_RESUME_MODES), // v20 A29
  skipConfirm: z.boolean(),
});
export type PrepareSettings = z.infer<typeof PrepareSettingsSchema>;

/** PUT /api/prepare/settings: any of the fields (the confirm sends `{skipConfirm: true}` alone). */
export const PrepareSettingsBodySchema = z
  .object({
    letterMode: z.enum(COVER_LETTER_MODES).optional(),
    resumeMode: z.enum(PREPARE_RESUME_MODES).optional(), // v20 A29
    skipConfirm: z.boolean().optional(),
  })
  .refine(
    (body) => body.letterMode !== undefined || body.resumeMode !== undefined || body.skipConfirm !== undefined,
    'Send letterMode, resumeMode or skipConfirm',
  );
export type PrepareSettingsBody = z.infer<typeof PrepareSettingsBodySchema>;

// The Prepare and its kit ----------------------------------------------------------------------------------------------

/** One Prepare (prepare_jobs), as the person sees it: never its cost. */
export const PrepareJobSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  jobId: z.number().int().positive().nullable(),
  mode: z.enum(PREPARE_MODES),
  letterMode: z.enum(COVER_LETTER_MODES),
  // v20 A29
  /** The resume mode, fixed when the Prepare started (prepare_jobs.resume_mode). */
  resumeMode: z.enum(PREPARE_RESUME_MODES),
  /**
   * The resume this Prepare chose (prepare_jobs.resume_id): the tailored one for `tailor`, the default or the most
   * similar one otherwise. The letter and the answers are written from it. Null until chosen, or once it is deleted.
   */
  resumeId: z.string().nullable(),
  // end v20 A29
  /** Whether a letter is made: decided when the questions and the analysis are read; null until then. */
  letterWanted: z.boolean().nullable(),
  rebuild: z.boolean(),
  state: z.enum(PREPARE_JOB_STATES),
  /** An active server Prepare's step; null otherwise. */
  step: z.enum(PREPARE_STEPS).nullable(),
  /** `filtered`: the first filter reason; `cancelled` by the update: `interrupted`. */
  reason: PrepareReasonSchema.nullable(),
  /** `failed` (and a `prepared` left out of a full queue): what went wrong, in words. */
  error: z.string().nullable(),
  /** The queue row it made; it may have been cleared since. */
  queueId: z.string().nullable(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
});
export type PrepareJob = z.infer<typeof PrepareJobSchema>;

/** One application's kit (application_drafts): each part's status and documents, and how many answers are ready. */
export const PrepareDraftSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  builtBy: z.enum(PREPARE_MODES),
  /** The Prepare that last worked on this kit. */
  prepareId: z.string().nullable(),
  resume: z.object({
    status: z.enum(PREPARE_PART_STATUSES),
    resumeId: z.string().nullable(),
    /** v20 A29: how that Prepare chose the resume (its prepare_jobs.resume_mode); null with no Prepare. */
    resumeMode: z.enum(PREPARE_RESUME_MODES).nullable(),
  }),
  letter: z.object({ status: z.enum(PREPARE_PART_STATUSES), coverLetterId: z.string().nullable() }),
  answers: z.object({
    status: z.enum(PREPARE_PART_STATUSES),
    /** Ready answers, out of `total`: the known questions a kit answers (never the profile's). */
    ready: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** The job's questions TailorIT knows now; 0: "Questions not known yet". */
    questionsKnown: z.number().int().nonnegative(),
  }),
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  builtAt: IsoDateTime.nullable(),
});
export type PrepareDraft = z.infer<typeof PrepareDraftSchema>;

/**
 * A known question in the Tracker's "Prepared" tab: `ready` (the kit's answer), `not_ready` (made during the
 * application) or `profile` (a self-identification, legal, pay, consent, attention-check, file or personal-detail
 * question, which is never prepared: the profile fills it when the person applies).
 */
export const DRAFT_ANSWER_STATES = ['ready', 'not_ready', 'profile'] as const;
export type DraftAnswerState = (typeof DRAFT_ANSWER_STATES)[number];

export const ApplicationDraftAnswerSchema = z.object({
  questionId: z.number().int().positive(),
  label: z.string(),
  section: z.string(),
  step: z.number().int().nonnegative(),
  required: z.boolean(),
  kind: z.enum(AUTOFILL_FIELD_KINDS),
  state: z.enum(DRAFT_ANSWER_STATES),
  answer: AutofillSubmittedAnswerValueSchema.nullable(),
  provenance: z.enum(AUTOFILL_DRAFT_PROVENANCES).nullable(),
});
export type ApplicationDraftAnswer = z.infer<typeof ApplicationDraftAnswerSchema>;

/** GET /api/applications/:id/draft: the application's kit (null: none yet) and its job's known questions. */
export const ApplicationDraftResponseSchema = z.object({
  draft: PrepareDraftSchema.nullable(),
  /** The tailored resume's and the letter's names, when they are still there. */
  resumeTitle: z.string().nullable(),
  coverLetterTitle: z.string().nullable(),
  answers: z.array(ApplicationDraftAnswerSchema),
});
export type ApplicationDraftResponse = z.infer<typeof ApplicationDraftResponseSchema>;

/** Who prepared a kit's answer: TailorIT's AI (`server-ai`) or the person's own AI (`mcp`). */
export type { AutofillDraftProvenance as PrepareAnswerProvenance };

// The letter decision (A6) -----------------------------------------------------------------------------------------

/** A required question whose label asks for a cover letter (a file, a long or a short text field). */
const LETTER_QUESTION = /\bcover(ing)?\s*letter\b/i;
const LETTER_QUESTION_KINDS: readonly string[] = ['file', 'textarea', 'text'];

/** What letterRequired reads of a job's known question (job_form_questions). */
export interface LetterQuestion {
  label: string;
  kind: string;
  required: boolean;
}

const asksForLetter = (questions: readonly LetterQuestion[]) =>
  questions.some(
    (question) =>
      question.required && LETTER_QUESTION_KINDS.includes(question.kind) && LETTER_QUESTION.test(question.label),
  );

/**
 * "The application requires a letter" (A6): a known required question of the job asks for a cover letter (its label
 * names one, and it is a file, a long or a short text field), or the job's facts say a letter is required
 * (job_facts.cover_letter_required, from the analysis or the rules). With no such question and no such fact, false.
 */
export function letterRequired(
  facts: { coverLetterRequired: boolean | null } | null,
  questions: readonly LetterQuestion[],
): boolean {
  return asksForLetter(questions) || facts?.coverLetterRequired === true;
}

/** Why a letter is or is not made (MCP prepare_job_context's `letter.reason`). */
export const LETTER_REASONS = ['always', 'required_by_question', 'required_by_posting', 'not_required'] as const;
export type LetterReason = (typeof LETTER_REASONS)[number];

/** The letter decision of one Prepare (its step c): wanted under `mode`, and why. */
export function letterDecision(
  mode: CoverLetterMode,
  facts: { coverLetterRequired: boolean | null } | null,
  questions: readonly LetterQuestion[],
): { wanted: boolean; reason: LetterReason } {
  if (mode === 'always') return { wanted: true, reason: 'always' };
  if (asksForLetter(questions)) return { wanted: true, reason: 'required_by_question' };
  if (facts?.coverLetterRequired === true) return { wanted: true, reason: 'required_by_posting' };
  return { wanted: false, reason: 'not_required' };
}

// The Saved Jobs pane -----------------------------------------------------------------------------------------------

/** Which run can apply to a saved job: Run auto-apply (`agent`), the Queue tab alone (`tab`), or the person (`manual`). */
export const SAVED_JOB_SUPPORT = ['agent', 'tab', 'manual'] as const;
export type SavedJobSupport = (typeof SAVED_JOB_SUPPORT)[number];

/**
 * A saved job's marker (05's state table), from its newest Prepare and its queue row: `none` (Prepare & Queue),
 * `filtered` ("Filtered: <reason>"), `preparing`, `prepare_failed`, `prepared` (ready, not queued), `queued`,
 * `not_applied` (its run failed, was skipped or needs the person).
 */
export const SAVED_JOB_MARKERS = [
  'none',
  'filtered',
  'preparing',
  'prepare_failed',
  'prepared',
  'queued',
  'not_applied',
] as const;
export type SavedJobMarker = (typeof SAVED_JOB_MARKERS)[number];

/** The words of each marker (`filtered` is MSG_FILTERED with its reason; `none` shows none). */
export const SAVED_JOB_MARKER_LABELS = {
  none: null,
  filtered: 'MSG_FILTERED',
  preparing: 'MARKER_PREPARING',
  prepare_failed: 'STATE_PREPARE_FAILED',
  prepared: 'MARKER_PREPARED',
  // v20 A30: the queued entry (a live queue row) reads Draft, the Tracker's derived status, from the same constant.
  queued: 'STATUS_DRAFT_LABEL',
  not_applied: 'MARKER_APPLY_FAILED',
} as const satisfies Record<SavedJobMarker, MessageKey | null>;

/** The Saved pane's filter tabs. */
export const SAVED_JOB_FILTERS = ['all', 'ready', 'filtered', 'queued'] as const;
export type SavedJobFilter = (typeof SAVED_JOB_FILTERS)[number];

export const AUTO_APPLY_PAGE_MAX = 100;
export const AUTO_APPLY_PAGE_DEFAULT = 50;

const PageQuery = {
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(AUTO_APPLY_PAGE_MAX).default(AUTO_APPLY_PAGE_DEFAULT),
};

export const SavedJobListQuerySchema = z.object({ ...PageQuery, filter: z.enum(SAVED_JOB_FILTERS).default('all') });
export type SavedJobListQuery = z.infer<typeof SavedJobListQuerySchema>;

/** One saved job (a Tracker entry at Saved with a job), newest first. */
export const SavedJobItemSchema = z.object({
  applicationId: z.string(),
  jobId: z.number().int().positive(),
  title: z.string(),
  company: z.string(),
  logoUrl: z.string().nullable(),
  location: z.string(),
  /** The day it was saved. */
  savedOn: IsoDate,
  support: z.enum(SAVED_JOB_SUPPORT),
  /**
   * v20 A30: `queued` is the live queue row (DRAFT_QUEUE_STATES), so the entry shows Draft:
   * displayStatusOf({status: STATUS.saved, queued: item.marker === 'queued'}).
   */
  marker: z.enum(SAVED_JOB_MARKERS),
  /** The marker's words ("Filtered: on-site", "Queued"), rendered; absent for `none`. */
  label: z.string().optional(),
  /**
   * v2.0 build: every failing filter of a `filtered` job, for the chip's tooltip ("with every reason in its tooltip",
   * 06), each with its words; the first is the label's.
   */
  reasons: z.array(PrepareReasonSchema).optional(),
  prepareId: z.string().optional(),
  queueId: z.string().optional(),
  /**
   * v30 INT-3 (14 §4.3): its job is held for review (a posting someone added from a board no enabled source runs):
   * in this account's lists at once, in nobody else's search until an admin approves it ("Waiting for approval").
   * Absent or false: not held.
   */
  held: z.boolean().optional(),
  /**
   * v31 INT-2: the job's verification, as JobSummary's (`verification`): a job only this account sees because TailorIT
   * could not read its link (`private_unverified`), or one an admin approves next (`waiting_admin`). Absent: everyone
   * sees it.
   */
  verification: JobVerificationSchema.optional(),
  // v30 FIX-B
  /**
   * v30 FIX-B (REV-REQ REQ-1): the credit line the job's source asks for wherever its job is shown (12 §3.6-3.7:
   * Himalayas' "visible credit with a link", Jobicy's), as the Jobs card's. Absent: none asked.
   */
  credit: JobCreditSchema.optional(),
  /**
   * v30 FIX-B (REV-UX UX-10): its job closed (no live link is left: two complete listings missed it, an approved closed
   * report, a liveness 404): the row shows "Closed" beside the held mark. Absent: open.
   */
  closed: z.literal(true).optional(),
  // end v30 FIX-B
});
export type SavedJobItem = z.infer<typeof SavedJobItemSchema>;

/** GET /api/auto-apply/saved: one page; stale filter verdicts are computed again for it (no AI). */
export const SavedJobListSchema = z.object({
  items: z.array(SavedJobItemSchema),
  nextCursor: z.string().optional(),
});
export type SavedJobList = z.infer<typeof SavedJobListSchema>;

// The Queue pane ----------------------------------------------------------------------------------------------------

/**
 * How a queue row shows: `ready` (queued for a run), `waiting_reset` (queued, the Free window's limit reached),
 * `applying` (running), `applied` (submitted), `failed` (failed or skipped), `needs_you`, `manual` (an unsupported
 * job, applied to by hand).
 */
export const QUEUE_PANE_DISPLAYS = [
  'ready',
  'waiting_reset',
  'applying',
  'applied',
  'failed',
  'needs_you',
  'manual',
] as const;
export type QueuePaneDisplay = (typeof QUEUE_PANE_DISPLAYS)[number];

/** The words of each display. */
export const QUEUE_PANE_DISPLAY_LABELS = {
  ready: 'STATE_READY',
  waiting_reset: 'STATE_WAITING_RESET',
  applying: 'STATE_APPLYING',
  applied: 'STATE_APPLIED',
  failed: 'STATE_FAILED',
  needs_you: 'STATE_NEEDS_YOU',
  manual: 'STATE_MANUAL',
} as const satisfies Record<QueuePaneDisplay, MessageKey>;

/**
 * An active, failed or prepared-not-queued Prepare in the Queue pane, newest first. Its words: an active server one
 * STATE_PREPARING (with its step), an mcp one STATE_PREPARING_OWN_AI; `failed` STATE_PREPARE_FAILED; `prepared`
 * STATE_PREPARED (with MSG_PREPARE_QUEUE_FULL).
 */
export const PreparingItemSchema = z.object({
  prepareId: z.string(),
  applicationId: z.string(),
  jobId: z.number().int().positive().nullable(),
  title: z.string(),
  company: z.string(),
  logoUrl: z.string().nullable(),
  mode: z.enum(PREPARE_MODES),
  /** v20 A29: the Prepare's resume mode. */
  resumeMode: z.enum(PREPARE_RESUME_MODES),
  state: z.enum(PREPARE_JOB_STATES),
  step: z.enum(PREPARE_STEPS).nullable(),
  /** The state's words, rendered. */
  label: z.string(),
  reason: PrepareReasonSchema.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // v30 FIX-B
  /**
   * v30 FIX-B (REV-REQ REQ-1): the credit line the job's source asks for wherever its job is shown (12 §3.6-3.7:
   * Himalayas' "visible credit with a link", Jobicy's), as the Jobs card's. Absent: none asked.
   */
  credit: JobCreditSchema.optional(),
  /**
   * v30 FIX-B (REV-UX UX-10): its job closed (no live link is left: two complete listings missed it, an approved closed
   * report, a liveness 404): the row shows "Closed" beside the held mark. Absent: open.
   */
  closed: z.literal(true).optional(),
  // end v30 FIX-B
});
export type PreparingItem = z.infer<typeof PreparingItemSchema>;

/** One queue row in the Queue pane, in the queue's order (running, then queued oldest first, then finished). */
export const QueuePaneItemSchema = z.object({
  queueId: z.string(),
  /** Null for a row queued before v2.0 whose Tracker entry is gone. */
  applicationId: z.string().nullable(),
  jobId: z.number().int().positive(),
  /** Null for a row queued before v2.0 ("Queued before v2.0"). */
  prepareId: z.string().nullable(),
  /**
   * v20 A29: the resume mode of the Prepare that queued it (the kit line's "Default resume", "Tailored"); null for a
   * row queued before v2.0.
   */
  resumeMode: z.enum(PREPARE_RESUME_MODES).nullable(),
  title: z.string(),
  company: z.string(),
  logoUrl: z.string().nullable(),
  location: z.string(),
  /** The posting's address (Open job page). */
  url: z.string(),
  state: z.enum(AUTOFILL_AGENT_STATES),
  display: z.enum(QUEUE_PANE_DISPLAYS),
  /** The display's words, rendered. */
  label: z.string(),
  support: z.enum(SAVED_JOB_SUPPORT),
  reason: z.enum(AUTOFILL_AGENT_REASONS).nullable(),
  run: z.enum(AUTOFILL_AGENT_RUN_KINDS).nullable(),
  source: z.enum(AUTOFILL_AGENT_SOURCES),
  attempts: z.number().int().nonnegative(),
  aiGuesses: z.number().int().nonnegative().nullable(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  // v30 FIX-B
  /**
   * v30 FIX-B (REV-REQ REQ-1): the credit line the job's source asks for wherever its job is shown (12 §3.6-3.7:
   * Himalayas' "visible credit with a link", Jobicy's), as the Jobs card's. Absent: none asked.
   */
  credit: JobCreditSchema.optional(),
  /**
   * v30 FIX-B (REV-UX UX-10): its job closed (no live link is left: two complete listings missed it, an approved closed
   * report, a liveness 404): the row shows "Closed" beside the held mark. Absent: open.
   */
  closed: z.literal(true).optional(),
  // end v30 FIX-B
});
export type QueuePaneItem = z.infer<typeof QueuePaneItemSchema>;

/** The Free account's usage line ("3 of 7 used today"). */
export const QueueUsageSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  resetsAt: IsoDateTime,
  /** "12:00 AM Pacific Time". */
  resetText: z.string(),
  reached: z.boolean(),
});
export type QueueUsage = z.infer<typeof QueueUsageSchema>;

export const QueuePaneQuerySchema = z.object(PageQuery);
export type QueuePaneQuery = z.infer<typeof QueuePaneQuerySchema>;

/** GET /api/auto-apply/queue. `usage` is null for an account whose auto-apply is UNLIMITED. */
export const QueuePaneSchema = z.object({
  preparing: z.array(PreparingItemSchema),
  items: z.array(QueuePaneItemSchema),
  usage: QueueUsageSchema.nullable(),
  nextCursor: z.string().optional(),
});
export type QueuePane = z.infer<typeof QueuePaneSchema>;

/**
 * GET /api/auto-apply/items/:queueId/kit: the manual flow's copy-ready kit. The resume (null once deleted), the letter
 * (null: none), and the prepared answers, never a sensitive profile answer. The letter and the answers were written
 * from that resume (v20 A29).
 */
export const PreparedKitSchema = z.object({
  queueId: z.string(),
  postingUrl: z.string(),
  resume: z
    .object({
      id: z.string(),
      title: z.string(),
      downloadUrl: z.string(),
      /** v20 A29: how the Prepare chose it; null for a kit queued before v2.0. */
      resumeMode: z.enum(PREPARE_RESUME_MODES).nullable(),
    })
    .nullable(),
  letter: z.object({ id: z.string(), title: z.string(), text: z.string(), downloadUrl: z.string() }).nullable(),
  answers: z.array(z.object({ label: z.string(), answerText: z.string(), required: z.boolean() })),
});
export type PreparedKit = z.infer<typeof PreparedKitSchema>;
