import { adapt, STARTS_WITH_BRACE, type TailorPromptText } from '../tailor/render';
import { REVISE_RESUME_ATS } from '../tailor/revise-resume-ats';
import { defineTextPrompt } from '../types';
import { rendered, stepFooter, type StepPromptInput } from './render';

// v30 ST2: the MCP step prompt `revise`, moved from features/mcp/prompts.ts. tailor_builder0's revise-resume-ats,
// changed only so the answer goes to a tool (MCP_REVISE_ADAPTATIONS, asserted at load), rendered for one job and the
// round's issues. It quotes no posting text.

/** Each sentence the MCP prompt changes: [tailor_builder0's words, the MCP prompt's]. */
export const MCP_REVISE_ADAPTATIONS = [
  [
    'Reply with the JSON object and nothing else, with no code fence and no text before or after it.',
    'Write the JSON object and nothing else, with no code fence and no text before or after it: it is the ' +
      '`revision` argument of the prepare_save_resume tool.',
  ],
  [STARTS_WITH_BRACE, 'Send it to prepare_save_resume as `revision`, with nothing before or after the object'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const MCP_REVISE_TEXT: TailorPromptText = {
  id: 'revise-resume-ats',
  content: adapt(REVISE_RESUME_ATS, 'revise-resume-ats', MCP_REVISE_ADAPTATIONS),
  sharedVariables: [],
};

export const mcpRevisePrompt = defineTextPrompt<StepPromptInput>({
  area: 'mcp',
  name: 'revise-resume-ats',
  version: 1,
  description: "The step `revise` for the person's AI: the edits that fix a round's issues, saved with prepare_save_resume.",
  text: ({ jobId, values }) =>
    rendered(
      MCP_REVISE_TEXT,
      values,
      false,
      stepFooter(
        jobId,
        `Call prepare_save_resume with {"jobId": ${jobId}, "revision": <the JSON object>}. Leave "coverLetter" empty: ` +
          'the letter is saved on its own, with prepare_save_cover_letter.',
        'TailorIT applies the edits to the resume it kept, scores it again and answers with what is still to fix.',
      ),
    ),
});
