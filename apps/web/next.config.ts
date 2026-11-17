import path from 'node:path';
import type { NextConfig } from 'next';
import { allowedDevOrigins, apiOrigin as apiOriginFrom } from './src/lib/addresses';

// Addresses come from the root .env (scripts/next-launch.mjs loads it): API_INTERNAL_URL, else API_HOST and API_PORT,
// for the /api rewrite; WEB_HOST and APP_ORIGIN for the dev server's allowed origins. `next build` writes the rewrite
// into the build, so a production server needs `npm run build` again after an address changes.
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
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
  experimental: {
    // The rewrite proxy defaults to a 30 s timeout. AI work is asynchronous (202 + polling), but exports and
    // uploads can still take a while.
    proxyTimeout: 120_000,
    // A persistent Turbopack build cache once served a stale globals.css in free_tailor; a cold compile is cheaper.
    turbopackFileSystemCacheForBuild: false,
  },
  allowedDevOrigins: allowedDevOrigins(process.env),
  turbopack: {
    // Monorepo root, so packages/shared resolves.
    root: path.join(__dirname, '..', '..'),
  },
};

export default nextConfig;
