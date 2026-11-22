import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MCP_CUSTOM_INSTRUCTIONS_MAX, MCP_PROMPT_MODES, MCP_REVISE_ROUNDS, type McpSettings } from '@tailorit/shared/mcp';
import { COVER_LETTER_MODES } from '@tailorit/shared/prepare';
import { PROFILE_SELF } from '@tailorit/shared/sharing'; // v34 MCPFAN
import { MCP_TOOL_DESCRIPTIONS, mcpPreparePromptDescription } from '../../ai/prompts/mcp/tool-descriptions';
import { AppError } from '../../core/http/errors';
import { readAutofillProfile, setCoverLetterMode } from '../autofill/profile/repository';
import { ANSWER_BATCH_JOBS, PREPARE_STEPS } from './next';
import { ProfileArg, type McpSession } from './profiles';
import { refuseFencedData, type SaveContext } from './save'; // v33 SHARE-8 (review)
import { askCustomInstructions, checkedCustomInstructions, mcpSettings, saveMcpSettings } from './settings';
import { stepPrompt } from './steps';
import { toolMeta } from './tool-meta'; // v34 MCPDIR

// v1.5 Q1: the tools of the MCP Prepare fix and the person's own AI settings, registered by server.ts in one line:
// - prepare_prompt: each step's prompt (tailor_builder0's, rendered for the job, behind the MCP prompts' gates) as a
//   tool, because a model can only call tools: MCP prompts are the person's to insert, and the AI that was told to "get
//   the prompt" improvised instead. Answered as plain text, the fixed instructions first and the job's data last, so
//   the client can cache the instructions. write_answers takes up to three jobs at once (the rules and the facts once).
// - prepare_settings: the revision rounds (0 to 5, 2 by default) and the prompt mode, read or set.
// v2.0 P5: prepare_settings also sets the custom instructions and the cover-letter mode (the profile's
// documents.coverLetters), each only when the person asks, and reads the resume mode (the person's setting, never the
// AI's to change: A29).
// v33 SHARE-8 (PLAN-sharing.md §7): both take `profile`. prepare_prompt renders the step for that profile's job (the
// owner's facts; the caller's own custom instructions as preferences, with the scope line: steps.ts). prepare_settings
// reads the caller's own AI settings (rounds, prompt mode, custom instructions) and the profile's letter and resume
// modes. The runner is the session's (profiles.ts).
// v34 MCPDIR (PLAN G8 addendum; the directory review, finding 8): the read and the write are separate tools:
// prepare_settings only reads; set_prepare_settings changes the caller's own settings (no `profile`), and custom
// instructions it is sent wait for the person's OK in Settings › Integrations (settings.ts, migration 0054).
// v34 MCPFAN (the MCPFAN spec review, M4; the coordinator's decision 6): set_prepare_settings takes `profile` only to
// refuse another one (OWN_SETTINGS_ONLY): sent beside set_prepare_filters, which takes "all", a profile it ignored would
// have changed the caller's own settings while the AI reported another profile's.

const JobId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** v34 MCPDIR: set_prepare_settings without a field to change. */
export const SETTINGS_NOTHING_SENT = 'Send at least one of reviseRounds, mode, customInstructions or letterMode (prepare_settings reads them).';
/** v34 MCPFAN (decision 6): set_prepare_settings given a profile that is not the caller's own. */
export const OWN_SETTINGS_ONLY =
  'set_prepare_settings changes the person\'s own settings only ("profile": "me", or none). Prepare settings on a shared ' +
  'profile change in TailorIT, on that profile; the Prepare filters of any profile change with set_prepare_filters.';
/** v34 MCPDIR: what set_prepare_settings says beside custom instructions that wait for the person's OK. */
export const PENDING_NOTE =
  "The new custom instructions wait for the person's OK in Settings › Integrations; until then the prompts use the current ones.";

