import path from 'node:path';
import type { NextConfig } from 'next';
import { allowedDevOrigins, apiOrigin as apiOriginFrom } from './src/lib/addresses';
import { apiPassthroughRewrites, CONSENT_PAGE_HEADERS } from './src/features/oauth/passthrough'; // v31 OAUTH

// Addresses come from the root .env (scripts/next-launch.mjs loads it): API_INTERNAL_URL, else API_HOST and API_PORT,
// for the /api rewrite; WEB_HOST, APP_ORIGIN and (v34 ORIGIN) DEV_ALLOWED_ORIGINS's exact hosts for the dev server's
// allowed origins (hot reload over today's test tunnel, opted in; never a pattern; v34 ORIGIN2: and the hosts of
// TRUSTED_PUBLIC_HOSTS's exact addresses, such as a LAN address another device opens). `next build` writes the rewrite
// into the build, so a production server needs `npm run build` again after the API's address changes (not after
// APP_ORIGIN's).
const apiOrigin = apiOriginFrom(process.env);

const nextConfig: NextConfig = {
  // A build of its own for the layout check (scripts/verify-layout.mjs), so it never replaces the app's `.next`.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Next 16.3+ writes AGENTS.md / CLAUDE.md into the app when an AI agent starts `next dev`; the repository's own
  // docs are the instructions (same reasoning as free_tailor's next.config.ts).
  agentRules: false,
  // Workspace packages ship TypeScript (and TSX) source.
  transpilePackages: ['@tailorit/shared', '@tailorit/resume-templates'],
  // The resume editor's addresses while it was being built: bookmarks and a new resume's address with its draft id
  // (?template=&draft=, the query goes along) still open, at the resume pages' own addresses.
  async redirects() {
    return [{ source: '/resumes-next/:path*', destination: '/resumes/:path*', permanent: false }];
  },
  // The browser only ever talks to this origin; /api is proxied to Express so the session cookie is first-party.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      // v31 OAUTH: the MCP endpoint and the OAuth server, at the address people open (Claude and ChatGPT connect there).
      ...apiPassthroughRewrites(apiOrigin),
    ];
  },
  // v31 OAUTH: the consent page is never framed.
  async headers() {
    return [CONSENT_PAGE_HEADERS];
  },
  experimental: {
    // The rewrite proxy defaults to a 30 s timeout. AI work is asynchronous (202 + polling), but exports and
    // uploads can still take a while. v34 INT-A: 240 s, Claude's own limit for a tool call, so an /mcp call that
    // reaches the API through this rewrite (next dev, a test tunnel) gets the tool's own answer at
    // MCP_TOOL_TIME_LIMIT_MS (200 s by default, at most 230 s) instead of the proxy cutting it at 120 s.
    proxyTimeout: 240_000,
    // A persistent Turbopack build cache once served a stale globals.css in free_tailor; a cold compile is cheaper.
    turbopackFileSystemCacheForBuild: false,
    // v34 ORIGIN (review, security 2): Next 16's dev client waits for React's debug channel, which runs over the hot
    // reload socket, before it hydrates a page. next dev answers that socket only for allowedDevOrigins (no tunnel
    // pattern any more), so a page opened through a test tunnel would never become interactive (no sign-in form, no
    // Allow). Without the channel it hydrates; hot reload over a tunnel stays off (the dev guard refuses a tunnel's
    // socket: v34 INT-2) and next dev's client reloads such a page after about 40 s of refused reconnects. Development
    // only: production has no debug channel; the browser loses React's server-side debug details in development.
    reactDebugChannel: false,
  },
  allowedDevOrigins: allowedDevOrigins(process.env),
  turbopack: {
    // Monorepo root, so packages/shared resolves.
    root: path.join(__dirname, '..', '..'),
  },
};

export default nextConfig;
