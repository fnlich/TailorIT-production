import { z } from 'zod';
import {
  aiVariablesIn,
  buildContactLine,
  composeLetterHtml,
  findPlaceholders,
  formatLongDate,
  htmlToText,
  isAiVariable,
  letterVariableValues,
  substituteVariables,
  type CoverLetterGenerateResult,
  type LetterProfile,
  type RoleFamilyId,
} from '@tailorit/shared';
import { AUTOFILL_COVER_LETTER_LIMITS } from '@tailorit/shared/autofill';
import { requireAi, type AiTaskContext } from '../../ai/index';
import { taskInputSql } from '../../ai/payloads';
import type { PersonPayer } from '../../core/accounts/payer'; // v33 SHARE-3 (INT-1: a person's)
import type { Dialect } from '../../core/db/dialect';
import type { AppDeps } from '../../core/context';
import { AppError, notFound, validationFailed } from '../../core/http/errors';
import { LETTER_NOT_KEPT, letterContacts, letterProblem } from '../autofill/ai/letter';
import { getResumeEvidence, type ResumeEvidence } from '../resumes/evidence';
import { writtenFamily } from '../tailor/family'; // v33 PROMPTS
import { letterProfile, requireVisibleTemplate, visibleTemplate, type TemplateRecord } from './context';
import { coverLetterPrompt } from '../../ai/prompts/cover-letters/cover-letter';
import type { LetterJobInput } from '../../ai/prompts/cover-letters/letter-rules';
import { templateFillPrompt } from '../../ai/prompts/cover-letters/template-fill';
import { refuse } from '../../core/http/refuse';
import { createLetterRepository, type LetterRepository } from './repository';
import { resumeForPrompt } from './resume-input';
import { sanitizeLetterHtml } from './sanitize';
import { tidyAiText } from './tidy';

// The two generation tasks. Both read the person's resume (the default one unless the request names another), write
// the letter's content, mark it "Generated" and answer { html, placeholders } for the editor. Generation is not an
// edit by the person, so "Last Edited" stays as it was. A letter the extension asked for (`page` and `onlyIfEmpty` in
// the input: autofill/cover-letters.ts) is written from page text and checked before it is stored (autofill/ai/
// letter.ts), and only into a letter that is still empty then: a letter that may not be written keeps what it has,
// and the task fails.

export const NO_RESUME_MESSAGE = 'Add a resume in Documents first, so the letter has your experience to draw on.';

/** What POST /:id/generate queues (validated again when the task runs: it is read back from the database). */
export const GenerateTaskInputSchema = z.object({
  letterId: z.string().min(1),
  companyName: z.string(),
  jobTitle: z.string(),
  jobDescription: z.string(),
  templateId: z.string().nullable(),
  customPrompt: z.string(),
  resumeId: z.string().nullable().optional(),
  /**
   * Set when the extension asked for the letter (POST /api/autofill/cover-letters): the job is page text, quoted to
   * Claude as data, and the page's canaries (its tripwire tokens) are what the answer must not hold.
   */
  page: z
    .object({
      canaries: z
        .array(z.string().max(AUTOFILL_COVER_LETTER_LIMITS.canary))
        .max(AUTOFILL_COVER_LETTER_LIMITS.canaries),
    })
    .optional(),
  /** Writes only into a letter still empty when the writing ends, so what the person typed meanwhile stays. */
  onlyIfEmpty: z.boolean().optional(),
});
export type GenerateTaskInput = z.infer<typeof GenerateTaskInputSchema>;

/**
 * v33 PROMPTS (F5): the field a letter is written in: the resume's (its Field, else what TailorIT read from it), else
 * the job's, read from its title (a letter's job may be only a company and a title).
 */
const letterFamily = (deps: AppDeps, userId: string, resumeId: string, jobTitle: string): Promise<RoleFamilyId> =>
  writtenFamily(deps, userId, resumeId, { title: jobTitle });

/** A task's failure when the person wrote the letter while it was being written (`onlyIfEmpty`). */
export const WRITTEN_MEANWHILE = 'This cover letter was written in the meantime, so it was kept as it is.';

export function noResumeError(): AppError {
  return validationFailed(NO_RESUME_MESSAGE, { resume: NO_RESUME_MESSAGE });
}

/** The evidence, or the failure: "that resume" was not found, or there is no resume at all. */
function evidenceOrRefusal(evidence: ResumeEvidence | null, resumeId?: string | null): ResumeEvidence {
  if (!evidence) {
    if (resumeId) throw notFound('That resume');
    throw noResumeError();
  }
  return evidence;
}

/** The resume the letter draws on, or the "add a resume first" failure. */
export async function requireEvidence(deps: Pick<AppDeps, 'db'>, userId: string, resumeId?: string | null): Promise<ResumeEvidence> {
  return evidenceOrRefusal(await getResumeEvidence(deps, userId, resumeId ?? undefined), resumeId);
}

