import { defineTextPrompt } from '../types';
import { personBlock } from './person-block';

// v30 ST2: what every MCP step prompt ends with when the person wrote custom instructions, moved word for word from
// features/mcp/instructions.ts (07-mcp.md, "The person's preferences for this step").
// v33 SHARE-8: R1-R8 (R8, each profile a different person, joined the platform rules); version 2.

/**
 * The custom instructions as a step prompt ends with them (prepare_prompt, both prompt modes); empty when there are
 * none, so a prompt without them stays byte for byte the same (a client's cache keeps it).
 */
export function stepPreferences(custom: string): string {
  if (!custom.trim()) return '';
  return (
    "THE PERSON'S PREFERENCES FOR THIS STEP (they apply where they do not conflict with this prompt's rules or " +
    `TailorIT's platform rules R1-R8)\n${personBlock(custom)}`
  );
}

export const stepPreferencesPrompt = defineTextPrompt<{ custom: string }>({
  area: 'mcp',
  name: 'step-preferences',
  version: 2,
  description: "What a step prompt ends with: the person's custom instructions as preferences for the step, below its rules (empty for none).",
  text: ({ custom }) => stepPreferences(custom),
});
