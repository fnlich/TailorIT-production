import { adapt, STARTS_WITH_BRACE, type PromptValues, type TailorPromptText } from '../tailor/render';
import { TAILOR_PROMPT, TAILOR_RESUME } from '../tailor/tailor-resume';
import { defineTextPrompt } from '../types';
import { OWN_TAILOR_SAVE, ownParts } from './render';

// v30 ST2: the own-AI tailor's second prompt (v2.0 FIX-C, REQ-6), moved from features/mcp/prompts.ts.
// tailor_builder0's tailor-resume, changed only so the answer goes to own_ai_save's `output` as `resume`
// (OWN_TAILOR_ADAPTATIONS, asserted at load). own_ai_context answers it in two fields, as own-analyze-job-description's.

/** Each sentence the own-AI prompt changes: [tailor_builder0's words, the own-AI prompt's]. */
export const OWN_TAILOR_ADAPTATIONS = [
  [
    'Reply with the JSON object and nothing else.',
    `Write the JSON object and nothing else: it is \`output.resume\` of ${OWN_TAILOR_SAVE}.`,
  ],
  [STARTS_WITH_BRACE, `Send it to ${OWN_TAILOR_SAVE} as \`output.resume\`, with nothing before or after the object`],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const OWN_TAILOR_TEXT: TailorPromptText = {
  id: 'tailor-resume',
  content: adapt(TAILOR_RESUME, 'tailor-resume', OWN_TAILOR_ADAPTATIONS),
  sharedVariables: TAILOR_PROMPT.sharedVariables,
};

/** own_ai_context's `prompt` and `input` for the resume, from tailor-resume's values. */
export const ownTailorParts = (values: PromptValues) => ownParts(OWN_TAILOR_TEXT, values);

export const ownTailorPrompt = defineTextPrompt<{ values: PromptValues }>({
  area: 'mcp',
  name: 'own-tailor-resume',
  version: 1,
  description: "The own-AI tailor's second prompt: the resume for one job against its keyword plan, saved as output.resume of own_ai_save.",
  text: ({ values }) => {
    const parts = ownTailorParts(values);
    return `${parts.prompt}\n\n${parts.input}`;
  },
});