/** Whether a template has anything to fill: an empty one means "write the whole letter, guided by its AI prompt". */
export function templateHasContent(contentHtml: string): boolean {
  return htmlToText(contentHtml).trim() !== '';
}

/** The kinds that write a letter. */
const GENERATION_KINDS = ['cover_letter', 'template_fill'] as const;

/**
 * Queues a letter's writing (the editor's Generate, and the extension's POST /api/autofill/cover-letters): a template
 * with content is filled (`template_fill`), else the whole letter is written (`cover_letter`, with an empty
 * template's AI prompt and font). One at a time per letter: asked again while it runs, the queue answers the same
 * task (both callers ask only when generationInFlight says none runs: the editor's route answers 409 then, the
 * extension's the letter being written). Throws the queue's refusals (`ai_unavailable`, `ai_busy`, a hold).
 * v33 SHARE-3 (PLAN F9 "Who pays"): `payer` pays (B on A's letter: payerOf(req); v33 INT-1: required). A letter is
 * one row, so its writing is one task whoever pays: while one person's writing of it is live, another person's ask is
 * refused (409 conflict, MSG_LETTER_BEING_WRITTEN: the queue's SHARED_ROW_KINDS), never joined to work someone else
 * pays for.
 */
export async function startGeneration(
  deps: AppDeps,
  userId: string,
  input: GenerateTaskInput,
  template: TemplateRecord | null,
  payer: PersonPayer, // v33 INT-1: required
): Promise<{ taskId: string; deduped: boolean }> {
  return requireAi(deps).enqueue({
    kind: generationKind(template),
    userId,
    input,
    dedupeKey: `cover-letter:${input.letterId}`,
    chargeTo: payer, // v33 SHARE-3; INT-1: always named
  });
}

/** `template_fill` for a template with content; else `cover_letter`. */
function generationKind(template: TemplateRecord | null): 'template_fill' | 'cover_letter' {
  return template && templateHasContent(template.contentHtml) ? 'template_fill' : 'cover_letter';
}

/** A writing task for the letter, queued or running (`jsonText`: the input's letter id, as text on both engines). */
function inFlightSql(d: Dialect): string {
  return `SELECT 1 FROM ai_tasks WHERE user_id = ? AND kind IN (${GENERATION_KINDS.map(() => '?').join(', ')})
         AND status IN ('queued', 'running') AND ${d.jsonText(taskInputSql(d), '$.letterId')} = ? LIMIT 1`;
}

/** Whether one of the account's letters is being written now: a writing task for it is queued or running. */
export async function generationInFlight(deps: Pick<AppDeps, 'db'>, userId: string, letterId: string): Promise<boolean> {
  const row = await deps.db.one(inFlightSql(deps.db.dialect), [userId, ...GENERATION_KINDS, letterId]);
  return row !== undefined;
}

function stopIfCancelled(deps: AppDeps, signal: AbortSignal): void {
  if (signal.aborted) throw refuse(deps, 'ai_failed', 'MSG_AI_CANCELLED');
}

/** A writing task's stored input, read when it runs (cover-letters/tasks.ts: both kinds' `parse`). */
export function readGenerateTaskInput(input: unknown): GenerateTaskInput {
  const parsed = GenerateTaskInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('ai_failed', 'This AI request could not be read. Please try again.');
  return parsed.data;
}

function userOfTask(ctx: AiTaskContext): string {
  if (!ctx.userId) throw notFound('That cover letter');
  return ctx.userId;
}

/** The job as the prompts read it: page text when the extension asked for the letter. */
function jobOf(input: GenerateTaskInput): LetterJobInput {
  const job = { companyName: input.companyName, jobTitle: input.jobTitle, jobDescription: input.jobDescription };
  return input.page ? { ...job, pageText: true } : job;
}

/**
 * For a letter written from page text: hears every reply, for the checks (held here only, never stored or logged),
 * and checks the answer, so a letter that fails is never kept (autofill/ai/letter.ts). Nothing for the editor's own
 * Generate.
 */
function pageCheck(deps: AppDeps, input: GenerateTaskInput, ctx: AiTaskContext) {
  const replies: string[] = [];
  return {
    options: input.page ? { onReply: (text: string) => void replies.push(text) } : {},
    check(answer: unknown, profile: LetterProfile): void {
      if (!input.page) return;
      const contacts = letterContacts(profile);
      const problem = letterProblem(answer, replies, { canaries: input.page.canaries, contacts });
      if (!problem) return;
      deps.log.debug(`[autofill] cover letter task ${ctx.taskId}: not kept (${problem})`);
      throw new AppError('ai_failed', LETTER_NOT_KEPT);
    },
  };
}

/** With `onlyIfEmpty`, the letter must still have no text: what the person typed meanwhile is never written over. */
async function requireStillEmpty(letters: LetterRepository, input: GenerateTaskInput, userId: string): Promise<void> {
  if (!input.onlyIfEmpty) return;
  const row = await letters.require(input.letterId, userId);
  if (row.content_text.trim() !== '') throw new AppError('ai_failed', WRITTEN_MEANWHILE);
}

