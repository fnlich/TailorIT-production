import { RESUME_TEMPLATES } from '@tailorit/shared';
import type { McpPromptMode } from '@tailorit/shared/mcp';
import { POSTING_TEXT_RULE } from '../../ai/prompts/tailor/posting-text-rule';
import { AppError } from '../../core/http/errors';
import { untrustedBlock, untrustedText } from '../autofill/ai/untrusted';
import { readDraftFacts } from '../autofill/draft-facts';
import { readableForAi } from '../job-analysis/service';
import { profileForPrompt } from '../tailor/pipeline';
import { chooseTemplates } from '../tailor/source';
import { chosenContent, chosenResume, NO_CHOSEN_RESUME } from './chosen';
import { rulesPointer } from './instructions';
import { heldAnalysis, mcpJobOf, sourceProfile, type SourceProfile } from './job';
import { finishedView, finishIfDone, howTo, mcpPrepareOf, nextAfterSave, nextJob, nextStep } from './next';
import { openQuestions, questionView } from './questions';
import { modeOf, RESUME_CHOSEN, requireMcpPrepare, type SaveContext } from './save';
import { tripwireLine } from './screen';
import { mcpSettings } from './settings';
import { postingForPrompt } from './step-text';
import { workFor } from './work';

// The read tools of TailorIT's MCP server (v1.5 M): prepare_queue, prepare_job_context and prepare_mark. The save
// tools are save.ts. Each reads and writes the token's account alone. What a tool answers is data for the person's AI:
// the posting in its <untrusted> wrapper, the resume as the tailoring prompts read it (no name, no contact details),
// the job's open questions and the facts TailorIT's own answer prompt quotes (never the profile's sensitive part, never
// the person's contact details, never a held-back question).
// v1.5 Q1, for the tokens a person's AI spends (an account may have thousands of Saved jobs): the queue answers a page
// at a time as a compact table, with the howTo; the context leaves out the posting, the resume and the facts unless
// asked (TailorIT's prompts quote them already), and gives the keyword plan as rows.
// v2.0 P5: prepare_queue lists the person's `mcp` Prepares waiting for their AI (prepare_start starts them); the
// context gains the letter decision, the questions known, the active Prepare and the job's resume as the person's
// resume mode chose it (A29), and a `fields` list; prepare_mark ends the Prepare when it marks a required part.

/** The refusals a source resume can give, which the context reports instead of failing. */
const SOURCE_REFUSALS = new Set(['needs_editable_copy', 'validation_failed', 'not_found']);

/** The queue's page size by default, and at most. */
export const QUEUE_PAGE = { default: 25, max: 100 } as const;
const QUEUE_COLUMNS = ['id', 'job', 'title', 'company', 'resume', 'letter', 'answers'] as const;

/** The most characters of an upload's text the context gives. */
const UPLOAD_TEXT_MAX = 20_000;

/** prepare_job_context's top-level fields a `fields` list may name. */
export const CONTEXT_FIELDS = [
  'company',
  'title',
  'prepare',
  'posting',
  'tailorable',
  'keywordAnalysis',
  'resume',
  'resumeProblem',
  'templates',
  'letter',
  'questionsKnown',
  'questions',
  'heldBackQuestions',
  'facts',
  'saved',
] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];

/** A cursor: the offset of the page's first job, as a string of digits. */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,7}$/.test(cursor)) throw new AppError('validation_failed', 'cursor: expected the nextCursor of the last page.');
  return Number(cursor);
}

