import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { APP_NAME } from '@tailorit/shared';
import { brandIconsOn } from '@tailorit/shared/public-pages'; // v34 INT-A

// v34 MCPDIR (PLAN G8 "Server info"): what the MCP server says about itself in its initialize answer (serverInfo):
// its name, the title a client shows ("TailorIT"), the app's release (APP_RELEASE, passed in by index.ts), its public
// web address, and the brand icons the web app serves under /brand/ (PUBLIC makes them from the current mark).

/** The server's protocol name (clients key their settings by it; never changes). */
export const MCP_SERVER_NAME = 'tailorit';
/** What the server is, in one sentence. */
export const MCP_SERVER_DESCRIPTION = 'Job search, a Job Tracker and application kits your own AI writes.';

/**
 * serverInfo for an MCP client: `origin` is the public web origin the person reaches TailorIT on (the request's own
 * trusted public origin: APP_ORIGIN or a trusted test tunnel, endpoint.ts), with or without a trailing slash. v34 INT-A
 * (PUBLIC's exact edit 3): the icons are the shared contract's (@tailorit/shared/public-pages BRAND_ICONS, the files
 * under apps/web/public/brand/), PNG 512, 256 and 64, then the SVG.
 */
export function mcpServerInfo(version: string, origin: string): Implementation {
  const base = origin.replace(/\/+$/, '');
  return {
    name: MCP_SERVER_NAME,
    title: APP_NAME,
    // v34 MCPDIR (the directory review, finding 13): one sentence (2025-11-25's Implementation.description).
    description: MCP_SERVER_DESCRIPTION,
    version,
    websiteUrl: base,
    icons: brandIconsOn(base),
  };
}
