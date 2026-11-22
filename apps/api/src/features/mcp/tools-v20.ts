import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AI_SEARCH_TEXT_CEILING } from '@tailorit/shared/jobs';
import { PREPARE_REQUEST_CEILING } from '@tailorit/shared/prepare';
import { INSTRUCTIONS_V } from '../../ai/prompts/mcp/instructions';
import { MCP_ARG_DESCRIPTIONS, MCP_TOOL_DESCRIPTIONS } from '../../ai/prompts/mcp/tool-descriptions';
import { aiSearchJobs } from './ai-search';
import { customFilterVerdicts, filterJobs, prepareStart, VERDICT_REASON_MAX, VERDICTS_MAX } from './filter';
import { instructionsFor, noteInstructionsRead } from './instructions';
import { OWN_AI_FEATURES, ownAiContext, ownAiSave } from './own-ai';
import { ProfileArg, type McpSession } from './profiles';
import { toolMeta } from './tool-meta'; // v34 MCPDIR
import { PAGE_MAX } from './tools-jobs';

// v2.0 P5 (07-mcp.md "New"): the tools v2.0 adds, registered by server.ts in one line: instructions, filter_jobs,
// custom_filter_verdicts, prepare_start, ai_search_jobs, own_ai_context and own_ai_save. Each answer is compact JSON
// (tables under `cols`); a refusal is a tool error {"error": {code, message}} with the web's code and constant message.
// The log names the tool, the account and done or refused, never an argument's value.
// v33 SHARE-8 (PLAN-sharing.md §7): every tool but `instructions` takes `profile` and runs on the profile the session
// decides (profiles.ts); `instructions` is the caller's own, with the profiles shared with them.

/** filter_jobs' and prepare_start's direct ids, at most. */
export const DIRECT_JOB_IDS_MAX = 100;

const JobId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Id = z.string().min(1).max(64);

/** v33 SHARE-8: a tool's arguments without `profile` (the session reads it). */
function argsOf<T extends { profile?: string }>(args: T): Omit<T, 'profile'> {
  const { profile: _profile, ...rest } = args;
  return rest;
}

export function registerV20Tools(server: McpServer, session: McpSession): void {
  const { deps, run } = session;

  server.registerTool(
    'instructions',
    {
      ...toolMeta('instructions'),
      description: MCP_TOOL_DESCRIPTIONS.instructions,
      inputSchema: {},
    },
    () =>
      run('instructions', {}, async () => {
        noteInstructionsRead(session.tokenId, deps.now());
        // v33 SHARE-8: the caller's instructions, with the profiles shared with them (never an owner's custom words).
        return { v: INSTRUCTIONS_V, text: await instructionsFor(deps, session.caller, await session.grants()) };
      }),
  );

  server.registerTool(
    'filter_jobs',
    {
      ...toolMeta('filter_jobs'),
      description: MCP_TOOL_DESCRIPTIONS.filter_jobs,
      inputSchema: {
        scope: z.literal('saved').optional(),
        setId: z.string().max(40).optional(),
        jobIds: z.array(JobId).min(1).max(DIRECT_JOB_IDS_MAX).optional(),
        // Checked in code with PrepareFiltersExtraSchema (narrowing only): the schema's enums would cost the AI tokens.
        extra: z.record(z.string(), z.unknown()).optional().describe(MCP_ARG_DESCRIPTIONS.extra),
        cursor: z.string().max(80).optional(),
        profile: ProfileArg,
      },
    },
    (args) => run('filter_jobs', args, (ctx) => filterJobs(ctx, argsOf(args))),
  );

  server.registerTool(
    'custom_filter_verdicts',
    {
      ...toolMeta('custom_filter_verdicts'),
      description: MCP_TOOL_DESCRIPTIONS.custom_filter_verdicts,
      inputSchema: {
        verdicts: z
          .array(z.object({ jobId: JobId, pass: z.boolean(), reason: z.string().max(VERDICT_REASON_MAX).optional() }))
          .min(1)
          .max(VERDICTS_MAX),
        profile: ProfileArg,
      },
    },
    ({ verdicts, profile }) => run('custom_filter_verdicts', { profile }, (ctx) => customFilterVerdicts(ctx, verdicts)),
  );

  server.registerTool(
    'prepare_start',
    {
      ...toolMeta('prepare_start'),
      description: MCP_TOOL_DESCRIPTIONS.prepare_start,
      inputSchema: {
        runId: z.string().max(40).optional(),
        jobIds: z.array(JobId).min(1).max(PREPARE_REQUEST_CEILING).optional(),
        applicationIds: z.array(Id).min(1).max(PREPARE_REQUEST_CEILING).optional(),
        rebuild: z.boolean().optional(),
        profile: ProfileArg,
      },
    },
    // A runId fixes the profile its filter run was made on; jobIds name no profile (a write: PROFILE_REQUIRED then).
    (args) => run('prepare_start', { profile: args.profile, runId: args.runId }, (ctx) => prepareStart(ctx, argsOf(args))),
  );

  server.registerTool(
    'ai_search_jobs',
    {
      ...toolMeta('ai_search_jobs'),
      description: MCP_TOOL_DESCRIPTIONS.ai_search_jobs,
      inputSchema: {
        text: z.string().min(1).max(AI_SEARCH_TEXT_CEILING),
        limit: z.number().int().min(1).max(PAGE_MAX).optional(),
        profile: ProfileArg,
      },
    },
    (args) => run('ai_search_jobs', { profile: args.profile }, (ctx) => aiSearchJobs(ctx, argsOf(args))),
  );

  const OwnIds = {
    feature: z.enum(OWN_AI_FEATURES),
    resumeId: Id.optional(),
    entryId: Id.optional().describe(MCP_ARG_DESCRIPTIONS.entryId),
    applicationId: Id.optional().describe(MCP_ARG_DESCRIPTIONS.applicationId),
    jobId: JobId.optional().describe(MCP_ARG_DESCRIPTIONS.ownJobId),
    profile: ProfileArg,
  };

  server.registerTool(
    'own_ai_context',
    {
      ...toolMeta('own_ai_context'),
      description: MCP_TOOL_DESCRIPTIONS.own_ai_context,
      inputSchema: { ...OwnIds, task: z.enum(['write', 'improve']).optional() },
    },
    (args) => run('own_ai_context', { profile: args.profile }, (ctx) => ownAiContext(ctx, argsOf(args))),
  );

  server.registerTool(
    'own_ai_save',
    {
      ...toolMeta('own_ai_save'),
      description: MCP_TOOL_DESCRIPTIONS.own_ai_save,
      inputSchema: {
        ...OwnIds,
        output: z.unknown(),
        mode: z.enum(['replace', 'append']).optional(),
        revision: z.number().int().nonnegative().optional(),
      },
    },
    (args) => run('own_ai_save', { profile: args.profile }, (ctx) => ownAiSave(ctx, argsOf(args))),
  );
}
