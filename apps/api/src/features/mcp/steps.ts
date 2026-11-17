import { stepPreferences } from '../../ai/prompts/mcp/step-preferences';
import { uploadLetterText } from '../../ai/prompts/mcp/upload-cover-letter';
import { answersPromptText, noOpenQuestions, tooManyAnswerJobs, type AnswersJob } from '../../ai/prompts/mcp/write-answers';
import { AppError } from '../../core/http/errors';
import { readDraftFacts } from '../autofill/draft-facts';
import { coverLetterPrompt } from '../../ai/prompts/cover-letters/cover-letter';
import { resumeForPrompt } from '../cover-letters/resume-input';
import { readableForAi } from '../job-analysis/service';
import type { RawAnalysis } from '../tailor/keywords';
import { postingHashOf } from '../tailor/store';
import { chosenContent, chosenResume, type ChosenResume } from './chosen';
import { heldAnalysis, mcpJobOf, sourceProfile, type McpJob } from './job';
import { ANSWER_BATCH_JOBS, mcpPrepareOf, type PrepareStep } from './next';
import { openQuestions } from './questions';
import { NO_ANALYSIS, NO_DRAFT_TO_REVISE, NO_FIRST_PASS, RESUME_CHOSEN, TOO_LITTLE_POSTING, type SaveContext } from './save';
import { tripwireLine } from './screen';
import { mcpSettings } from './settings';
import { analyzePromptText, letterPromptText, reviewPromptText, revisePromptText, tailorPromptText } from './step-text';
import { workFor } from './work';

// v30 ST2: was step-prompts.ts; the prompts' words are the prompt catalogue's mcp area (ai/prompts/mcp), their values
// step-text.ts. This file picks the step, checks its gates and adds the person's preferences.
// v1.5 Q1: one Prepare step's prompt for one of the account's jobs (write_answers: up to three), rendered from
// tailor_builder0's prompts (ai/prompts/mcp) with the values TailorIT's own tailoring gives them, behind the same gates:
// review needs the saved first pass, tailor an analysis, revise a saved resume (and gives that round's issues), and
// answers need open questions. The tool prepare_prompt answers it as text, and the MCP prompts of the same names
// (server.ts) render it too, so a model that can only call tools reads exactly what a person inserting the prompt does.
// v2.0 P5: the letter and the answers are written from the job's chosen resume (DECISIONS A29: the tailored one, the
// default, or the most similar; an upload's letter from its text, with the editor's letter prompt), the resume steps
// are refused for a job that keeps a chosen resume, and every step's prompt ends with the person's custom instructions
// ("The person's preferences for this step", 07-mcp.md) when they have any.

/** The job, refused when its posting is too short to tailor to. */
async function readableJob(ctx: SaveContext, jobId: number): Promise<McpJob> {
  const job = await mcpJobOf(ctx.deps, ctx.userId, jobId);
  if (!readableForAi(job.posting)) throw new AppError('validation_failed', TOO_LITTLE_POSTING);
  return job;
}

/** The job's resume under its Prepare (the person's mode when none is active). */
const chosenOf = async (ctx: SaveContext, job: McpJob): Promise<ChosenResume> =>
  chosenResume(ctx, job, await mcpPrepareOf(ctx, job.applicationId));

/** The resume steps belong to a tailored resume: refused for a job that keeps a chosen one. */
async function tailoredJob(ctx: SaveContext, jobId: number): Promise<McpJob> {
  const job = await readableJob(ctx, jobId);
  if ((await chosenOf(ctx, job)).mode !== 'tailor') throw new AppError('conflict', RESUME_CHOSEN);
  return job;
}

/** The answers prompt's job: its open questions (refused when there is none), company, title and posting. */
async function answersJob(ctx: SaveContext, jobId: number): Promise<AnswersJob & { chosenId: string | null }> {
  const { deps, userId } = ctx;
  const job = await mcpJobOf(deps, userId, jobId);
  const questions = openQuestions(await ctx.prepare.questions(deps, userId, job.applicationId));
  if (questions.length === 0) {
    throw new AppError('validation_failed', noOpenQuestions(jobId));
  }
  return {
    jobId,
    questions,
    company: job.company,
    title: job.title,
    posting: job.posting,
    tripwire: tripwireLine((await workFor(deps, userId, jobId)).canary),
    chosenId: (await chosenOf(ctx, job)).id,
  };
}