/** The deterministic variables' values (Profile, Dynamic and Structural) of a letter about this job. */
function templateValues(
  profile: LetterProfile,
  job: Pick<GenerateTaskInput, 'companyName' | 'jobTitle'>,
  today: Date,
): Record<string, string> {
  return letterVariableValues({
    profile,
    job: { companyName: job.companyName, jobTitle: job.jobTitle, hiringManager: null },
    today,
  });
}

/**
 * The template's own variables (not the AI's) that a fill would leave as `{{NAME}}`: no value from the person's
 * profile, the job or the date (a phone the person never gave, a name the registry does not know).
 */
export function unfilledVariables(
  template: Pick<TemplateRecord, 'contentHtml'>,
  profile: LetterProfile,
  job: Pick<GenerateTaskInput, 'companyName' | 'jobTitle'>,
  today: Date,
): string[] {
  const values = templateValues(profile, job, today);
  return findPlaceholders(template.contentHtml).filter((name) => !isAiVariable(name) && !values[name]);
}

/** `cover_letter`: AI body paragraphs in the name / contact line / greeting / sign-off wrapper. */
export async function generateWithoutTemplate(
  deps: AppDeps,
  input: GenerateTaskInput,
  ctx: AiTaskContext,
): Promise<CoverLetterGenerateResult> {
  const userId = userOfTask(ctx);
  const letters = createLetterRepository(deps);
  await letters.require(input.letterId, userId);
  const evidence = await requireEvidence(deps, userId, input.resumeId);
  // An empty template contributes its AI prompt (and its font) only.
  const template = input.templateId ? await visibleTemplate(deps, userId, input.templateId) : null;
  const page = pageCheck(deps, input, ctx);

  const answer = await ctx.runPrompt(
    coverLetterPrompt,
    {
      job: jobOf(input),
      resume: resumeForPrompt(evidence),
      templatePrompt: template?.aiPrompt ?? '',
      customPrompt: input.customPrompt,
      family: await letterFamily(deps, userId, evidence.resumeId, input.jobTitle),
    },
    page.options,
  );
  const profile = letterProfile(evidence);
  page.check(answer, profile);
  const paragraphs = answer.paragraphs
    .flatMap((paragraph) => tidyAiText(paragraph).split(/\n\s*\n/))
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const html = sanitizeLetterHtml(
    composeLetterHtml({ name: profile.fullName, contactLine: buildContactLine(profile), paragraphs }),
  );

  stopIfCancelled(deps, ctx.signal);
  await requireStillEmpty(letters, input, userId);
  await letters.update(input.letterId, userId, {
    contentHtml: html,
    origin: 'generated',
    templateId: template?.id ?? null,
    resumeId: evidence.resumeId,
    ...(template ? { fontFamily: template.fontFamily } : {}),
  });
  return { html, placeholders: findPlaceholders(html) };
}

/**
 * `template_fill`: Profile, Dynamic and Structural variables substituted from the resume, Settings and the job; one
 * AI call writes the AI variables the template uses. Anything still without a value stays `{{NAME}}` for the
 * "Almost there" banner.
 */
export async function generateFromTemplate(
  deps: AppDeps,
  input: GenerateTaskInput,
  ctx: AiTaskContext,
): Promise<CoverLetterGenerateResult> {
  const userId = userOfTask(ctx);
  const letters = createLetterRepository(deps);
  await letters.require(input.letterId, userId);
  if (!input.templateId) throw new AppError('ai_failed', 'Choose a template, then try again.');
  const template = await requireVisibleTemplate(deps, userId, input.templateId);
  const evidence = await requireEvidence(deps, userId, input.resumeId);
  const profile = letterProfile(evidence);
  const today = deps.now();
  const page = pageCheck(deps, input, ctx);

  const values = templateValues(profile, input, today);
  const aiNames = aiVariablesIn(template.contentHtml);
  if (aiNames.length > 0) {
    const answer = await ctx.runPrompt(
      templateFillPrompt,
      {
        job: jobOf(input),
        resume: resumeForPrompt(evidence),
        templatePrompt: template.aiPrompt,
        customPrompt: input.customPrompt,
        templateText: htmlToText(template.contentHtml),
        names: aiNames,
        personName: profile.fullName,
        today: formatLongDate(today),
        family: await letterFamily(deps, userId, evidence.resumeId, input.jobTitle),
      },
      page.options,
    );
    page.check(answer, profile);
    for (const name of aiNames) {
      const value = answer.values[name];
      if (typeof value === 'string' && value.trim()) values[name] = tidyAiText(value);
    }
  }
  const html = sanitizeLetterHtml(substituteVariables(template.contentHtml, values));

  stopIfCancelled(deps, ctx.signal);
  await requireStillEmpty(letters, input, userId);
  await letters.update(input.letterId, userId, {
    contentHtml: html,
    origin: 'generated',
    templateId: template.id,
    resumeId: evidence.resumeId,
    fontFamily: template.fontFamily,
  });
  return { html, placeholders: findPlaceholders(html) };
}
