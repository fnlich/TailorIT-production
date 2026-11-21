import { GENERATE_COVER_LETTER } from '../tailor/generate-cover-letter';
import { adapt, type TailorPromptText } from '../tailor/render';
import { defineTextPrompt } from '../types';
import { familyText, perFamily } from '../roles/variants';
import { rendered, type StepPromptInput } from './render';
import { letterFooter } from './write-cover-letter';

// v30 ST2: the MCP step prompt `write_cover_letter` for a built resume with no keyword analysis, moved from
// features/mcp/prompts.ts. tailor_builder0's generate-cover-letter, changed only so the answer goes to a tool
// (MCP_GENERATE_LETTER_ADAPTATIONS, asserted at load), rendered for one job.

/** Each sentence the MCP prompt changes: [tailor_builder0's words, the MCP prompt's]. */
export const MCP_GENERATE_LETTER_ADAPTATIONS = [
  [
    'Return ONLY the cover letter body text, no JSON or other formatting.',
    'Return ONLY the cover letter body, as {"paragraphs": ["...", "..."]}: one string per paragraph, no other ' +
      'formatting. The paragraphs are the `paragraphs` argument of the prepare_save_cover_letter tool.',
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const MCP_GENERATE_LETTER_TEXT: TailorPromptText = {
  id: 'generate-cover-letter',
  content: adapt(GENERATE_COVER_LETTER, 'generate-cover-letter', MCP_GENERATE_LETTER_ADAPTATIONS),
  sharedVariables: [],
};

/** v33 PROMPTS (F5): the step in the person's family's words, then the MCP adaptations; technical: MCP_GENERATE_LETTER_TEXT. */
export const mcpGenerateLetterTextFor = perFamily(
  (family): TailorPromptText => ({
    ...MCP_GENERATE_LETTER_TEXT,
    content: adapt(
      familyText(GENERATE_COVER_LETTER, 'generate-cover-letter', family),
      'generate-cover-letter',
      MCP_GENERATE_LETTER_ADAPTATIONS,
    ),
  }),
);

export const mcpGenerateLetterPrompt = defineTextPrompt<StepPromptInput>({
  area: 'mcp',
  name: 'generate-cover-letter',
  version: 1,
  description:
    "The step `write_cover_letter` for the person's AI on a built resume with no keyword analysis, saved with prepare_save_cover_letter.",
  text: ({ jobId, values, family }) => rendered(mcpGenerateLetterTextFor(family), values, true, letterFooter(jobId)),
});