/** prepare_queue: the jobs waiting for the person's AI, a page at a time. */
export async function prepareQueue(ctx: SaveContext, options: { limit?: number; cursor?: string }) {
  const { deps, userId } = ctx;
  const offset = offsetOf(options.cursor);
  const limit = Math.min(Math.max(options.limit ?? QUEUE_PAGE.default, 1), QUEUE_PAGE.max);
  const waiting = await ctx.prepare.waiting(deps, userId);
  const page = waiting.slice(offset, offset + limit);
  const rows: unknown[][] = [];
  for (const { prepare, jobId, title, company, parts } of page) {
    const letter = await ctx.prepare.letter(deps, userId, { applicationId: prepare.applicationId, jobId }, prepare);
    rows.push([
      prepare.id,
      jobId,
      untrustedText(title, 200),
      untrustedText(company, 200),
      // A29: a job that keeps a chosen resume shows its mode; a tailored one, its part's state.
      prepare.resumeMode === 'tailor' ? (parts?.resumeStatus ?? 'pending') : prepare.resumeMode,
      letter.wanted ? (parts?.letterStatus === 'off' ? 'pending' : (parts?.letterStatus ?? 'pending')) : 'off',
      parts?.answersStatus ?? 'pending',
    ]);
  }
  const settings = await mcpSettings(deps, userId);
  return {
    total: waiting.length,
    cols: QUEUE_COLUMNS,
    rows,
    nextCursor: offset + limit < waiting.length ? String(offset + limit) : null,
    // Once, with the first page.
    ...(offset === 0 ? { howTo: howTo(settings, await ctx.prepare.resumeMode(deps, userId)) } : {}),
    ...(await rulesPointer(deps, userId, ctx.tokenId ?? null)),
    next:
      waiting.length > 0
        ? `Call prepare_job_context with {"jobId": ${waiting[0]!.jobId}}, then follow each answer's "next".`
        : 'No job waits for your AI. Start with filter_jobs {"scope": "saved"}, then prepare_start {"runId": <its runId>}.',
  };
}

