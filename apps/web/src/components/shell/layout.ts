/** Horizontal page gutter shared by the top bar and page bodies: 16 px on a phone, 24 px from 640 px, 28 px from 1024 px. */
export const PAGE_GUTTER = 'px-4 sm:px-6 lg:px-7';

/** The cookie that remembers the person's sidebar choice (read by app/(app)/layout.tsx, so the first paint is right). */
export const SIDEBAR_COOKIE = 'tailorit_sidebar';

/**
 * The sidebar from 1024 px: `auto` until the person chooses (the icon rail below 1280 px, the full sidebar from
 * 1280 px), then their choice at every width.
 */
export type SidebarMode = 'auto' | 'collapsed' | 'expanded';

/** The mode a cookie value says; anything else is `auto`. */
export function sidebarModeOf(value: string | undefined): SidebarMode {
  return value === 'collapsed' || value === 'expanded' ? value : 'auto';
}

export interface NavItem {
  href: string;
  label: string;
  /** Other paths that belong to this item (a company page belongs to Jobs). */
  also?: readonly string[];
  /** Shown to administrators only. */
  adminOnly?: boolean;
}

/** The sidebar's main destinations, in the order of the work: find, track, apply, write. */
export const APP_NAV = [
  { href: '/jobs', label: 'Jobs', also: ['/companies'] },
  { href: '/tracker', label: 'Job Tracker' },
  { href: '/auto-apply', label: 'Auto-apply' },
  { href: '/documents', label: 'Documents' },
] as const satisfies readonly NavItem[];

/** The sidebar's bottom group: setting things up. Admin is for administrators only. */
export const APP_NAV_SECONDARY = [
  { href: '/settings/integrations', label: 'Integrations' },
  { href: '/settings', label: 'Settings' },
  { href: '/settings/admin', label: 'Admin', adminOnly: true },
] as const satisfies readonly NavItem[];

/** Whether `pathname` is inside the section that starts at `href`. */
export function isSectionActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The nav item `pathname` belongs to: the one whose href (or `also` path) is the longest prefix of it, so
 * /settings/integrations is Integrations, not Settings; null when no item holds it.
 */
export function activeNavHref(pathname: string | null, items: readonly NavItem[] = [...APP_NAV, ...APP_NAV_SECONDARY]): string | null {
  let best: { href: string; length: number } | null = null;
  for (const item of items) {
    for (const prefix of [item.href, ...(item.also ?? [])]) {
      if (isSectionActive(pathname, prefix) && (!best || prefix.length > best.length)) best = { href: item.href, length: prefix.length };
    }
  }
  return best?.href ?? null;
}

/** The top bar's words for each part of the app; the longest matching path wins. */
const SECTION_TITLES: readonly (readonly [string, string])[] = [
  ['/jobs', 'Jobs'],
  ['/companies', 'Companies'],
  ['/tracker', 'Job Tracker'],
  ['/auto-apply', 'Auto-apply'],
  ['/documents', 'Documents'],
  ['/notifications', 'Notifications'],
  ['/settings', 'Settings'],
  ['/settings/autofill', 'Autofill'],
  ['/settings/integrations', 'Integrations'],
  ['/settings/admin', 'Admin'],
  // v31 FIX-WEB (REV-UX UX-16): /oauth/consent has no top bar (app/(focus)), so no name here.
];

/** The section name the top bar shows for `pathname` ("Autofill" for /settings/autofill), else "TailorIT". */
export function sectionTitle(pathname: string | null): string {
  let best: readonly [string, string] | null = null;
  for (const entry of SECTION_TITLES) {
    if (isSectionActive(pathname, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1] ?? 'TailorIT';
}