/** The letter step: tailor_builder0's letter on a built resume; the editor's letter prompt on an upload's text. */
async function letterPrompt(ctx: SaveContext, job: McpJob): Promise<string> {
  const { deps, userId } = ctx;
  const content = await chosenContent(deps, userId, await chosenOf(ctx, job));
  const held = readableForAi(job.posting) ? await heldAnalysis(deps, userId, job) : null;
  if (content.built) return letterPromptText(job.jobId, content.built.profile, held?.analysis ?? null, job.company, job.title);
  const posting = job.posting.trim() ? `${job.posting}\n${tripwireLine((await workFor(deps, userId, job.jobId)).canary)}` : '';
  return uploadLetterText({
    jobId: job.jobId,
    module: coverLetterPrompt,
    input: {
      job: { companyName: job.company, jobTitle: job.title, jobDescription: posting },
      resume: resumeForPrompt(content.evidence),
      templatePrompt: content.coverLetterTemplate?.aiPrompt ?? '',
      customPrompt: '',
    },
  });
}

/** The step's prompt text for `jobIds` (one job; write_answers up to ANSWER_BATCH_JOBS). */
async function stepText(ctx: SaveContext, step: PrepareStep, ids: readonly number[]): Promise<string> {
  const { deps, userId } = ctx;
  const jobId = ids[0]!;
  switch (step) {
    case 'analyze': {
      const job = await readableJob(ctx, jobId);
      return analyzePromptText(jobId, job.posting, tripwireLine((await workFor(deps, userId, jobId)).canary));
    }
    case 'review': {
      const job = await readableJob(ctx, jobId);
      const work = await workFor(deps, userId, jobId);
      const first = work.postingHash === postingHashOf(job.posting) ? (work.analysisRaw as RawAnalysis | null) : null;
      if (!first) throw new AppError('validation_failed', NO_FIRST_PASS);
      return reviewPromptText(jobId, job.posting, tripwireLine(work.canary), first);
    }
    case 'tailor': {
      const job = await tailoredJob(ctx, jobId);
      const held = await heldAnalysis(deps, userId, job);
      if (!held) throw new AppError('validation_failed', NO_ANALYSIS);
      return tailorPromptText(jobId, (await sourceProfile(deps, userId)).profile, held.analysis);
    }
    case 'revise': {
      const job = await tailoredJob(ctx, jobId);
      const work = await workFor(deps, userId, jobId);
      const held = await heldAnalysis(deps, userId, job, work);
      if (!held) throw new AppError('validation_failed', NO_ANALYSIS);
      if (!work.draft) throw new AppError('validation_failed', NO_DRAFT_TO_REVISE);
      return revisePromptText(jobId, work.draft, held.analysis, (await sourceProfile(deps, userId)).profile, work.saves);
    }
    case 'write_cover_letter':
      return letterPrompt(ctx, await mcpJobOf(deps, userId, jobId));
    case 'write_answers': {
      const jobs: Array<Awaited<ReturnType<typeof answersJob>>> = [];
      for (const id of ids) jobs.push(await answersJob(ctx, id));
      const resumes = [...new Set(jobs.map((job) => job.chosenId))];
      const shared = await readDraftFacts(deps, userId, resumes[0] ?? null);
      // A29: one RESUME when the jobs share it; else each job's own (its facts read once per resume).
      if (resumes.length === 1) return answersPromptText(jobs, shared);
      const factsOf = new Map<string | null, string>();
      for (const id of resumes) factsOf.set(id, (await readDraftFacts(deps, userId, id)).resume);
      return answersPromptText(
        jobs.map((job) => ({ ...job, resume: factsOf.get(job.chosenId) ?? '' })),
        shared,
      );
    }
  }
}

/** The step's prompt text for `jobIds`, with the person's preferences for the step at its end when they have any. */
export async function stepPrompt(ctx: SaveContext, step: PrepareStep, jobIds: readonly number[]): Promise<string> {
  const ids = [...new Set(jobIds)];
  if (ids.length === 0) throw new AppError('validation_failed', 'jobId: expected a job id from prepare_queue.');
  if (step !== 'write_answers' && ids.length > 1) {
    throw new AppError('validation_failed', `jobIds: only the step "write_answers" takes several jobs; send one "jobId".`);
  }
  if (ids.length > ANSWER_BATCH_JOBS) {
    throw new AppError('validation_failed', tooManyAnswerJobs(ANSWER_BATCH_JOBS));
  }
  const text = await stepText(ctx, step, ids);
  const preferences = stepPreferences((await mcpSettings(ctx.deps, ctx.userId)).customInstructions);
  return preferences ? `${text}\n\n${preferences}` : text;
}
