import { BRAND_ICONS, PUBLIC_PAGE_PATHS } from '@tailorit/shared/public-pages';

// v34 PUBLIC (PLAN G8): the pages anyone may read without signing in, and where they link. The Guide is HELP's
// (app/(public)/guide/page.tsx, the User Guide's public frame); Privacy, Terms and Support are this feature's. The paths
// and the brand icons are the shared contract (@tailorit/shared/public-pages), which the API's discovery documents and
// MCP server info link too.

/** The public pages, in the order the header and the footer list them. */
export const PUBLIC_PAGES = [
  { href: PUBLIC_PAGE_PATHS.guide, label: 'Guide' },
  { href: PUBLIC_PAGE_PATHS.privacy, label: 'Privacy' },
  { href: PUBLIC_PAGE_PATHS.terms, label: 'Terms' },
  { href: PUBLIC_PAGE_PATHS.support, label: 'Support' },
] as const;

/** The brand icons' paths on this site (apps/web/public/brand: the mark as SVG and PNGs at 64, 256 and 512 px). */
export const BRAND_ICON_PATHS = {
  svg: BRAND_ICONS.svg.path,
  png64: BRAND_ICONS.png64.path,
  png256: BRAND_ICONS.png256.path,
  png512: BRAND_ICONS.png512.path,
} as const;

/**
 * The User Guide's sections and topics the public pages link to (/guide#<id>; the in-app /help has the same ids): the
 * ids HELP gave them (features/help/content). INT checks they still exist.
 */
export const GUIDE_ANCHORS = {
  start: 'getting-started',
  mcp: 'mcp',
  mcpConnect: 'mcp-connect-claude',
  mcpPrompts: 'mcp-prompts',
  mcpTroubleshooting: 'mcp-troubleshooting',
  extension: 'extension',
  plans: 'plans',
  contact: 'contact',
} as const;

/** /guide#<id>. */
export const guideLink = (anchor: (typeof GUIDE_ANCHORS)[keyof typeof GUIDE_ANCHORS]): string =>
  `${PUBLIC_PAGE_PATHS.guide}#${anchor}`;

const PAGE_PATHS: ReadonlySet<string> = new Set(PUBLIC_PAGES.map((page) => page.href));
const ICON_PATHS: ReadonlySet<string> = new Set(Object.values(BRAND_ICON_PATHS));

/**
 * Whether the sign-in gate (proxy.ts) lets `pathname` through without a session: a public page (with or without one
 * trailing slash) or one of the four brand icons, exactly. Nothing else: /privacy/x, /guidebook, /brand and any other
 * /brand/<name> stay gated (the review's finding 9). The icons are files, which the matcher already leaves to Next's
 * static files; the exact list keeps a future route under /brand behind the gate.
 */
export function isPublicPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return PAGE_PATHS.has(path) || ICON_PATHS.has(pathname);
}