export function registerQ1Tools(server: McpServer, session: McpSession): void {
  const { deps } = session;
  server.registerTool(
    'prepare_prompt',
    {
      ...toolMeta('prepare_prompt'),
      description: mcpPreparePromptDescription(ANSWER_BATCH_JOBS),
      inputSchema: {
        jobId: JobId.optional(),
        jobIds: z.array(JobId).min(1).max(ANSWER_BATCH_JOBS).optional(),
        step: z.enum(PREPARE_STEPS),
        profile: ProfileArg,
      },
    },
    (args) =>
      session.run('prepare_prompt', args, (ctx) => {
        const { jobId, jobIds, step } = args;
        if ((jobId === undefined) === (jobIds === undefined)) {
          throw new AppError('validation_failed', 'Send either "jobId" or (for write_answers) "jobIds".');
        }
        return stepPrompt(ctx, step, jobIds ?? [jobId!]);
      }),
  );

  /** The settings as both tools answer them: the caller's own AI settings and the profile's letter and resume modes. */
  const settingsView = async (ctx: SaveContext, settings: McpSettings) => ({
    reviseRounds: settings.reviseRounds,
    mode: settings.promptMode,
    range: { min: MCP_REVISE_ROUNDS.min, max: MCP_REVISE_ROUNDS.max, default: MCP_REVISE_ROUNDS.default },
    customInstructions: settings.customInstructions,
    ...(settings.pendingCustomInstructions !== undefined ? { pendingCustomInstructions: settings.pendingCustomInstructions } : {}),
    letterMode: (await readAutofillProfile(deps, ctx.userId)).value.documents.coverLetters,
    resumeMode: await ctx.prepare.resumeMode(deps, ctx.userId),
  });

  // v34 MCPDIR (PLAN G8 addendum: separate read and write tools): prepare_settings only reads (any profile it may read
  // Job settings on); set_prepare_settings changes the caller's own settings and takes no `profile`.
  server.registerTool(
    'prepare_settings',
    {
      ...toolMeta('prepare_settings'),
      description: MCP_TOOL_DESCRIPTIONS.prepare_settings,
      inputSchema: { profile: ProfileArg },
    },
    ({ profile }) =>
      // v33 SHARE-8: the AI settings are the caller's own, on every profile; the letter and resume modes the profile's.
      session.run('prepare_settings', { profile }, async (ctx) => settingsView(ctx, await mcpSettings(deps, ctx.caller.id))),
  );

  server.registerTool(
    'set_prepare_settings',
    {
      ...toolMeta('set_prepare_settings'),
      description: MCP_TOOL_DESCRIPTIONS.set_prepare_settings,
      inputSchema: {
        reviseRounds: z.number().int().min(MCP_REVISE_ROUNDS.min).max(MCP_REVISE_ROUNDS.max).optional(),
        mode: z.enum(MCP_PROMPT_MODES).optional(),
        customInstructions: z.string().max(MCP_CUSTOM_INSTRUCTIONS_MAX).optional(),
        letterMode: z.enum(COVER_LETTER_MODES).optional(),
        profile: ProfileArg, // v34 MCPFAN: "me" only (OWN_SETTINGS_ONLY)
      },
    },
    ({ reviseRounds, mode, customInstructions, letterMode, profile }) =>
      session.run('set_prepare_settings', {}, async (ctx) => {
        if (profile !== undefined && profile.trim() !== PROFILE_SELF) throw new AppError('validation_failed', OWN_SETTINGS_ONLY);
        const callerId = ctx.caller.id;
        if (reviseRounds === undefined && mode === undefined && customInstructions === undefined && letterMode === undefined) {
          throw new AppError('validation_failed', SETTINGS_NOTHING_SENT);
        }
        // v33 SHARE-8 (review; PLAN-sharing.md §7: any MCP save holding a tripwire of the caller's grants is refused):
        // custom instructions shape every later prompt on every profile, so fenced text copied into them keeps nothing.
        if (customInstructions !== undefined) refuseFencedData(ctx, customInstructions);
        const changes = {
          ...(reviseRounds !== undefined ? { reviseRounds } : {}),
          ...(mode !== undefined ? { promptMode: mode } : {}),
        };
        // v34 MCPDIR (the security review, finding 1): custom instructions wait for the person's OK in Settings ›
        // Integrations; the prompts keep the approved ones until then.
        const pending = customInstructions !== undefined ? checkedCustomInstructions(deps, customInstructions) : undefined;
        if (Object.keys(changes).length > 0) await saveMcpSettings(deps, callerId, changes);
        if (pending !== undefined) await askCustomInstructions(deps, callerId, pending);
        // INT: P2's setCoverLetterMode replaces this boolean setter (the same two values).
        if (letterMode !== undefined) await setCoverLetterMode(deps, ctx.userId, letterMode);
        const view = await settingsView(ctx, await mcpSettings(deps, callerId));
        return pending !== undefined ? { ...view, note: PENDING_NOTE } : view;
      }),
  );
}
