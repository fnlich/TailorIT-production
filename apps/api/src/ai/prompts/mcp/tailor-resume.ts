import { adapt, STARTS_WITH_BRACE, type TailorPromptText } from '../tailor/render';
import { TAILOR_PROMPT, TAILOR_RESUME } from '../tailor/tailor-resume';
import { defineTextPrompt } from '../types';
import { rendered, stepFooter, type StepPromptInput } from './render';

// v30 ST2: the MCP step prompt `tailor`, moved from features/mcp/prompts.ts. tailor_builder0's tailor-resume, changed
// only so the answer goes to a tool (MCP_TAILOR_ADAPTATIONS, asserted at load), rendered for one job. Its shared
// variables are tailor_builder0's: they stay in the fixed part, before the data.

/** Each sentence the MCP prompt changes: [tailor_builder0's words, the MCP prompt's]. */
export const MCP_TAILOR_ADAPTATIONS = [
  [
    'Reply with the JSON object and nothing else.',
    'Write the JSON object and nothing else: it is the `resume` argument of the prepare_save_resume tool.',
  ],
  [STARTS_WITH_BRACE, 'Send it to prepare_save_resume as `resume`, with nothing before or after the object'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const MCP_TAILOR_TEXT: TailorPromptText = {
  id: 'tailor-resume',
  content: adapt(TAILOR_RESUME, 'tailor-resume', MCP_TAILOR_ADAPTATIONS),
  sharedVariables: TAILOR_PROMPT.sharedVariables,
};

export const mcpTailorPrompt = defineTextPrompt<StepPromptInput>({
  area: 'mcp',
  name: 'tailor-resume',
  version: 1,
  description: "The step `tailor` for the person's AI: the resume for one job against its keyword plan, saved with prepare_save_resume.",
  text: ({ jobId, values }) =>
    rendered(
      MCP_TAILOR_TEXT,
      values,
      true,
      stepFooter(
        jobId,
        `Call prepare_save_resume with {"jobId": ${jobId}, "resume": <the JSON object>}.`,
        'TailorIT keeps the employers, titles, dates and figures of the resume, scores it against the job and answers ' +
          'with what to revise and the next step.',
      ),
    ),
});
