import { defineTextPrompt } from '../types';

// v30 ST2: the MCP prompt `prepare_all` (v2.0 P5, 07-mcp.md), moved from features/mcp/prompts.ts: the instructions
// served to the person's AI (instructions.ts, with their custom instructions), then where to start. For a client that
// ignores the server's `instructions`.

/** prepare_all: the instructions served to the person's AI, then where to start. */
export function prepareAllText(instructions: string): string {
  return `${instructions}\n\nStart with filter_jobs {"scope": "saved"}.`;
}

export const prepareAllPrompt = defineTextPrompt<{ instructions: string }>({
  area: 'mcp',
  name: 'prepare-all',
  version: 1,
  description: "The MCP prompt prepare_all: TailorIT's instructions for the person's AI, then where Prepare & Queue starts.",
  text: ({ instructions }) => prepareAllText(instructions),
});
