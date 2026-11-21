import type { RoleFamilyId } from '@tailorit/shared';
import { defineTextPrompt } from '../types';
import type { TailorPromptId } from './slots';
import { familyChanges } from './variants';

// v33 PROMPTS (F5): the catalogue's view of a role family's overlay of one of tailor_builder0's prompts: each slot's
// original words and the family's (none for the technical family). The tailor area's modules, and the mcp area's
// renderings of them, apply it through adapt() before their own adaptations (variants.ts familyText).

export interface FamilyOverlayInput {
  prompt: TailorPromptId;
  family: RoleFamilyId;
}

export const familyOverlayPrompt = defineTextPrompt<FamilyOverlayInput>({
  area: 'roles',
  name: 'family-overlay',
  version: 1,
  description: "A role family's words for the slots of one tailor_builder0 prompt (the original's, then the family's).",
  text: ({ prompt, family }) =>
    familyChanges(prompt, family)
      .map(([from, to]) => `${from}\n=> ${to}`)
      .join('\n\n'),
});
