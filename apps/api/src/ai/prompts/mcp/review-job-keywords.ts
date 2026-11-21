import { REVIEW_JOB_KEYWORDS } from '../tailor/review-job-keywords';
import { adapt, type TailorPromptText } from '../tailor/render';
import { familyText, perFamily } from '../roles/variants';
import { defineTextPrompt } from '../types';
import { rendered, stepFooter, type StepPromptInput } from './render';

// v30 ST2: the MCP step prompt `review`, moved from features/mcp/prompts.ts. tailor_builder0's review-job-keywords,
// changed only so the answer goes to a tool (MCP_REVIEW_ADAPTATIONS, asserted at load), rendered for one job.

/** Each sentence the MCP prompt changes: [tailor_builder0's words, the MCP prompt's]. */
export const MCP_REVIEW_ADAPTATIONS = [
  [
    'Return only this JSON object, with an empty array if nothing is missing.',
    'Write only this JSON object, with an empty array if nothing is missing: its `missing` array is the `missing` ' +
      'argument of the prepare_save_analysis tool.',
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const MCP_REVIEW_TEXT: TailorPromptText = {
  id: 'review-job-keywords',
  content: adapt(REVIEW_JOB_KEYWORDS, 'review-job-keywords', MCP_REVIEW_ADAPTATIONS),
  sharedVariables: [],
};

/** v33 PROMPTS (F5): the step in the job's family's words, then the MCP adaptations; technical: MCP_REVIEW_TEXT. */
export const mcpReviewTextFor = perFamily(
  (family): TailorPromptText => ({
    ...MCP_REVIEW_TEXT,
    content: adapt(familyText(REVIEW_JOB_KEYWORDS, 'review-job-keywords', family), 'review-job-keywords', MCP_REVIEW_ADAPTATIONS),
  }),
);

export const mcpReviewPrompt = defineTextPrompt<StepPromptInput>({
  area: 'mcp',
  name: 'review-job-keywords',
  version: 1,
  description: "The step `review` for the person's AI: the keywords the first pass missed, saved with prepare_save_analysis.",
  text: ({ jobId, values, family }) =>
    rendered(
      mcpReviewTextFor(family),
      values,
      true,
      stepFooter(
        jobId,
        `Call prepare_save_analysis with {"jobId": ${jobId}, "missing": <the "missing" array>} (an empty array when nothing is missing).`,
        "TailorIT adds the keywords it finds in the posting to the first pass; the save's answer names the next step.",
      ),
    ),
});
