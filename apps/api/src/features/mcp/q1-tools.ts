import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MCP_CUSTOM_INSTRUCTIONS_MAX, MCP_PROMPT_MODES, MCP_REVISE_ROUNDS } from '@tailorit/shared/mcp';
import { COVER_LETTER_MODES } from '@tailorit/shared/prepare';
import { MCP_TOOL_DESCRIPTIONS, mcpPreparePromptDescription } from '../../ai/prompts/mcp/tool-descriptions';
import { AppError } from '../../core/http/errors';
import { readAutofillProfile, setCoverLetterMode } from '../autofill/profile/repository';
import { ANSWER_BATCH_JOBS, PREPARE_STEPS } from './next';
import type { SaveContext } from './save';
import { checkedCustomInstructions, mcpSettings, saveMcpSettings } from './settings';
import { stepPrompt } from './steps';

// v1.5 Q1: the tools of the MCP Prepare fix and the person's own AI settings, registered by server.ts in one line:
// - prepare_prompt: each step's prompt (tailor_builder0's, rendered for the job, behind the MCP prompts' gates) as a
//   tool, because a model can only call tools: MCP prompts are the person's to insert, and the AI that was told to "get
//   the prompt" improvised instead. Answered as plain text, the fixed instructions first and the job's data last, so
//   the client can cache the instructions. write_answers takes up to three jobs at once (the rules and the facts once).
// - prepare_settings: the revision rounds (0 to 5, 2 by default) and the prompt mode, read or set.
// v2.0 P5: prepare_settings also sets the custom instructions and the cover-letter mode (the profile's
// documents.coverLetters), each only when the person asks, and reads the resume mode (the person's setting, never the
// AI's to change: A29).

/** server.ts's runner: one tool's answer, or its refusal as a tool error. */
export type ToolRun = (tool: string, work: () => unknown) => Promise<CallToolResult>;

const JobId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function registerQ1Tools(server: McpServer, ctx: SaveContext, run: ToolRun): void {
  server.registerTool(
    'prepare_prompt',
    {
      title: 'Prepare step prompt',
      description: mcpPreparePromptDescription(ANSWER_BATCH_JOBS),
      inputSchema: {
        jobId: JobId.optional(),
        jobIds: z.array(JobId).min(1).max(ANSWER_BATCH_JOBS).optional(),
        step: z.enum(PREPARE_STEPS),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ jobId, jobIds, step }) =>
      run('prepare_prompt', () => {
        if ((jobId === undefined) === (jobIds === undefined)) {
          throw new AppError('validation_failed', 'Send either "jobId" or (for write_answers) "jobIds".');
        }
        return stepPrompt(ctx, step, jobIds ?? [jobId!]);
      }),
  );

  server.registerTool(
    'prepare_settings',
    {
      title: 'Prepare settings',
      description: MCP_TOOL_DESCRIPTIONS.prepare_settings,
      inputSchema: {
        reviseRounds: z.number().int().min(MCP_REVISE_ROUNDS.min).max(MCP_REVISE_ROUNDS.max).optional(),
        mode: z.enum(MCP_PROMPT_MODES).optional(),
        customInstructions: z.string().max(MCP_CUSTOM_INSTRUCTIONS_MAX).optional(),
        letterMode: z.enum(COVER_LETTER_MODES).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ reviseRounds, mode, customInstructions, letterMode }) =>
      run('prepare_settings', async () => {
        const { deps, userId } = ctx;
        const changes = {
          ...(reviseRounds !== undefined ? { reviseRounds } : {}),
          ...(mode !== undefined ? { promptMode: mode } : {}),
          ...(customInstructions !== undefined
            ? { customInstructions: checkedCustomInstructions(deps, customInstructions) }
            : {}),
        };
        const settings =
          Object.keys(changes).length > 0 ? await saveMcpSettings(deps, userId, changes) : await mcpSettings(deps, userId);
        // INT: P2's setCoverLetterMode replaces this boolean setter (the same two values).
        if (letterMode !== undefined) await setCoverLetterMode(deps, userId, letterMode);
        return {
          reviseRounds: settings.reviseRounds,
          mode: settings.promptMode,
          range: { min: MCP_REVISE_ROUNDS.min, max: MCP_REVISE_ROUNDS.max, default: MCP_REVISE_ROUNDS.default },
          customInstructions: settings.customInstructions,
          letterMode: (await readAutofillProfile(deps, userId)).value.documents.coverLetters,
          resumeMode: await ctx.prepare.resumeMode(deps, userId),
        };
      }),
  );
}
