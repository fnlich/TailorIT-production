import { z } from 'zod';
import { AUTOFILL_RESUME_MAX_BYTES } from './resumes';

// The cover letter the extension uploads into a form's cover-letter field (version 2). POST
// /api/autofill/cover-letters finds the person's letter for the job, or, when the extension asks for one, writes it
// with TailorIT's cover-letter AI; GET …/:id says whether it is written; GET …/:id/file answers it as the PDF the
// letter editor's Download prints (the bytes themselves, not JSON, checked as a resume's file is). The job's text
// travels in the body. TailorIT logs nothing of a letter, a job or an application: no id, no address, no words.

/**
 * A request's caps: the cover-letter editor's own for the company and the title, the AI routes' for the job text and
 * the canaries.
 */
export const AUTOFILL_COVER_LETTER_LIMITS = {
  company: 200,
  jobTitle: 200,
  jobText: 20_000,
  canaries: 50,
  canary: 200,
} as const;

/** The largest letter GET …/file answers (413 `file_too_large` above it): a resume file's cap. */
export const AUTOFILL_COVER_LETTER_MAX_BYTES = AUTOFILL_RESUME_MAX_BYTES;

/** A cover letter's id: TailorIT's random UUID in lower case (the path of GET …/:id and …/:id/file). */
export const AutofillCoverLetterIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/**
 * Where a letter stands. `ready`: it has text and no `{{PLACEHOLDER}}` left, so GET …/file answers it. `generating`:
 * TailorIT's AI is writing it (from the extension or the letter editor); ask again in a moment. `failed`: there is
 * nothing to upload: it is empty (never written, or its writing failed or was not kept) or the person's own letter
 * still holds a placeholder to fill. The extension leaves the field for the person then.
 */
export const AUTOFILL_COVER_LETTER_STATES = ['ready', 'generating', 'failed'] as const;
export type AutofillCoverLetterState = (typeof AUTOFILL_COVER_LETTER_STATES)[number];

/**
 * POST /api/autofill/cover-letters (scope letters:write): the letter for this application. TailorIT looks at the
 * person's letters for the job: their tracker entry's own letter, then the others for the job, newest first, then
 * their letters with no job for the job's company and title (without a `jobId`: those alone, for this company and
 * this title; case, spacing and compatibility forms aside). It answers the first that is ready, else the first being
 * written. Otherwise the first of them decides: one with text (a placeholder still to fill) answers `failed` as it is,
 * never written over; an empty one is written now when `generate` is true (`failed` without asking the AI when its
 * template uses a detail of the person's they have not given). With no letter at all, and only when `generate` is
 * true, it writes a new one (linked to the job and the tracker entry). Writing is the letter editor's Generate with no
 * template: TailorIT's cover-letter AI, from `resumeId` and the page's `jobText` (never TailorIT's stored copy of the
 * job, which can hold text the page hides), and only into a letter still empty when it is written. `generate` is false
 * on a posting that forbids AI, so only a letter the person wrote or edited is used: none being written, none the AI
 * wrote that they have not touched. 404 `not_found` when there is no such letter and `generate` is false, when `jobId`
 * is no job, and when `resumeId` is not one of the account's resumes.
 */
export const AutofillCoverLetterRequestSchema = z
  .object({
    /** The lookup's job, when TailorIT has the posting: the letter takes the job's (or the tracker entry's) company
     *  and title. */
    jobId: z.number().int().positive().optional(),
    /** The lookup's company and job title; without a `jobId`, the posting's own, and both required. */
    company: z.string().max(AUTOFILL_COVER_LETTER_LIMITS.company),
    jobTitle: z.string().max(AUTOFILL_COVER_LETTER_LIMITS.jobTitle),
    /** The job description the form's page shows (its visible text alone, page text): a letter written now is
     *  written from it, quoted to Claude as data; '' or absent, from the company and the title alone. */
    jobText: z.string().max(AUTOFILL_COVER_LETTER_LIMITS.jobText).optional(),
    /** The resume the fill attaches: a letter written now draws on it. */
    resumeId: z.string().min(1).max(64),
    /** Write a letter when the person has none for this job. */
    generate: z.boolean(),
    /** The page's tripwire tokens ("I am LLM"): a letter written now that holds one is not kept (its writing fails,
     *  so the letter reads `failed`). Absent: none. */
    canaries: z
      .array(z.string().min(2).max(AUTOFILL_COVER_LETTER_LIMITS.canary))
      .max(AUTOFILL_COVER_LETTER_LIMITS.canaries)
      .optional(),
  })
  .superRefine((request, ctx) => {
    if (request.jobId !== undefined) return;
    if (!request.company.trim()) ctx.addIssue({ code: 'custom', path: ['company'], message: 'Required' });
    if (!request.jobTitle.trim()) ctx.addIssue({ code: 'custom', path: ['jobTitle'], message: 'Required' });
  });
export type AutofillCoverLetterRequest = z.infer<typeof AutofillCoverLetterRequestSchema>;

/** POST /api/autofill/cover-letters's answer (200): the letter to upload, where it stands, and who wrote it. */
export const AutofillCoverLetterResponseSchema = z.object({
  letterId: AutofillCoverLetterIdSchema,
  state: z.enum(AUTOFILL_COVER_LETTER_STATES),
  /** TailorIT's AI wrote it: it is being written now, or the AI wrote it and the person has not edited it since.
   *  False for a letter the person wrote or edited. */
  aiWritten: z.boolean(),
});
export type AutofillCoverLetterResponse = z.infer<typeof AutofillCoverLetterResponseSchema>;

/** GET /api/autofill/cover-letters/:id (scope letters:write): where one of the account's letters stands. */
export const AutofillCoverLetterStatusSchema = z.object({ state: z.enum(AUTOFILL_COVER_LETTER_STATES) });
export type AutofillCoverLetterStatus = z.infer<typeof AutofillCoverLetterStatusSchema>;

/**
 * GET /api/autofill/cover-letters/:id/text (scope letters:write, version 3): a ready letter's words as plain text, for
 * a form that asks for the letter in a text box: its paragraphs one blank line apart, nothing else (no title, no
 * markup). Cache-Control: no-store. 409 `conflict` while the letter is not ready, as GET …/file.
 */
export const AutofillCoverLetterTextSchema = z.object({ text: z.string().min(1) });
export type AutofillCoverLetterText = z.infer<typeof AutofillCoverLetterTextSchema>;

/**
 * What the cover-letter routes refuse with, besides every token route's refusals (401, 403, 409 `conflict` for another
 * API version, 429), and the status of each: `validation_failed` (a body over a cap; no company or title without a
 * job), `not_found` (no letter to use, a job or a resume that is not there, another account's letter), `conflict`
 * (GET …/file of a letter that is not ready: still being written, or `failed`), `ai_busy` (two letters are being
 * written for the account already: wait for one), `ai_unavailable` (Claude is off, signed out or paused),
 * `file_too_large` (a PDF over AUTOFILL_COVER_LETTER_MAX_BYTES), `render_failed` and `browser_unavailable` (the print
 * failed, or this server has no browser to print with), and, version 8, `ai_usage_exhausted` (the person's AI usage
 * is used up until the daily reset).
 */
export const AUTOFILL_COVER_LETTER_REFUSALS = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  ai_busy: 409,
  ai_usage_exhausted: 429,
  file_too_large: 413,
  render_failed: 500,
  ai_unavailable: 503,
  browser_unavailable: 503,
} as const;
