import { adapt, type TailorPromptText } from '../tailor/render';
import { WRITE_COVER_LETTER, WRITE_LETTER_PROMPT } from '../tailor/write-cover-letter';
import { defineTextPrompt } from '../types';
import { rendered, stepFooter, type StepPromptInput } from './render';

// v30 ST2: the MCP step prompt `write_cover_letter` for a built resume with a keyword analysis, moved from
// features/mcp/prompts.ts. tailor_builder0's write-cover-letter, changed only so the answer goes to a tool
// (MCP_WRITE_LETTER_ADAPTATIONS, asserted at load), rendered for one job. With no analysis the step is
// generate-cover-letter.ts; on an upload's text, upload-cover-letter.ts.

/** Each sentence the MCP prompt changes: [tailor_builder0's words, the MCP prompt's]. */
export const MCP_WRITE_LETTER_ADAPTATIONS = [
  [
    'Return only the letter body as plain text.',
    'Return only the letter body, as {"paragraphs": ["...", "..."]}: one string per paragraph, plain text in each. ' +
      'The paragraphs are the `paragraphs` argument of the prepare_save_cover_letter tool.',
  ],
  [
    'Write the letter body now. Start with its first sentence,',
    'Write the letter body now, as that JSON object. Start its first paragraph with its first sentence,',
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const MCP_WRITE_LETTER_TEXT: TailorPromptText = {
  id: 'write-cover-letter',
  content: adapt(WRITE_COVER_LETTER, 'write-cover-letter', MCP_WRITE_LETTER_ADAPTATIONS),
  sharedVariables: WRITE_LETTER_PROMPT.sharedVariables,
};

/** The letter steps' footer: the call that saves the paragraphs, and what TailorIT does with them. */
export const letterFooter = (jobId: number) =>
  stepFooter(
    jobId,
    `Call prepare_save_cover_letter with {"jobId": ${jobId}, "paragraphs": [...]}.`,
    "TailorIT places it on the cover letter template of the person's profile.",
  );

export const mcpWriteLetterPrompt = defineTextPrompt<StepPromptInput>({
  area: 'mcp',
  name: 'write-cover-letter',
  version: 1,
  description:
    "The step `write_cover_letter` for the person's AI on a built resume with the job's keyword analysis, saved with prepare_save_cover_letter.",
  text: ({ jobId, values }) => rendered(MCP_WRITE_LETTER_TEXT, values, true, letterFooter(jobId)),
});
