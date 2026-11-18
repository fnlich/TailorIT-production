import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { prepareAllText } from '../../ai/prompts/mcp/prepare-all';
import { MCP_ARG_DESCRIPTIONS, MCP_PROMPT_DESCRIPTIONS, MCP_TOOL_DESCRIPTIONS, mcpPromptAnswerDescription } from '../../ai/prompts/mcp/tool-descriptions';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { MCP_PROMPT_MODES } from '@tailorit/shared/mcp';
import { untrustedText } from '../autofill/ai/untrusted';
import { instructionsFor, noteInstructionsRead } from './instructions';
import type { PrepareAdapter } from './prepare';
import { registerQ1Tools } from './q1-tools';
import { saveAnalysis, saveAnswers, saveAnswersForJobs, saveCoverLetter, saveResume, type SaveContext } from './save';
import { stepPrompt } from './steps';
import { CONTEXT_FIELDS, jobContext, markJob, prepareQueue, QUEUE_PAGE } from './tools';
// v1.5 Q2
import { registerWorkTools } from './tools-q2';
// end v1.5 Q2
import { registerV20Tools } from './tools-v20'; // v2.0 P5
import { registerV31Tools } from './tools-v31'; // v31 LINK

// TailorIT's MCP server for one request of one account (v1.5 M): stateless, so endpoint.ts builds one per request for
// the account its token names, and every tool and prompt here closes over that account. Inputs are checked by zod
// (the SDK refuses one that does not parse before a tool runs); every answer is JSON (v1.5 Q1: but prepare_prompt's,
// the prompt's own text). A refusal is a tool error ({"error": {code, message}}) whose message says what to do; anything
// else is logged by name only and answered with a sentence. The log names the account, the tool and counts, never an
// input or an answer.
// v2.0 P5 (07-mcp.md): the server's `instructions` are TailorIT's default instructions, its platform rules and the
// person's custom instructions (instructions.ts), built per request; v2.0's tools are tools-v20.ts. A Prepare is
// started by prepare_start and the saves queue the job when its kit is complete; queue_add is gone (A4).

/** The largest number of array elements and object members one tool call's arguments may hold. */
export const MAX_TOOL_INPUT_ELEMENTS = 5_000;

const JobId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(MCP_ARG_DESCRIPTIONS.jobId);
/** MCP prompt arguments are strings. */
const JobIdArg = z.string().regex(/^\d{1,15}$/, 'A job id from prepare_queue').describe(MCP_ARG_DESCRIPTIONS.jobIdArg);

// v1.5 Q1: the save tools' inputs are described for the model and lenient: what they hold is normalized strictly in
// code (normalize/), whose refusals name the field and the shape, so the SDK refuses only what has no place at all.
const Mode = z.enum(MCP_PROMPT_MODES).optional().describe(MCP_ARG_DESCRIPTIONS.mode);
const KeywordItem = z.unknown().describe(MCP_ARG_DESCRIPTIONS.keywordItem);
const AnalysisInput = z
  .looseObject({
    keywords: z.array(KeywordItem).max(400).optional(),
    title: z.unknown().optional(),
    seniority: z.unknown().optional(),
    industry: z.unknown().optional(),
    department: z.unknown().optional(),
    responsibilities: z.unknown().optional(),
    mustInclude: z.unknown().optional(),
  })
  .describe(MCP_ARG_DESCRIPTIONS.analysis);
const ResumeInput = z
  .looseObject({
    summary: z.unknown().optional(),
    experience: z.unknown().optional().describe(MCP_ARG_DESCRIPTIONS.resumeExperience),
    hardSkills: z.unknown().optional(),
    softSkills: z.unknown().optional(),
    strengths: z.unknown().optional(),
  })
  .describe(MCP_ARG_DESCRIPTIONS.resume);
const RevisionInput = z
  .looseObject({
    summary: z.unknown().optional(),
    edits: z.unknown().optional(),
  })
  .describe(MCP_ARG_DESCRIPTIONS.revision);
const AnswerItem = z.object({
  questionId: z.coerce.number().int().positive(),
  answer: z.unknown(),
});
/** The most jobs one prepare_save_answers call takes. */
const MAX_ANSWER_JOBS = 10;

