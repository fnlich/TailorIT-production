import { ANALYZE_JOB_DESCRIPTION } from '../tailor/analyze-job-description';
import { adapt, type PromptValues, type TailorPromptText } from '../tailor/render';
import { defineTextPrompt } from '../types';
import { OWN_TAILOR_SAVE, ownParts } from './render';

// v30 ST2: the own-AI tailor's first prompt (v2.0 FIX-C, REQ-6: own_ai_context {feature: "tailor"}, own-ai-tailor.ts),
// moved from features/mcp/prompts.ts. tailor_builder0's analyze-job-description, changed only so the answer goes to
// own_ai_save's `output` as `analysis` instead of a Prepare save (OWN_ANALYZE_ADAPTATIONS, asserted at load).
// own_ai_context answers it in two fields: `prompt` (the instructions and the posting rule) and `input` (the data);
// the catalogue's text joins them, as the person's AI reads them.

/** Each sentence the own-AI prompt changes: [tailor_builder0's words, the own-AI prompt's]. */
export const OWN_ANALYZE_ADAPTATIONS = [
  [
    'Return only this JSON object, with no markdown or commentary.',
    `Write only this JSON object, with no markdown or commentary: it is \`output.analysis\` of ${OWN_TAILOR_SAVE}.`,
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const OWN_ANALYZE_TEXT: TailorPromptText = {
  id: 'analyze-job-description',
  content: adapt(ANALYZE_JOB_DESCRIPTION, 'analyze-job-description', OWN_ANALYZE_ADAPTATIONS),
  sharedVariables: [],
};

/** own_ai_context's `prompt` and `input` for the analysis, from analyze-job-description's values. */
export const ownAnalyzeParts = (values: PromptValues) => ownParts(OWN_ANALYZE_TEXT, values);

export const ownAnalyzePrompt = defineTextPrompt<{ values: PromptValues }>({
  area: 'mcp',
  name: 'own-analyze-job-description',
  version: 1,
  description: "The own-AI tailor's first prompt: the posting's ATS keywords, saved as output.analysis of own_ai_save.",
  text: ({ values }) => {
    const parts = ownAnalyzeParts(values);
    return `${parts.prompt}\n\n${parts.input}`;
  },
});
