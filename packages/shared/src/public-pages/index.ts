// v34 PUBLIC (PLAN G8): the pages anyone may read without signing in, and the brand icons, as one contract for the web
// (the pages, the sign-in gate, the sign-in page's links) and the API (the OAuth discovery documents' documentation,
// policy and terms links; the MCP server's websiteUrl and icons). The web draws the pages under app/(public); the icons
// are files under apps/web/public/brand, drawn from the app's mark by scripts/brand-icons.mjs.

/** The public pages' paths. The Guide is the User Guide's public frame (the in-app /help has the same content). */
export const PUBLIC_PAGE_PATHS = {
  guide: '/guide',
  privacy: '/privacy',
  terms: '/terms',
  support: '/support',
} as const;

export type PublicPageKey = keyof typeof PUBLIC_PAGE_PATHS;
export type PublicPagePath = (typeof PUBLIC_PAGE_PATHS)[PublicPageKey];

/** The brand icons' folder on the web origin. */
export const BRAND_PATH = '/brand';

export interface BrandIcon {
  /** The icon's path on the web origin. */
  path: string;
  mimeType: 'image/png' | 'image/svg+xml';
  /** "64x64", or "any" for the SVG (MCP's Icon `sizes`). */
  size: string;
}

/** The brand icons: the mark as SVG (scales to any size) and as square PNGs on a transparent background. */
export const BRAND_ICONS = {
  svg: { path: `${BRAND_PATH}/tailorit-mark.svg`, mimeType: 'image/svg+xml', size: 'any' },
  png64: { path: `${BRAND_PATH}/tailorit-64.png`, mimeType: 'image/png', size: '64x64' },
  png256: { path: `${BRAND_PATH}/tailorit-256.png`, mimeType: 'image/png', size: '256x256' },
  png512: { path: `${BRAND_PATH}/tailorit-512.png`, mimeType: 'image/png', size: '512x512' },
} as const satisfies Record<string, BrandIcon>;

/** The square sizes of the PNG icons, in pixels. */
export const BRAND_PNG_SIZES = [64, 256, 512] as const;

/** `path` on `origin` (an origin with or without a trailing slash: "https://tailorit.example.com"). */
function on(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}

/** The public pages' absolute addresses on `origin`: what the discovery documents and a directory listing link. */
export function publicPageUrls(origin: string): Record<PublicPageKey, string> {
  return {
    guide: on(origin, PUBLIC_PAGE_PATHS.guide),
    privacy: on(origin, PUBLIC_PAGE_PATHS.privacy),
    terms: on(origin, PUBLIC_PAGE_PATHS.terms),
    support: on(origin, PUBLIC_PAGE_PATHS.support),
  };
}

/** The brand icons on `origin` in MCP's Icon shape ({ src, mimeType, sizes }), the PNGs from large to small, then the SVG. */
export function brandIconsOn(origin: string): Array<{ src: string; mimeType: string; sizes: string[] }> {
  return [BRAND_ICONS.png512, BRAND_ICONS.png256, BRAND_ICONS.png64, BRAND_ICONS.svg].map((icon) => ({
    src: on(origin, icon.path),
    mimeType: icon.mimeType,
    sizes: [icon.size],
  }));
}
