import type { AppDeps } from '../../core/context';
import { heldGrants, type LiveGrant } from '../../core/auth/grants';
import { INSTRUCTIONS_V, instructionsText, PROFILE_ALLOWS, type InstructionProfile } from '../../ai/prompts/mcp/instructions';
import { mcpSettings, mcpSettingsChangedAt } from './settings';
import { firstNameOf } from './profiles';

// v30 ST2: the instructions' words (DEFAULT_MCP_INSTRUCTIONS, the <person> fence, the step preferences) are in the
// prompt catalogue (ai/prompts/mcp/instructions.ts, person-block.ts, step-preferences.ts); this file serves them.
// v2.0 P5 (docs/design/v2.0/07-mcp.md, "The instructions served to the AI"): the rules TailorIT serves to the person's
// own AI, with no setup. The MCP server's `instructions` (sent in the initialize result) is this text, built per
// request with the person's custom instructions (mcp_settings.custom_instructions) after the platform rules. Clients
// that ignore `instructions` get the same text from the tool `instructions` and the prompt `prepare_all`; until a
// token has read them that way, the answers of filter_jobs and prepare_queue say so (v34 MCPDIR: as neutral metadata,
// {"instructions": {"v": <version>, "read": false}}, no longer the line "call instructions first").
// The custom text cannot change what the server allows: prepare_start runs the saved filters again, and every limit is
// checked by the service a tool calls. DECISIONS A29 adds R7: the letter and the answers agree with the resume the
// person's mode chose, which the AI never replaces.
// v33 SHARE-8 (PLAN-sharing.md §7 "Instructions v3"): the CALLER's (the token's person's) instructions, with the
// PROFILES list of the live grants that let their AI in (reachableProfiles with `mcp`). Only the caller's custom
// instructions are ever sent, never a profile owner's. The mark also comes back when a grant of the caller's changed
// (profile_grants.changed_at: shared, boxes changed, ended) after the token's last read.

/** A grant as the PROFILES list shows it: its key, its owner's first name, what it lets the AI do. */
export function instructionProfileOf(grant: LiveGrant): InstructionProfile {
  return {
    key: grant.id,
    name: firstNameOf(grant.owner.name, 'Owner'),
    allows: PROFILE_ALLOWS.filter(([perm]) => (grant.permissions as readonly string[]).includes(perm)).map(([, words]) => words),
  };
}

/** The caller's instructions as the server and the tool `instructions` serve them, with the profiles `grants` share. */
export async function instructionsFor(
  deps: Pick<AppDeps, 'db'>,
  caller: { id: string; name: string },
  grants: readonly LiveGrant[],
): Promise<string> {
  return instructionsText((await mcpSettings(deps, caller.id)).customInstructions, {
    caller: caller.name,
    profiles: grants.map(instructionProfileOf),
  });
}

// --------------------------------------------------------------------------------------------- the read mark

/**
 * v34 MCPDIR: what an answer carries while the token has not read the current instructions: their version, unread.
 * Neutral metadata (the tool `instructions` answers {v, text}); it replaced the line "call instructions first".
 */
export const INSTRUCTIONS_UNREAD = { v: INSTRUCTIONS_V, read: false } as const;
/** The answer field that carries it. */
export type UnreadMark = { instructions?: typeof INSTRUCTIONS_UNREAD };

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
 * `{instructions: {v, read: false}}` while the token's AI has not read the instructions since the person last changed
 * their settings (custom instructions included), or (v33 SHARE-8) since one of their grants changed (a profile shared
 * with them, its boxes changed, or its end); else nothing.
 */
export async function unreadInstructions(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  callerId: string,
  tokenId: string | null,
): Promise<UnreadMark> {
  if (!tokenId) return {};
  const unread: UnreadMark = { instructions: INSTRUCTIONS_UNREAD };
  const readAt = reads.get(tokenId);
  if (readAt === undefined) return unread;
  const changed = await mcpSettingsChangedAt(deps, callerId);
  if (changed !== null && Date.parse(changed) > readAt) return unread;
  // v33 SHARE-8: the newest change of a grant of the caller's (heldGrants: newest first).
  const newest = (await heldGrants(deps, callerId))[0];
  return newest && Date.parse(newest.changedAt) > readAt ? unread : {};
}
