import { z } from 'zod';
import { InstantSchema } from './common';

// v1.4 (work package D, decisions 14-18): tailoring a resume and a cover letter for a job, from the extension's panel
// ("Tailor resume for this job") and the TailorIT web pages alike. POST /api/autofill/tailor starts the work and always
// answers 202 {taskId, deduped}; GET /api/autofill/tailor/:id says where it stands and, once it succeeded, names the
// tailored resume (a new built resume on the chosen template, titled "<Company> - <Job title>") and the cover letter
// written beside it. Both are linked to the job's tracker entry (Saved when the person had none), so the lookup's
// suggested resume and the cover-letter route find them for the form at once. GET /api/autofill/templates lists the
// templates the profile's `documents` may name. Additive within API version 6: new routes and optional fields only,
// under scopes every connection already holds (`ai:run`, `profile:read`), so nobody connects again.

/** A request's caps: the cover-letter editor's own for the company and the title, the posting text's for the rest. */
export const AUTOFILL_TAILOR_LIMITS = {
  company: 200,
  title: 200,
  jobDescription: 20_000,
  postingUrl: 2000,
  templateId: 64,
  canaries: 50,
  canary: 200,
} as const;

/** Tailoring tasks an account may start in an hour (each one is several Claude calls). Past it: 429 `rate_limited`. */
export const AUTOFILL_TAILOR_PER_HOUR = 10;
/**
 * The same job, the same source resume at the same revision and the same templates, asked again within this many hours
 * (and without `force`), answers the earlier task (`deduped: true`) instead of starting another, while its resume is
 * still there.
 */
export const AUTOFILL_TAILOR_DEDUPE_HOURS = 24;
/** How often the extension polls GET …/tailor/:id: tailoring takes a minute or two. */
export const AUTOFILL_TAILOR_POLL_MS = 3000;

/**
 * Where a tailoring task stands, in order: waiting for a place on the AI queue, reading the job (its keywords),
 * writing the resume and the letter, checking the ATS score and revising (at most twice), then saving the documents.
 */
export const TAILOR_STEPS = ['waiting', 'analyzing', 'writing', 'revising', 'saving'] as const;
export type TailorStep = (typeof TAILOR_STEPS)[number];

/** A task's id: TailorIT's random UUID in lower case. */
export const TailorTaskIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const templateIdOf = () => z.string().min(1).max(AUTOFILL_TAILOR_LIMITS.templateId);

/**
 * What a tailoring request carries, before the rule that it names a job. `jobId` (a TailorIT job: its own text and
 * company are used, `jobDescription` instead of its text when given, as the page shows it), or the posting itself:
 * `jobDescription`, `company` and `title` (page text, quoted to Claude as data). `resumeId`: the resume to tailor from,
 * else the profile's chosen resume, else the default one; an upload is tailored from its editable copy, and one with
 * none is refused (409 `needs_editable_copy`) rather than copied behind the person's back. The templates default to
 * the profile's `documents` (absent), and `null` says "none": the source resume's own template, a letter without a
 * template. `coverLetter` false writes the resume alone. `force` starts again even when the same tailoring was done
 * in the last AUTOFILL_TAILOR_DEDUPE_HOURS. `canaries` are the page's tripwire tokens: an answer holding one is not
 * kept (the task fails).
 */
export const AutofillTailorRequestFields = z.object({
  jobId: z.number().int().positive().optional(),
  jobDescription: z.string().max(AUTOFILL_TAILOR_LIMITS.jobDescription).optional(),
  company: z.string().max(AUTOFILL_TAILOR_LIMITS.company).optional(),
  title: z.string().max(AUTOFILL_TAILOR_LIMITS.title).optional(),
  /** The posting's address, kept on a tracker entry made for a posting TailorIT does not have. */
  postingUrl: z.string().max(AUTOFILL_TAILOR_LIMITS.postingUrl).optional(),
  resumeId: z.string().min(1).max(64).optional(),
  /** A resume template id (GET /api/autofill/templates' `resumeTemplates`); null: the source resume's template. */
  resumeTemplateId: templateIdOf().nullable().optional(),
  /** A cover-letter template id (`coverLetterTemplates`); null: no template, TailorIT's own letter layout. */
  coverLetterTemplateId: templateIdOf().nullable().optional(),
  coverLetter: z.boolean(),
  force: z.boolean().optional(),
  canaries: z
    .array(z.string().min(2).max(AUTOFILL_TAILOR_LIMITS.canary))
    .max(AUTOFILL_TAILOR_LIMITS.canaries)
    .optional(),
});

/** Without a `jobId`, the posting's text, company and title are each required. */
export function refineTailorRequest(
  request: { jobId?: number; jobDescription?: string; company?: string; title?: string },
  ctx: z.RefinementCtx,
): void {
  if (request.jobId !== undefined) return;
  for (const key of ['jobDescription', 'company', 'title'] as const) {
    if (!request[key]?.trim()) ctx.addIssue({ code: 'custom', path: [key], message: 'Required' });
  }
}

/** POST /api/autofill/tailor (scope ai:run). */
export const AutofillTailorRequestSchema = AutofillTailorRequestFields.superRefine(refineTailorRequest);
export type AutofillTailorRequest = z.infer<typeof AutofillTailorRequestSchema>;

