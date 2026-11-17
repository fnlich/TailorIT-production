import {
  McpSettingsSchema,
  McpTokenCreatedSchema,
  McpTokenListSchema,
  type McpSettings,
  type McpSettingsBody,
  type McpTokenCreated,
  type McpTokenList,
} from '@tailorit/shared/mcp';
import { api } from '@/lib/api';

// Settings › Integrations › "Your own AI (MCP)" (v1.5 M): the session's routes for personal MCP tokens.

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
// end v1.5 Q1
