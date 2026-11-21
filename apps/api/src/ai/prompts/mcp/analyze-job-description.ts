import { ANALYZE_JOB_DESCRIPTION } from '../tailor/analyze-job-description';
import { adapt, type TailorPromptText } from '../tailor/render';
import { familyText, perFamily } from '../roles/variants';
import { defineTextPrompt } from '../types';
import { rendered, stepFooter, type StepPromptInput } from './render';

// v30 ST2: the MCP step prompt `analyze` (prepare_prompt, and the MCP prompt of that name), moved from
// features/mcp/prompts.ts. tailor_builder0's analyze-job-description (the tailor area's, word for word), changed only so
// the answer goes to a tool instead of into a reply (MCP_ANALYZE_ADAPTATIONS, asserted at load), rendered for one job.

/** Each sentence the MCP prompt changes: [tailor_builder0's words, the MCP prompt's]. */
export const MCP_ANALYZE_ADAPTATIONS = [
  [
    'Return only this JSON object, with no markdown or commentary.',
    'Write only this JSON object, with no markdown or commentary: it is the `analysis` argument of the ' +
      'prepare_save_analysis tool.',
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const MCP_ANALYZE_TEXT: TailorPromptText = {
  id: 'analyze-job-description',
  content: adapt(ANALYZE_JOB_DESCRIPTION, 'analyze-job-description', MCP_ANALYZE_ADAPTATIONS),
  sharedVariables: [],
};

/** v33 PROMPTS (F5): the step in the job's family's words, then the MCP adaptations; technical: MCP_ANALYZE_TEXT. */
export const mcpAnalyzeTextFor = perFamily(
  (family): TailorPromptText => ({
    ...MCP_ANALYZE_TEXT,
    content: adapt(familyText(ANALYZE_JOB_DESCRIPTION, 'analyze-job-description', family), 'analyze-job-description', MCP_ANALYZE_ADAPTATIONS),
  }),
);

export const mcpAnalyzePrompt = defineTextPrompt<StepPromptInput>({
  area: 'mcp',
  name: 'analyze-job-description',
  version: 1,
  description: "The step `analyze` for the person's AI: the posting's ATS keywords, saved with prepare_save_analysis.",
  text: ({ jobId, values, family }) =>
    rendered(
      mcpAnalyzeTextFor(family),
      values,
      true,
      stepFooter(
        jobId,
        `Call prepare_save_analysis with {"jobId": ${jobId}, "analysis": <the JSON object>}.`,
        "TailorIT keeps only the keywords the posting really contains; the save's answer names the next step.",
      ),
    ),
});
