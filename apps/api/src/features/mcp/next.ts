import type { McpPromptMode, McpSettings } from '@tailorit/shared/mcp';
import type { PrepareResumeMode } from '@tailorit/shared/prepare';
import { readableForAi } from '../job-analysis/service';
import { heldAnalysis, type McpJob } from './job';
import type { DraftParts, Finished, McpPrepare } from './prepare';
import { openQuestions } from './questions';
import type { SaveContext } from './save';

// The order a Prepare job's steps go in, as the MCP tools say it to the person's AI (v1.5 Q1, the MCP fix). An AI
// client can only call tools: MCP prompts are the person's to insert (a slash command, a + menu), and the model cannot
// fetch one. So each of tailor_builder0's prompts is also the tool prepare_prompt, and every answer names the exact
// next call: prepare_queue's howTo, the context's next, and each save's next. In the person's own prompt mode
// (prepare_settings, or a save's mode), the next steps say what to write and save instead, with the shape each save
// takes; every save normalizes it to TailorIT's structure either way.
// v2.0 P5: the steps belong to a Prepare started by prepare_start (mode `mcp`). Its resume mode (DECISIONS A29) decides
// whether there are resume steps at all: `default` and `similar` keep the resume TailorIT chose, and only the letter
// (when wanted) and the answers (when questions are known) are written, from that resume. A job is queued by the save
// that completes its kit (finishIfDone).

/** The steps prepare_prompt renders a prompt for, in the order a job takes them. */
export const PREPARE_STEPS = ['analyze', 'review', 'tailor', 'revise', 'write_cover_letter', 'write_answers'] as const;
export type PrepareStep = (typeof PREPARE_STEPS)[number];

/** The most jobs one write_answers prompt (and one prepare_save_answers call) takes. */
export const ANSWER_BATCH_JOBS = 3;

// v33 SHARE-8 (PLAN-sharing.md §7): once the caller works on more than one profile, every next call names its profile
// (`hint`: "me" or the key; null keeps the one-profile words).
/** A call's job argument, with the profile it works on when the caller has more than one. */
export const jobArg = (jobId: number, hint: string | null = null) => `"jobId": ${jobId}${hint ? `, "profile": "${hint}"` : ''}`;

/** The tool call that gets a step's prompt for a job. */
export const promptCall = (jobId: number, step: PrepareStep, hint: string | null = null) =>
  `prepare_prompt with {${jobArg(jobId, hint)}, "step": "${step}"}`;

const OWN = {
  analysis:
    '{"keywords": [[term, "hard"|"soft", "tool"|"competency"|"certification"|"soft", "must_have"|"strong"|' +
    '"nice_to_have"], ...], "title", "responsibilities": [...], "mustInclude": [...]} (only keywords is required; each ' +
    'term exactly as the posting writes it)',
  resume:
    '{"summary", "experience": [{"company", "title", "description", "achievements": [...]}], "hardSkills": [...], ' +
    '"softSkills": [...], "strengths": [{"title", "description"}]}, one experience entry per role of the resume, with ' +
    'its company and title as the resume has them',
  revision: 'the whole resume again, or {"summary", "edits": [{"company", "title", "bullet": <n, or 0 to add>, "text"}]}',
  letter: '"paragraphs": 2 to 4 paragraphs of the body (no greeting, no sign-off), or "letter": the body as one text',
};

/** prepare_queue's howTo: both modes, the steps of one job with the tools, in order. */
export function howTo(settings: McpSettings, resumeMode: PrepareResumeMode): string[] {
  return [
    'Take the jobs one at a time. Start each with prepare_job_context {"jobId"}; every answer\'s "next" names the ' +
      'call that comes next. TailorIT queues a job when the save that completes it is done.',
    `Prompts: ${settings.promptMode === 'own-prompt' ? 'your own' : "TailorIT's"} (set_prepare_settings {"mode": ` +
      '"tailorit"|"own-prompt"} changes it; a save may also say "mode"). Resume mode: ' +
      `${resumeMode} (the person's setting; each job's context names its resume, and its letter and answers are ` +
      'written from that resume).',
    'TailorIT\'s prompts: prepare_prompt {"jobId", "step"} gives each step\'s prompt, which says what JSON to write ' +
      'and the tool that saves it. Steps: analyze -> prepare_save_analysis ' +
      '{"analysis"}; review -> prepare_save_analysis {"missing"}; tailor -> prepare_save_resume {"resume"}; revise ' +
      `(while a save answers "revise": true, at most ${settings.reviseRounds} rounds) -> prepare_save_resume ` +
      '{"revision"}; write_cover_letter -> prepare_save_cover_letter {"paragraphs"}; write_answers -> ' +
      'prepare_save_answers {"answers"}. A context with a keywordAnalysis starts at tailor; a job whose resume mode is ' +
      'default or similar has no resume steps.',
    'Your own prompts: the same saves in the same order, written your way. prepare_job_context with ' +
      '"includePosting": true and "includeResume": true gives the posting, the resume and the facts. TailorIT ' +
      'normalizes every save strictly (keywords, roles matched to the resume\'s, 2 to 4 letter paragraphs, option ' +
      'labels) and refuses, with the field and the shape, what it cannot read.',
    `Tokens: write_answers takes up to ${ANSWER_BATCH_JOBS} jobs at once ({"jobIds": [...]}), saved with one ` +
      'prepare_save_answers {"jobs": [{"jobId", "answers"}]}.',
    'A job that cannot be done (a tool refuses twice): prepare_mark {"jobId", "status": "failed" or "skipped", ' +
      '"reason"}, then the next job.',
  ];
}

