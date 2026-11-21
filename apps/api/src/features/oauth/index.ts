import type { Feature } from '../../core/feature';
import { OAUTH_ACTING } from './acting'; // v33 SHARE-8
import { createOAuthEndpointsRouter } from './endpoints';
import { OAUTH_DAILY } from './housekeeping';
import { createOAuthRouter } from './router';
import { createWellKnownRouter } from './well-known';

// v3.1 OAUTH (docs/design/v3.1/23-mcp-oauth.md; PLAN §4 OAUTH, decisions D6 and D7): TailorIT's own OAuth 2.1
// authorization server, so Claude and ChatGPT connect to the MCP server (features/mcp) with a few clicks and a consent
// page, as with Notion's MCP. Our own handlers, opaque tokens stored as SHA-256 (tokens.ts), no new dependency:
// - well-known.ts: the discovery documents (RFC 9728, RFC 8414), early at /.well-known;
// - endpoints.ts: /oauth/authorize, /oauth/register, /oauth/token, /oauth/revoke, early at /oauth;
// - router.ts: the consent page's calls and the connected apps' list, at /api/oauth (the session);
// - housekeeping.ts: the records' daily pruning.
// The MCP endpoint reads `tio_` tokens through tokens.ts resolveOAuthAccessToken (features/mcp/tokens.ts).

export const oauthFeature: Feature = {
  name: 'oauth',
  routes: [{ path: '/api/oauth', router: createOAuthRouter, acting: OAUTH_ACTING /* v33 SHARE-8 */ }],
  earlyRoutes: [
    { path: '/.well-known', router: createWellKnownRouter },
    { path: '/oauth', router: createOAuthEndpointsRouter },
  ],
  daily: OAUTH_DAILY,
};
