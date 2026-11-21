import type { ActingSpec } from '../../core/feature';

// v33 SHARE-8 (PLAN F9 "Always locked"; SP v33 PLAN-sharing.md §3): the MCP web routes are the signed-in person's own
// and are never used on a shared profile: A's MCP tokens (and who may hold one), A's own AI settings and custom
// instructions, and the reports of A's AI. A tab acting on A's profile is refused (own_profile_only) on every one of
// them. B's own AI reaches A's profile only through B's own token and the `profile` argument of the MCP tools
// (features/mcp/profiles.ts), checked against the grant on every call. The MCP endpoint itself (/mcp) is an early route:
// it reads no session and no profile header.

/** /api/mcp/settings: the person's own AI settings and custom instructions. */
export const MCP_SETTINGS_ACTING: ActingSpec = 'never';

/** /api/mcp: the person's MCP tokens. */
export const MCP_TOKENS_ACTING: ActingSpec = 'never';

/** /api/mcp/unsupported: what the person's AI reported it could not do. */
export const MCP_REPORTS_ACTING: ActingSpec = 'never';