const isOpen = (status: DraftParts['resumeStatus'] | undefined) => status === undefined || status === 'pending' || status === 'building';
/** A wanted letter still to write: anything but ready (an `off` letter that is now wanted is written too). */
const letterOpen = (status: DraftParts['letterStatus'] | undefined) => status !== 'ready' && status !== 'skipped';

/**
 * The application's active Prepare when it is the person's AI's (mode `mcp`). v33 SHARE-8 (PLAN-sharing.md §7): and the
 * caller started it (started_by): another person's AI's Prepare of the job is never this AI's to save into.
 */
export async function mcpPrepareOf(ctx: SaveContext, applicationId: string): Promise<McpPrepare | null> {
  const prepare = await ctx.prepare.active(ctx.deps, ctx.userId, applicationId);
  return prepare?.mode === 'mcp' && prepare.startedBy === ctx.caller.id ? prepare : null;
}

/** The call after a job is done: the next job waiting for the person's AI, else the end of the queue. */
export async function nextJob(ctx: SaveContext, jobId: number): Promise<string> {
  const others = (await ctx.prepare.waiting(ctx.deps, ctx.userId, ctx.caller.id)).filter((job) => job.jobId !== jobId);
  const next = others[0];
  // v33 SHARE-8: on several profiles, the queue across them says what is left.
  if (!next && ctx.hint) {
    return 'This job is done. Call prepare_queue for the jobs still waiting on every profile; when none is left, tell ' +
      'the person how many jobs were prepared and queued on each profile, and which failed and why.';
  }
  return next
    ? `This job is done (${others.length} job${others.length === 1 ? '' : 's'} left). Next job: call ` +
        `prepare_job_context with {${jobArg(next.jobId, ctx.hint)}}.`
    : 'This job is done and no other job waits for your AI: tell the person how many jobs were prepared and ' +
        'queued, and which failed and why.';
}

/** What a job's kit still needs: each part's state under its Prepare. */
export interface KitState {
  prepare: McpPrepare;
  parts: DraftParts | null;
  resumeDone: boolean;
  letter: { wanted: boolean; done: boolean };
  /** Open questions (the ones the AI may answer). */
  openQuestions: number;
  answersDone: boolean;
}

export async function kitState(ctx: SaveContext, job: McpJob, prepare: McpPrepare): Promise<KitState> {
  const { deps, userId } = ctx;
  const parts = await ctx.prepare.draft(deps, userId, job.applicationId);
  const letter = await ctx.prepare.letter(deps, userId, job, prepare);
  const open = openQuestions(await ctx.prepare.questions(deps, userId, job.applicationId)).length;
  return {
    prepare,
    parts,
    resumeDone: prepare.resumeMode !== 'tailor' || parts?.resumeStatus === 'ready',
    letter: { wanted: letter.wanted, done: !letter.wanted || !letterOpen(parts?.letterStatus) },
    openQuestions: open,
    answersDone: open === 0 || !isOpen(parts?.answersStatus),
  };
}

/**
 * After every save and mark: P2's finishIfComplete queues the job once no part of its kit is open (the resume, the
 * letter when wanted, the answers: A30's freeze holds them all). A job with no open question has its answers settled
 * here once the rest is done (none to write), so the person's AI makes no empty call for them.
 */
export async function finishIfDone(ctx: SaveContext, job: McpJob): Promise<Finished> {
  const prepare = await mcpPrepareOf(ctx, job.applicationId);
  if (!prepare) return { queued: false, queueFull: false };
  const state = await kitState(ctx, job, prepare);
  if (state.resumeDone && state.letter.done && state.openQuestions === 0 && isOpen(state.parts?.answersStatus)) {
    await ctx.prepare.saveAnswers(ctx.deps, ctx.userId, job.applicationId, [], ctx.caller.id);
  }
  return ctx.prepare.finish(ctx.deps, ctx.userId, job.applicationId, ctx.caller.id);
}

/** The next call after a save: the next job once this one is finished (queued, or kept prepared), else its next step. */
export async function nextAfterSave(ctx: SaveContext, job: McpJob, mode: McpPromptMode, finished: Finished): Promise<string> {
  if (finished.queueFull) {
    return 'The auto-apply queue is full, so this job is kept prepared, not queued: tell the person to clear finished ' +
      `jobs and prepare it again. ${await nextJob(ctx, job.jobId)}`;
  }
  return finished.queued ? nextJob(ctx, job.jobId) : nextStep(ctx, job, mode);
}

/** A save's answer about the queue: `queued: true`, or `queueFull: true` with the job kept prepared. */
export function finishedView(finished: Finished): { queued: boolean; queueFull?: true } {
  return { queued: finished.queued, ...(finished.queueFull ? { queueFull: true } : {}) };
}

