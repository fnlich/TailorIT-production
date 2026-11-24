import { defineTextPrompt } from '../types';

// v30 ST2: the MCP prompt `prepare_all` (v2.0 P5, 07-mcp.md), moved from features/mcp/prompts.ts: the instructions
// served to the person's AI (instructions.ts, with their custom instructions), then where to start. For a client that
// ignores the server's `instructions`.
// v33 SHARE-8 (PLAN-sharing.md §7): with other profiles shared with the person, "prepare all" loops filter, verdicts and
// start on each profile they name ("all": every profile in PROFILES, theirs first), then calls prepare_queue.

/** prepare_all: the instructions served to the person's AI, then where to start (on every profile when there are others). */
export function prepareAllText(instructions: string, otherProfiles = false): string {
  const start = otherProfiles
    ? 'Start with filter_jobs {"scope": "saved", "profile": "me"}. For "all profiles" (or the ones the person names): ' +
      'filter_jobs, custom_filter_verdicts when "custom" asks, and prepare_start on each profile in PROFILES, "me" first, ' +
      'each call with its "profile"; then prepare_queue.'
    : 'Start with filter_jobs {"scope": "saved"}.';
  return `${instructions}\n\n${start}`;
}

export const prepareAllPrompt = defineTextPrompt<{ instructions: string; otherProfiles?: boolean }>({
  area: 'mcp',
  name: 'prepare-all',
  version: 2,
  description:
    "The MCP prompt prepare_all: TailorIT's instructions for the person's AI, then where preparing starts (on each profile when others are shared).",
  text: ({ instructions, otherProfiles }) => prepareAllText(instructions, otherProfiles),
});
