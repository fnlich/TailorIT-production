import type { RoleFamilyId } from '@tailorit/shared';
import { defineTextPrompt } from '../types';
import { familyVoice } from './variants';

// v33 PROMPTS (F5): the one line TailorIT's own person-side prompts add for the person's field (the letters, the
// autofill drafts and answers, the entry bullets): the words of their own work. Empty for the technical family, so
// those prompts' pinned words stay as they were.

export const voiceLinePrompt = defineTextPrompt<{ family?: RoleFamilyId | null }>({
  area: 'roles',
  name: 'voice-line',
  version: 1,
  description: "The line a person-side prompt adds for the person's field (empty for the technical family).",
  text: ({ family }) => familyVoice(family),
});