function json(value: unknown): CallToolResult {
  // v1.5 Q1: a text answer (a prompt) as it is; anything else as compact JSON.
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function promptOf(about: string, text: string): GetPromptResult {
  return { description: about, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/** Builds the MCP server for `userId`'s request. */
export async function createMcpServer(
  deps: AppDeps,
  userId: string,
  prepare: PrepareAdapter,
  version: string,
  // v1.5 Q2: the token that sent the request (report_unsupported's limit per token).
  tokenId: string | null = null,
): Promise<McpServer> {
  const server = new McpServer(
    { name: 'tailorit', version },
    {
      capabilities: { tools: {}, prompts: {} },
      // v2.0 P5: the default instructions, the platform rules and the person's custom instructions.
      instructions: await instructionsFor(deps, userId),
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    },
  );
  const ctx: SaveContext = { deps, userId, prepare, tokenId };

  /** Runs one tool for the account: its answer as JSON, a refusal as a tool error. Logs counts only. */
  const run = async (tool: string, work: () => unknown): Promise<CallToolResult> => {
    try {
      const result = await work();
      deps.log.debug(`[mcp] account ${userId}: ${tool} done`);
      return json(result);
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        deps.log.debug(`[mcp] account ${userId}: ${tool} refused (${error.code})`);
        return { ...json({ error: { code: error.code, message: error.message } }), isError: true };
      }
      deps.log.error(`[mcp] account ${userId}: ${tool} failed`, error instanceof Error ? error.name : 'unknown');
      const message = error instanceof AppError ? error.message : 'Something went wrong on TailorIT\'s side. Try again.';
      return { ...json({ error: { code: 'internal', message } }), isError: true };
    }
  };

  server.registerTool(
    'prepare_queue',
    {
      title: 'Prepare queue',
      description: MCP_TOOL_DESCRIPTIONS.prepare_queue,
      inputSchema: {
        limit: z.number().int().min(1).max(QUEUE_PAGE.max).optional(),
        cursor: z.string().max(10).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ limit, cursor }) => run('prepare_queue', () => prepareQueue(ctx, { limit, cursor })),
  );

  server.registerTool(
    'prepare_job_context',
    {
      title: 'Job context',
      description: MCP_TOOL_DESCRIPTIONS.prepare_job_context,
      inputSchema: {
        jobId: JobId,
        includePosting: z.boolean().optional(),
        includeResume: z.boolean().optional().describe(MCP_ARG_DESCRIPTIONS.includeResume),
        fields: z.array(z.enum(CONTEXT_FIELDS)).max(CONTEXT_FIELDS.length).optional(),
        mode: Mode,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ jobId, includePosting, includeResume, fields, mode }) =>
      run('prepare_job_context', () => jobContext(ctx, jobId, { includePosting, includeResume, fields, mode })),
  );

  server.registerTool(
    'prepare_save_analysis',
    {
      title: 'Save keyword analysis',
      description: MCP_TOOL_DESCRIPTIONS.prepare_save_analysis,
      inputSchema: {
        jobId: JobId,
        analysis: AnalysisInput.optional(),
        missing: z.array(KeywordItem).max(200).optional().describe(MCP_ARG_DESCRIPTIONS.missing),
        mode: Mode,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ jobId, analysis, missing, mode }) =>
      run('prepare_save_analysis', async () => {
        if ((analysis === undefined) === (missing === undefined)) {
          throw new AppError('validation_failed', 'Send either analysis (the analyze step) or missing (the review step).');
        }
        return await saveAnalysis(ctx, jobId, analysis !== undefined ? { analysis } : { missing }, mode);
      }),
  );

  server.registerTool(
    'prepare_save_resume',
    {
      title: 'Save tailored resume',
      description: MCP_TOOL_DESCRIPTIONS.prepare_save_resume,
      inputSchema: { jobId: JobId, resume: ResumeInput.optional(), revision: RevisionInput.optional(), mode: Mode },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ jobId, resume, revision, mode }) =>
      run('prepare_save_resume', async () => {
        if ((resume === undefined) === (revision === undefined)) {
          throw new AppError('validation_failed', 'Send either resume (the tailor step) or revision (the revise step).');
        }
        return await saveResume(ctx, jobId, resume !== undefined ? { resume } : { revision }, mode);
      }),
  );

  server.registerTool(
    'prepare_save_cover_letter',
    {
      title: 'Save cover letter',
      description: MCP_TOOL_DESCRIPTIONS.prepare_save_cover_letter,
      inputSchema: {
        jobId: JobId,
        paragraphs: z.union([z.array(z.unknown()).max(20), z.string().max(20_000)]).optional(),
        letter: z.unknown().optional().describe(MCP_ARG_DESCRIPTIONS.letter),
        mode: Mode,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ jobId, paragraphs, letter, mode }) =>
      run('prepare_save_cover_letter', () => saveCoverLetter(ctx, jobId, { paragraphs, letter }, mode)),
  );

  server.registerTool(
    'prepare_save_answers',
    {
      title: 'Save answers',
      description: MCP_TOOL_DESCRIPTIONS.prepare_save_answers,
      inputSchema: {
        jobId: JobId.optional(),
        answers: z.array(AnswerItem).max(300).optional(),
        jobs: z.array(z.object({ jobId: JobId, answers: z.array(AnswerItem).max(300) })).min(1).max(MAX_ANSWER_JOBS).optional(),
        mode: Mode,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ jobId, answers, jobs, mode }) =>
      run('prepare_save_answers', async () => {
        if (jobs !== undefined) {
          if (jobId !== undefined || answers !== undefined) {
            throw new AppError('validation_failed', 'Send either "jobs" or "jobId" with "answers", not both.');
          }
          return await saveAnswersForJobs(ctx, jobs, mode);
        }
        if (jobId === undefined || answers === undefined) {
          throw new AppError('validation_failed', 'Send "jobId" with "answers" (or "jobs": [{"jobId", "answers"}]).');
        }
        return await saveAnswers(ctx, jobId, { answers }, { mode });
      }),
  );

  server.registerTool(
    'prepare_mark',
    {
      title: 'Mark a job',
      description: MCP_TOOL_DESCRIPTIONS.prepare_mark,
      inputSchema: {
        jobId: JobId,
        status: z.enum(['failed', 'skipped']),
        reason: z.string().trim().min(1).max(300),
        part: z.enum(['resume', 'letter', 'answers', 'all']).optional().describe(MCP_ARG_DESCRIPTIONS.part),
        mode: Mode,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ jobId, status, reason, part, mode }) =>
      run('prepare_mark', () => markJob(ctx, jobId, { status, reason: untrustedText(reason, 300), part }, mode)),
  );

  // v1.5 Q1: prepare_prompt (each step's prompt, for a model that can only call tools) and prepare_settings.
  registerQ1Tools(server, ctx, run);
  // end v1.5 Q1
  // v1.5 Q2: search, save, the auto-apply queue, the tracker, its statistics and unsupported requests.
  registerWorkTools(server, deps, userId, tokenId);
  // end v1.5 Q2
  // v2.0 P5: instructions, filter_jobs, custom_filter_verdicts, prepare_start, ai_search_jobs, own_ai_context/_save.
  registerV20Tools(server, ctx);
  registerV31Tools(server, deps, userId); // v31 LINK: add_job (tools-v31.ts)

  // ---------------------------------------------------------------------------------------------------- prompts

  /** A prompt's text for one of the account's jobs; a refusal becomes the prompt's error. */
  const prompt = async (name: string, jobIdText: string, build: (jobId: number) => Promise<string>): Promise<GetPromptResult> => {
    const jobId = Number(jobIdText);
    try {
      const text = await build(jobId);
      deps.log.debug(`[mcp] account ${userId}: prompt ${name}`);
      return promptOf(mcpPromptAnswerDescription(name, jobId), text);
    } catch (error) {
      if (error instanceof AppError && error.status < 500) throw new Error(error.message);
      deps.log.error(`[mcp] account ${userId}: prompt ${name} failed`, error instanceof Error ? error.name : 'unknown');
      throw new Error('Something went wrong on TailorIT\'s side. Try again.');
    }
  };

  const stepOf = (name: string, step: Parameters<typeof stepPrompt>[1], about: string, title: string) =>
    server.registerPrompt(name, { title, description: about, argsSchema: { jobId: JobIdArg } }, ({ jobId }) =>
      prompt(name, jobId, (id) => stepPrompt(ctx, step, [id])),
    );

  server.registerPrompt(
    'prepare_all',
    { title: 'Prepare all', description: MCP_PROMPT_DESCRIPTIONS.prepare_all },
    async () => {
      // v2.0 P5: the instructions themselves, for a client that ignores the server's `instructions`.
      noteInstructionsRead(tokenId, deps.now());
      return promptOf(MCP_PROMPT_DESCRIPTIONS.prepare_all_answer, prepareAllText(await instructionsFor(deps, userId)));
    },
  );

  // The same prompts as the tool prepare_prompt (steps.ts), for a person who inserts them by hand.
  stepOf('analyze', 'analyze', MCP_PROMPT_DESCRIPTIONS.analyze, 'Analyze the job');
  stepOf('review', 'review', MCP_PROMPT_DESCRIPTIONS.review, 'Review the keywords');
  stepOf('tailor', 'tailor', MCP_PROMPT_DESCRIPTIONS.tailor, 'Tailor the resume');
  stepOf('revise', 'revise', MCP_PROMPT_DESCRIPTIONS.revise, 'Revise the resume');
  stepOf('write_cover_letter', 'write_cover_letter', MCP_PROMPT_DESCRIPTIONS.write_cover_letter, 'Write the cover letter');
  stepOf('write_answers', 'write_answers', MCP_PROMPT_DESCRIPTIONS.write_answers, 'Answer the questions');

  return server;
}
