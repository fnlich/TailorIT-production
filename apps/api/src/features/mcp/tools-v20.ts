import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AI_SEARCH_TEXT_CEILING } from '@tailorit/shared/jobs';
import { PREPARE_REQUEST_CEILING } from '@tailorit/shared/prepare';
import { INSTRUCTIONS_V } from '../../ai/prompts/mcp/instructions';
import { MCP_ARG_DESCRIPTIONS, MCP_TOOL_DESCRIPTIONS } from '../../ai/prompts/mcp/tool-descriptions';
import { AppError } from '../../core/http/errors';
import { aiSearchJobs } from './ai-search';
import { customFilterVerdicts, filterJobs, prepareStart, VERDICT_REASON_MAX, VERDICTS_MAX } from './filter';
import { instructionsFor, noteInstructionsRead } from './instructions';
import { OWN_AI_FEATURES, ownAiContext, ownAiSave } from './own-ai';
import type { SaveContext } from './save';
import { PAGE_MAX } from './tools-jobs';

// v2.0 P5 (07-mcp.md "New"): the tools v2.0 adds, registered by server.ts in one line: instructions, filter_jobs,
// custom_filter_verdicts, prepare_start, ai_search_jobs, own_ai_context and own_ai_save. Each answer is compact JSON
// (tables under `cols`); a refusal is a tool error {"error": {code, message}} with the web's code and constant message.
// The log names the tool, the account and done or refused, never an argument's value.

/** filter_jobs' and prepare_start's direct ids, at most. */
export const DIRECT_JOB_IDS_MAX = 100;

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const JobId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Id = z.string().min(1).max(64);

/** One request's async tool runner: a JSON answer, a refusal as a tool error, logs without values. */
function runner(ctx: SaveContext) {
  const { deps, userId } = ctx;
  const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  return async (tool: string, work: () => unknown): Promise<CallToolResult> => {
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
      const message = error instanceof AppError ? error.message : "Something went wrong on TailorIT's side. Try again.";
      return { ...json({ error: { code: 'internal', message } }), isError: true };
    }
  };
}

export function registerV20Tools(server: McpServer, ctx: SaveContext): void {
  const run = runner(ctx);
  const { deps, userId } = ctx;

  server.registerTool(
    'instructions',
    {
      title: 'Instructions',
      description: MCP_TOOL_DESCRIPTIONS.instructions,
      inputSchema: {},
      annotations: READ,
    },
    () =>
      run('instructions', async () => {
        noteInstructionsRead(ctx.tokenId ?? null, deps.now());
        return { v: INSTRUCTIONS_V, text: await instructionsFor(deps, userId) };
      }),
  );

  server.registerTool(
    'filter_jobs',
    {
      title: 'Filter jobs',
      description: MCP_TOOL_DESCRIPTIONS.filter_jobs,
      inputSchema: {
        scope: z.literal('saved').optional(),
        setId: z.string().max(40).optional(),
        jobIds: z.array(JobId).min(1).max(DIRECT_JOB_IDS_MAX).optional(),
        // Checked in code with PrepareFiltersExtraSchema (narrowing only): the schema's enums would cost the AI tokens.
        extra: z.record(z.string(), z.unknown()).optional().describe(MCP_ARG_DESCRIPTIONS.extra),
        cursor: z.string().max(80).optional(),
      },
      annotations: READ,
    },
    (args) => run('filter_jobs', () => filterJobs(ctx, args)),
  );

  server.registerTool(
    'custom_filter_verdicts',
    {
      title: 'Custom filter verdicts',
      description: MCP_TOOL_DESCRIPTIONS.custom_filter_verdicts,
      inputSchema: {
        verdicts: z
          .array(z.object({ jobId: JobId, pass: z.boolean(), reason: z.string().max(VERDICT_REASON_MAX).optional() }))
          .min(1)
          .max(VERDICTS_MAX),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ verdicts }) => run('custom_filter_verdicts', () => customFilterVerdicts(ctx, verdicts)),
  );

  server.registerTool(
    'prepare_start',
    {
      title: 'Prepare start',
      description: MCP_TOOL_DESCRIPTIONS.prepare_start,
      inputSchema: {
        runId: z.string().max(40).optional(),
        jobIds: z.array(JobId).min(1).max(PREPARE_REQUEST_CEILING).optional(),
        applicationIds: z.array(Id).min(1).max(PREPARE_REQUEST_CEILING).optional(),
        rebuild: z.boolean().optional(),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    (args) => run('prepare_start', () => prepareStart(ctx, args)),
  );

  server.registerTool(
    'ai_search_jobs',
    {
      title: 'AI job search',
      description: MCP_TOOL_DESCRIPTIONS.ai_search_jobs,
      inputSchema: {
        text: z.string().min(1).max(AI_SEARCH_TEXT_CEILING),
        limit: z.number().int().min(1).max(PAGE_MAX).optional(),
      },
      annotations: { ...READ, openWorldHint: false },
    },
    (args) => run('ai_search_jobs', () => aiSearchJobs(deps, userId, args)),
  );

  const OwnIds = {
    feature: z.enum(OWN_AI_FEATURES),
    resumeId: Id.optional(),
    entryId: Id.optional().describe(MCP_ARG_DESCRIPTIONS.entryId),
    applicationId: Id.optional().describe(MCP_ARG_DESCRIPTIONS.applicationId),
    jobId: JobId.optional().describe(MCP_ARG_DESCRIPTIONS.ownJobId),
  };

  server.registerTool(
    'own_ai_context',
    {
      title: 'Own AI context',
      description: MCP_TOOL_DESCRIPTIONS.own_ai_context,
      inputSchema: { ...OwnIds, task: z.enum(['write', 'improve']).optional() },
      annotations: READ,
    },
    (args) => run('own_ai_context', () => ownAiContext(deps, userId, args)),
  );

  server.registerTool(
    'own_ai_save',
    {
      title: 'Own AI save',
      description: MCP_TOOL_DESCRIPTIONS.own_ai_save,
      inputSchema: {
        ...OwnIds,
        output: z.unknown(),
        mode: z.enum(['replace', 'append']).optional(),
        revision: z.number().int().nonnegative().optional(),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    (args) => run('own_ai_save', () => ownAiSave(deps, userId, args)),
  );
}
