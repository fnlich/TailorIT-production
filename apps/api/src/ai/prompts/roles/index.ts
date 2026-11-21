import type { CatalogPrompt } from '../types';
import { familyOverlayPrompt } from './family-overlay';
import { fieldsGuidePrompt } from './fields-guide';
import { voiceLinePrompt } from './voice-line';

// v33 PROMPTS (F5): the roles area: the words that make TailorIT's prompts follow the kind of work (the role family).
// - slots.ts: the sentences of tailor_builder0's six prompts a family's rendering words differently;
// - archetypes.ts: each slot's template, filled from a family's words and its archetype's numbers;
// - pack.ts and packs/: each non-technical family's vocabulary (the technical family has none: its prompts are
//   tailor_builder0's, word for word), and the archetypes' defaults;
// - variants.ts: familyText (memoised), the voice line, the FIELDS lines.
// The catalogue lists what other prompts quote: the overlay of a prompt, the FIELDS guide and the voice line.
export const ROLES_PROMPTS: readonly CatalogPrompt[] = [familyOverlayPrompt, fieldsGuidePrompt, voiceLinePrompt];
