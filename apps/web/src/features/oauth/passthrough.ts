// v3.1 OAUTH: the paths outside /api that the web server passes on to the API (next.config.ts's rewrites; the
// production reverse proxy routes the same ones, DEPLOYMENT.md), so Claude and ChatGPT reach the MCP endpoint and
// TailorIT's OAuth server at the address people open (APP_ORIGIN). The sign-in gate (proxy.ts) never redirects them.
// No imports: next.config.ts loads this file before Next compiles anything. passthrough.test.ts keeps it in step with
// packages/shared/src/oauth (OAUTH_API_PATHS, the well-known paths) and with proxy.ts's matcher.

/** Rewrite sources (Next's path syntax), each to the same path on the API. */
export const API_PASSTHROUGH_SOURCES = [
  '/mcp',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/:path*',
  '/.well-known/oauth-authorization-server',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
] as const;

/** next.config.ts's rewrites for them, to `apiOrigin`. */
export function apiPassthroughRewrites(apiOrigin: string): Array<{ source: string; destination: string }> {
  return API_PASSTHROUGH_SOURCES.map((source) => ({ source, destination: `${apiOrigin}${source}` }));
}

/**
 * The consent page is never shown in a frame (clickjacking), and its address (which carries the request's id) is never
 * sent on as a Referer to the app it leads to: next.config.ts's headers for it.
 */
export const CONSENT_PAGE_HEADERS = {
  source: '/oauth/consent',
  headers: [
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
  ],
};