export async function jobContext(
  ctx: SaveContext,
  jobId: number,
  options: { includePosting?: boolean; includeResume?: boolean; mode?: McpPromptMode; fields?: readonly ContextField[] } = {},
) {
  const { deps, userId } = ctx;
  const job = await mcpJobOf(deps, userId, jobId);
  const work = await workFor(deps, userId, jobId);
  const active = await ctx.prepare.active(deps, userId, job.applicationId);
  const prepare = active?.mode === 'mcp' ? active : null;
  const chosen = await chosenResume(ctx, job, prepare);
  // The source is read for a tailored resume only: the default and similar modes keep a resume as it is.
  let source: SourceProfile | null = null;
  let resumeProblem: string | null = null;
  if (chosen.mode === 'tailor') {
    try {
      source = await sourceProfile(deps, userId);
    } catch (error) {
      if (!(error instanceof AppError && SOURCE_REFUSALS.has(error.code))) throw error;
      resumeProblem = error.message;
    }
  } else if (!chosen.id) {
    resumeProblem = NO_CHOSEN_RESUME;
  }
  const tailorable = readableForAi(job.posting);
  const held = tailorable ? await heldAnalysis(deps, userId, job, work) : null;
  const known = await ctx.prepare.questions(deps, userId, job.applicationId);
  const open = openQuestions(known);
  const letter = await ctx.prepare.letter(deps, userId, job, prepare);
  const facts = options.includeResume && chosen.id ? await readDraftFacts(deps, userId, chosen.id) : null;
  const letterTemplate = (await chooseTemplates(deps, userId, {})).coverLetterTemplate;

  /** The chosen resume's words for the person's own prompts: a built resume as profile JSON, an upload's text. */
  const resumeContent = async () => {
    if (!options.includeResume || !chosen.id) return {};
    try {
      const content = await chosenContent(deps, userId, chosen);
      return content.built
        ? { profile: JSON.parse(profileForPrompt(content.built.profile)) as unknown }
        : { text: untrustedBlock(content.evidence.text, UPLOAD_TEXT_MAX) };
    } catch (error) {
      if (error instanceof AppError && error.status < 500) return {};
      throw error;
    }
  };

  const all = {
    company: untrustedText(job.company, 200),
    title: untrustedText(job.title, 200),
    prepare: prepare ? { id: prepare.id, state: prepare.state } : null,
    // The posting only on request: TailorIT's prompts quote it (with the tripwire) already.
    ...(options.includePosting
      ? {
          posting: job.posting.trim()
            ? { untrusted: true, rule: POSTING_TEXT_RULE, text: postingForPrompt(job.posting, tripwireLine(work.canary)) }
            : null,
        }
      : {}),
    tailorable,
    keywordAnalysis: held
      ? {
          madeBy: held.madeBy,
          title: held.analysis.jobMeta.title,
          /** [term, type, kind, priority] rows. */
          keywords: (held.analysis.atsKeywords ?? []).map((k) => [k.term, k.type, k.kind, k.priority ?? 'strong']),
          responsibilities: held.analysis.responsibilities,
          mustInclude: held.analysis.keywords.mustInclude,
        }
      : null,
    /**
     * A29: the resume this application uses, chosen by the resume mode; the letter and the answers are written from
     * it. `tailor`: the tailored one once saved (`tailored`), made from `sourceId`.
     */
    resume: {
      mode: chosen.mode,
      id: chosen.id,
      ...(chosen.mode === 'tailor' ? { sourceId: chosen.sourceId ?? null, tailored: chosen.tailored === true } : {}),
      ...(await resumeContent()),
    },
    resumeProblem,
    templates: {
      resume:
        chosen.mode === 'tailor' && source ? { id: source.templateId, name: RESUME_TEMPLATES[source.templateId].name } : null,
      coverLetter: letterTemplate ? { id: letterTemplate.id, name: letterTemplate.name } : null,
    },
    letter,
    questionsKnown: known.length,
    questions: open.map(questionView),
    /** Known questions the profile (or the person) answers on the form: never shown here. */
    heldBackQuestions: known.length - open.length,
    ...(facts ? { facts: { resume: facts.resume, profile: facts.profile, note: facts.note } } : {}),
    saved: { resumeId: work.resumeId, coverLetterId: work.coverLetterId, resumeSaves: work.saves },
  };
  const kept =
    options.fields && options.fields.length > 0
      ? Object.fromEntries(Object.entries(all).filter(([key]) => options.fields!.includes(key as ContextField)))
      : all;
  return { jobId, ...kept, next: await nextStep(ctx, job, await modeOf(ctx, options.mode)) };
}

export async function markJob(
  ctx: SaveContext,
  jobId: number,
  input: { status: 'failed' | 'skipped'; reason: string; part?: 'resume' | 'letter' | 'answers' | 'all' },
  mode?: McpPromptMode,
) {
  const { deps, userId } = ctx;
  const job = await mcpJobOf(deps, userId, jobId);
  const prepare = await requireMcpPrepare(ctx, job);
  const part = input.part ?? 'all';
  if (part === 'resume' && prepare.resumeMode !== 'tailor') throw new AppError('conflict', RESUME_CHOSEN);
  // A required part (the tailored resume, a wanted letter) marked ends the Prepare: its kit cannot be complete.
  const required =
    part === 'all' || part === 'resume' || (part === 'letter' && (await ctx.prepare.letter(deps, userId, job, prepare)).wanted);
  await ctx.prepare.mark(deps, userId, job.applicationId, input.status, input.reason, part);
  if (required) {
    // P2's markDraft ends the Prepare itself (skipped: cancelled; failed: failed); one still active is cancelled.
    if ((await mcpPrepareOf(ctx, job.applicationId))?.id === prepare.id) await ctx.prepare.cancel(deps, userId, prepare.id);
    return { jobId, status: input.status, ...(part === 'all' ? {} : { part }), cancelled: true, next: await nextJob(ctx, jobId) };
  }
  const finished = await finishIfDone(ctx, job);
  return {
    jobId,
    status: input.status,
    part,
    ...finishedView(finished),
    next: await nextAfterSave(ctx, job, await modeOf(ctx, mode), finished),
  };
}
