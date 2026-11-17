import { MCP_PATH } from '@tailorit/shared/mcp';
import type { Feature } from '../../core/feature';
import { createMcpEndpoint } from './endpoint';
import { prepareService } from './prepare';
import { createMcpReportsRouter } from './reports-router'; // v1.5 Q2
import { createMcpTokensRouter } from './router';
import { createMcpSettingsRouter } from './settings-router';

// v1.5 M (decision 5 of the v1.5 plan): Prepare with the person's own AI. TailorIT's MCP server (Streamable HTTP at
// /mcp on the API, endpoint.ts and server.ts) lets an AI client the person runs on their own plan write the Prepare
// drafts: it reads one job's context (tools.ts), gets tailor_builder0's prompts rendered for the job (prompts.ts),
// and saves what it wrote; TailorIT runs v1.4's code steps on it (save.ts: keyword filtering, humanize, protected
// facts, the ATS score, the finishing) and stores it in work package P's drafts (prepare.ts, the only file that
// touches P's Prepare). The client authenticates with a personal MCP token (tokens.ts, migration 0816), made and
// revoked in Settings › Integrations (router.ts, the session's /api/mcp/tokens). TailorIT's own Claude is never called.

/** The server's version as MCP clients see it. */
export const MCP_SERVER_VERSION = '2.0.0';

export const mcpFeature: Feature = {
  name: 'mcp',
  routes: [
    // v1.5 Q1: the person's own AI settings (revision rounds, prompt mode).
    { path: '/api/mcp/settings', router: createMcpSettingsRouter },
    { path: '/api/mcp', router: createMcpTokensRouter },
    // v1.5 Q2: Settings › Integrations › "Requests your AI could not do".
    { path: '/api/mcp/unsupported', router: createMcpReportsRouter },
  ],
  earlyRoutes: [{ path: MCP_PATH, router: (deps) => createMcpEndpoint(deps, prepareService, MCP_SERVER_VERSION) }],
};
