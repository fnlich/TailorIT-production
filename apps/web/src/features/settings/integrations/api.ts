import {
  McpSettingsSchema,
  McpTokenCreatedSchema,
  McpTokenListSchema,
  type McpPendingDecision, // v34 MCPDIR
  type McpSettings,
  type McpSettingsBody,
  type McpTokenCreated,
  type McpTokenList,
} from '@tailorit/shared/mcp';
import { OAUTH_SERVER_METADATA_PATH } from '@tailorit/shared/oauth';
import { z } from 'zod';
import { api } from '@/lib/api';

// Integrations (v1.5 M; v3.1 INTEG: AI assistants › Advanced): the session's routes for personal MCP tokens.

export const MCP_TOKENS_KEY = ['mcp', 'tokens'] as const;

/** GET /api/mcp/tokens: the live tokens (never a secret) and the MCP endpoint's address. */
export function fetchMcpTokens(signal?: AbortSignal): Promise<McpTokenList> {
  return api.get<McpTokenList>('/api/mcp/tokens', { signal, schema: McpTokenListSchema });
}

/** POST /api/mcp/tokens: a new token, its secret shown this once. */
export function createMcpToken(name: string): Promise<McpTokenCreated> {
  return api.post<McpTokenCreated>('/api/mcp/tokens', { name }, { schema: McpTokenCreatedSchema });
}

/** DELETE /api/mcp/tokens/:id: revoked at once. */
export async function revokeMcpToken(id: string): Promise<void> {
  await api.delete(`/api/mcp/tokens/${encodeURIComponent(id)}`);
}

// v1.5 Q1: the person's own AI settings (the revision rounds; the prompt mode, which the MCP tool sets).
export const MCP_SETTINGS_KEY = ['mcp', 'settings'] as const;

/** GET /api/mcp/settings: the defaults until changed. */
export function fetchMcpSettings(signal?: AbortSignal): Promise<McpSettings> {
  return api.get<McpSettings>('/api/mcp/settings', { signal, schema: McpSettingsSchema });
}

/** PUT /api/mcp/settings: the fields given, answered as saved. */
export function saveMcpSettings(body: McpSettingsBody): Promise<McpSettings> {
  return api.put<McpSettings>('/api/mcp/settings', body, { schema: McpSettingsSchema });
}

// v34 MCPDIR: custom instructions the person's AI asked for wait for the person's OK.
/** POST /api/mcp/settings/pending: approve (they become the custom instructions) or discard them. */
export function decidePendingInstructions(decision: McpPendingDecision['decision']): Promise<McpSettings> {
  return api.post<McpSettings>('/api/mcp/settings/pending', { decision }, { schema: McpSettingsSchema });
}
// end v1.5 Q1

// v31 INTEG: TailorIT's own address as Claude and ChatGPT see it. The authorization server's metadata (RFC 8414, served
// beside /mcp at the address people open: Next's rewrites, Caddy's @api_direct block) names its issuer: v34 ORIGIN, the
// address this page is open at (APP_ORIGIN, or a trusted test tunnel's; never the request's Host header). The Connect
// dialog checks it is a public https address.
export const OAUTH_SERVER_KEY = ['oauth', 'server'] as const;

const AuthorizationServerSchema = z.object({ issuer: z.string() });
export type AuthorizationServer = z.infer<typeof AuthorizationServerSchema>;

/** GET /.well-known/oauth-authorization-server: the issuer (v34 ORIGIN: the address this page is open at). */
export function fetchAuthorizationServer(signal?: AbortSignal): Promise<AuthorizationServer> {
  return api.get<AuthorizationServer>(OAUTH_SERVER_METADATA_PATH, { signal, schema: AuthorizationServerSchema });
}
// end v31 INTEG