/**
 * The exact next call for a job, from what its kit still waits for: the resume (the analysis first when TailorIT
 * holds none; none in the default and similar resume modes), the cover letter when wanted, the answers when there are
 * questions to answer, then the next job. A job with no Prepare for the person's AI says how to start one.
 */
export async function nextStep(ctx: SaveContext, job: McpJob, mode: McpPromptMode): Promise<string> {
  const { deps, userId } = ctx;
  const { jobId } = job;
  const hint = ctx.hint;
  const prepare = await mcpPrepareOf(ctx, job.applicationId);
  if (!prepare) {
    const active = await ctx.prepare.active(deps, userId, job.applicationId);
    // v33 SHARE-8: another person's AI (the owner's own, or someone else they shared the profile with) may hold it.
    if (active?.mode === 'mcp') return "Another person's AI is preparing this job now: there is nothing for your AI to do on it.";
    return active
      ? "TailorIT's own AI is preparing this job now: there is nothing for your AI to do on it."
      : `This job is not being prepared for your AI. To prepare it: filter_jobs {"jobIds": [${jobId}]${hint ? `, "profile": "${hint}"` : ''}}, then ` +
          'prepare_start with its runId.';
  }
  const state = await kitState(ctx, job, prepare);
  if (!state.resumeDone) {
    if (!readableForAi(job.posting)) {
      return `Next: call prepare_mark with {${jobArg(jobId, hint)}, "part": "resume", "status": "skipped", "reason": "The ` +
        'posting has too little text to tailor a resume to."}.';
    }
    if (!(await heldAnalysis(deps, userId, job))) {
      return mode === 'own-prompt'
        ? `Next: analyze the posting with your own prompt (prepare_job_context {${jobArg(jobId, hint)}, ` +
            `"includePosting": true}) and save it with prepare_save_analysis {${jobArg(jobId, hint)}, "analysis": ` +
            `${OWN.analysis}}.`
        : `Next: call ${promptCall(jobId, 'analyze', hint)}, write its JSON and save it with prepare_save_analysis as ` +
            '"analysis".';
    }
    return nextTailor(jobId, mode, hint);
  }
  if (!state.letter.done) {
    return mode === 'own-prompt'
      ? `Next: write the cover letter from the job's resume (prepare_job_context "includeResume": true) with your own ` +
          `prompt and save it with prepare_save_cover_letter {${jobArg(jobId, hint)}, ${OWN.letter}}.`
      : `Next: call ${promptCall(jobId, 'write_cover_letter', hint)}, write the letter and save its paragraphs with ` +
          'prepare_save_cover_letter.';
  }
  if (!state.answersDone) {
    return mode === 'own-prompt'
      ? 'Next: answer the questions prepare_job_context lists (with "includeResume": true for the facts of the job\'s ' +
          `resume) and save them with prepare_save_answers {${jobArg(jobId, hint)}, "answers": [{"questionId", "answer"}]}, ` +
          'in one call.'
      : `Next: call ${promptCall(jobId, 'write_answers', hint)}, answer what the facts support and save the answers with ` +
          'prepare_save_answers, in one call.';
  }
  return nextJob(ctx, jobId);
}

/** The tailor step. */
export function nextTailor(jobId: number, mode: McpPromptMode, hint: string | null = null): string {
  return mode === 'own-prompt'
    ? `Next: write the tailored resume with your own prompt (prepare_job_context {${jobArg(jobId, hint)}, ` +
        `"includeResume": true} gives the resume and the keyword plan) and save it with prepare_save_resume as ` +
        `"resume": ${OWN.resume}.`
    : `Next: call ${promptCall(jobId, 'tailor', hint)}, write the resume JSON it asks for and save it with ` +
        'prepare_save_resume as "resume".';
}

/** After the analyze step's save. */
export function nextAfterAnalysis(jobId: number, mode: McpPromptMode, hint: string | null = null): string {
  return mode === 'own-prompt'
    ? `Next: check the posting for keywords the analysis missed and save them with prepare_save_analysis ` +
        `{${jobArg(jobId, hint)}, "missing": [...]} (the same rows; [] when nothing is missing).`
    : `Next: call ${promptCall(jobId, 'review', hint)}, write its JSON and save its "missing" array with ` +
        'prepare_save_analysis as "missing" (an empty array when nothing is missing).';
}

/** After a resume save at `round` (1 is the tailor step's) that answers "revise": true. */
export function nextRevision(jobId: number, round: number, rounds: number, mode: McpPromptMode, hint: string | null = null): string {
  const used = `${round - 1} of ${rounds} revision round${rounds === 1 ? '' : 's'} used`;
  return mode === 'own-prompt'
    ? `Required while "revise" is true (${used}): fix the issues above with your own prompt and save with ` +
        `prepare_save_resume as "revision": ${OWN.revision}.`
    : `Required while "revise" is true (${used}): call ${promptCall(jobId, 'revise', hint)}, write the edits it asks for ` +
        'and save them with prepare_save_resume as "revision". The prompt lists the issues above.';
}
