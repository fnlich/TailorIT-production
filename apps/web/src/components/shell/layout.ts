import type { Role } from '@tailorit/shared/auth';

/** Horizontal page gutter shared by the top bar and page bodies: 16 px on a phone, 24 px from 640 px, 28 px from 1024 px. */
export const PAGE_GUTTER = 'px-4 sm:px-6 lg:px-7';

export interface NavItem {
  href: string;
  label: string;
  /** Other paths that belong to this item (a company page belongs to Jobs). */
  also?: readonly string[];
  /** Shown to administrators only. */
  adminOnly?: boolean;
}

/**
 * v3.2 SHELL (E2): the header bar's links, in the order of the work: find, track, apply, write. From 1024 px they sit in
 * the bar; below it the menu button opens them in a sheet.
 */
export const APP_NAV = [
  { href: '/jobs', label: 'Jobs', also: ['/companies'] },
  { href: '/tracker', label: 'Job Tracker' },
  { href: '/auto-apply', label: 'Auto-apply' },
  { href: '/documents', label: 'Documents' },
] as const satisfies readonly NavItem[];

/**
 * v3.2 SHELL (E2): setting things up, in the account menu (and the phone's sheet, after the work). Admin is for
 * administrators only.
 */
export const ACCOUNT_NAV = [
  { href: '/settings/integrations', label: 'Integrations' },
  { href: '/settings', label: 'Settings' },
  { href: '/settings/autofill', label: 'Autofill' },
  { href: '/settings/admin', label: 'Admin', adminOnly: true },
] as const satisfies readonly NavItem[];

/** The account links `role` may follow: Admin for administrators only. */
export function accountNavFor(role: Role | null | undefined): NavItem[] {
  return ACCOUNT_NAV.filter((item: NavItem) => !item.adminOnly || role === 'admin');
}

/** Whether `pathname` is inside the section that starts at `href`. */
export function isSectionActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The nav item `pathname` belongs to: the one whose href (or `also` path) is the longest prefix of it, so
 * /settings/integrations is Integrations, not Settings; null when no item holds it.
 */
export function activeNavHref(pathname: string | null, items: readonly NavItem[] = [...APP_NAV, ...ACCOUNT_NAV]): string | null {
  let best: { href: string; length: number } | null = null;
  for (const item of items) {
    for (const prefix of [item.href, ...(item.also ?? [])]) {
      if (isSectionActive(pathname, prefix) && (!best || prefix.length > best.length)) best = { href: item.href, length: prefix.length };
    }
  }
  return best?.href ?? null;
}

/** Whether `pathname` is one of the account menu's pages (its trigger then carries the tape bar). */
export function isAccountPath(pathname: string | null): boolean {
  const active = activeNavHref(pathname);
  return active !== null && ACCOUNT_NAV.some((item) => item.href === active);
}

/** The top bar's words for each part of the app below 1024 px (where the links wait in the sheet); the longest matching path wins. */
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

/** The section name the narrow top bar shows for `pathname` ("Autofill" for /settings/autofill), else "TailorIT". */
export function sectionTitle(pathname: string | null): string {
  let best: readonly [string, string] | null = null;
  for (const entry of SECTION_TITLES) {
    if (isSectionActive(pathname, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1] ?? 'TailorIT';
}