/**
 * POST …/tailor's answer (202): the task to poll. `deduped` is true when it is an earlier task: the same tailoring
 * already running, or done within AUTOFILL_TAILOR_DEDUPE_HOURS (its result is ready at once).
 */
export const AutofillTailorAcceptedSchema = z.object({ taskId: TailorTaskIdSchema, deduped: z.boolean() });
export type AutofillTailorAccepted = z.infer<typeof AutofillTailorAcceptedSchema>;

const KeywordMatchSchema = z.object({
  keyword: z.string(),
  /** Times the posting uses it (at least 1). */
  jobCount: z.number().int().nonnegative(),
  /** Times the tailored resume uses it. */
  resumeCount: z.number().int().nonnegative(),
});
const KeywordScoreSchema = z.object({
  /** 0-100. */
  score: z.number().int().min(0).max(100),
  matched: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  keywords: z.array(KeywordMatchSchema),
});

/**
 * The tailored resume's ATS report (tailor_builder0's Jobscan-style check, done in code): the job's hard skills
 * (65 points), soft skills (15) and searchability (20). `scoreBefore` is the source resume's score against the same
 * job, for "from 54 to 91".
 */
export const TailorAtsReportSchema = z.object({
  score: z.number().int().min(0).max(100),
  scoreBefore: z.number().int().min(0).max(100).nullable(),
  hardSkills: KeywordScoreSchema,
  softSkills: KeywordScoreSchema,
  /** The posted title: reported, never scored and never written on the resume. */
  jobTitle: z.object({ title: z.string(), found: z.boolean() }),
  searchability: z.object({
    score: z.number().int().min(0).max(100),
    checks: z.array(z.object({ label: z.string(), passed: z.boolean() })),
  }),
  missingHardSkills: z.array(z.string()),
  missingSoftSkills: z.array(z.string()),
});
export type TailorAtsReport = z.infer<typeof TailorAtsReportSchema>;

/** What a tailoring task made. */
export const TailorResultSchema = z.object({
  /** The new built resume (GET /api/autofill/resumes lists it; …/resumes/:id/file prints it). */
  resumeId: z.string(),
  /** Its title, "<Company> - <Job title>". */
  title: z.string(),
  resumeTemplateId: z.string(),
  /** The letter written beside it; null when none was asked for. */
  coverLetterId: z.string().nullable(),
  coverLetterTemplateId: z.string().nullable(),
  /** The tracker entry both are linked to. */
  applicationId: z.string().nullable(),
  /** Null when the posting had too little text to read keywords from (the resume is then the source's, re-titled). */
  ats: TailorAtsReportSchema.nullable(),
});
export type TailorResult = z.infer<typeof TailorResultSchema>;

/**
 * GET /api/autofill/tailor/:id (scope ai:run): one of the account's tailoring tasks. `step` and `message` (a line to
 * show while it runs) are null once it finished; `result` is set only when it succeeded; `error.code` is
 * `ai_failed`, `ai_unavailable`, `interrupted`, `cancelled`, or one added later (kept a string).
 */
export const AutofillTailorTaskSchema = z.object({
  id: TailorTaskIdSchema,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  step: z.enum(TAILOR_STEPS).nullable(),
  message: z.string().nullable(),
  result: TailorResultSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: InstantSchema,
  finishedAt: InstantSchema.nullable(),
});
export type AutofillTailorTask = z.infer<typeof AutofillTailorTaskSchema>;

/**
 * GET /api/autofill/templates (scope profile:read): the templates the profile's `documents.resumeTemplateId` and
 * `documents.coverLetterTemplateId` may name, in the order TailorIT's pages list them: the resume templates of the
 * on-page editor, then TailorIT's system letter templates and the account's own.
 */
export const AutofillTemplateListSchema = z.object({
  resumeTemplates: z.array(z.object({ id: z.string(), name: z.string() })),
  coverLetterTemplates: z.array(z.object({ id: z.string(), name: z.string(), isSystem: z.boolean() })),
});
export type AutofillTemplateList = z.infer<typeof AutofillTemplateListSchema>;

/**
 * What the tailoring routes refuse with, besides every token route's refusals (401, 403, 409 `conflict` for another
 * API version, 429): `validation_failed` (a body over a cap, no posting without a job, an unknown template),
 * `not_found` (a job, a resume or a template that is not the account's), `needs_editable_copy` (the resume to tailor
 * from is an upload with no editable copy: make one in Documents first), `conflict` (no room for another resume),
 * `ai_busy` (two tailorings of the account are running already), `rate_limited` (AUTOFILL_TAILOR_PER_HOUR reached) and
 * `ai_unavailable` (TailorIT's AI is not available now); version 8: `resume_limit_reached` (a Free account at its
 * resume limit: no tailored resume can be stored) and `ai_usage_exhausted` (the person's AI usage is used up until the
 * daily reset).
 */
export const AUTOFILL_TAILOR_REFUSALS = {
  validation_failed: 400,
  resume_limit_reached: 403,
  not_found: 404,
  needs_editable_copy: 409,
  conflict: 409,
  ai_busy: 409,
  rate_limited: 429,
  ai_usage_exhausted: 429,
  ai_unavailable: 503,
} as const;
