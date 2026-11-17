import {
  McpUnsupportedClearedSchema,
  McpUnsupportedListSchema,
  type McpUnsupportedCleared,
  type McpUnsupportedList,
} from '@tailorit/shared/mcp';
import { api } from '@/lib/api';

// v1.5 Q2: the session's routes for the reports of the person's own AI (report_unsupported).

export const MCP_UNSUPPORTED_KEY = ['mcp', 'unsupported'] as const;

/** GET /api/mcp/unsupported: the reports, newest first. */
export function fetchUnsupported(signal?: AbortSignal): Promise<McpUnsupportedList> {
  return api.get<McpUnsupportedList>('/api/mcp/unsupported', { signal, schema: McpUnsupportedListSchema });
}

/** DELETE /api/mcp/unsupported/:id. */
export async function deleteUnsupported(id: string): Promise<void> {
  await api.delete(`/api/mcp/unsupported/${encodeURIComponent(id)}`);
}

/** DELETE /api/mcp/unsupported: every report. */
export function clearUnsupported(): Promise<McpUnsupportedCleared> {
  return api.delete<McpUnsupportedCleared>('/api/mcp/unsupported', { schema: McpUnsupportedClearedSchema });
}
