import type { AppDeps } from '../../core/context';
import { instructionsText } from '../../ai/prompts/mcp/instructions';
import { mcpSettings, mcpSettingsChangedAt } from './settings';

// v30 ST2: the instructions' words (DEFAULT_MCP_INSTRUCTIONS, the <person> fence, the step preferences) are in the
// prompt catalogue (ai/prompts/mcp/instructions.ts, person-block.ts, step-preferences.ts); this file serves them.
// v2.0 P5 (docs/design/v2.0/07-mcp.md, "The instructions served to the AI"): the rules TailorIT serves to the person's
// own AI, with no setup. The MCP server's `instructions` (sent in the initialize result) is this text, built per
// request with the person's custom instructions (mcp_settings.custom_instructions) after the platform rules. Clients
// that ignore `instructions` get the same text from the tool `instructions` and the prompt `prepare_all`; until a
// token has read them that way, the first answers of filter_jobs and prepare_queue carry a one-line pointer (RULES_POINTER).
// The custom text cannot change what the server allows: prepare_start runs the saved filters again, and every limit is
// checked by the service a tool calls. DECISIONS A29 adds R7: the letter and the answers agree with the resume the
// person's mode chose, which the AI never replaces.

/** The account's instructions as the server and the tool `instructions` serve them. */
export async function instructionsFor(deps: Pick<AppDeps, 'db'>, userId: string): Promise<string> {
  return instructionsText((await mcpSettings(deps, userId)).customInstructions);
}

// --------------------------------------------------------------------------------------------- the read pointer

/** The pointer an answer carries while the token has not read the instructions. */
export const RULES_POINTER = 'call instructions first';

/** Tokens whose AI read the instructions (tool or prompt), and when: in memory, as a session is (the server is stateless). */
const reads = new Map<string, number>();
/** The most tokens remembered; the oldest read is forgotten first. */
const READS_KEPT = 10_000;

/** Notes that `tokenId`'s AI read the instructions now. */
export function noteInstructionsRead(tokenId: string | null, at: Date): void {
  if (!tokenId) return;
  reads.delete(tokenId);
  reads.set(tokenId, at.getTime());
  if (reads.size > READS_KEPT) reads.delete(reads.keys().next().value!);
}

/**
 * `{rules: "call instructions first"}` while the token's AI has not read the instructions since the person last changed
 * their settings (custom instructions included); else nothing.
 */
export async function rulesPointer(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  tokenId: string | null,
): Promise<{ rules?: string }> {
  if (!tokenId) return {};
  const readAt = reads.get(tokenId);
  if (readAt === undefined) return { rules: RULES_POINTER };
  const changed = await mcpSettingsChangedAt(deps, userId);
  return changed !== null && Date.parse(changed) > readAt ? { rules: RULES_POINTER } : {};
}
