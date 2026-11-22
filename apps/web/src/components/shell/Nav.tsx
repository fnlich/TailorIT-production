'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import type { Account } from '@tailorit/shared/auth';
import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BACKDROP } from '@/components/ui/Dialog';
import {
  BriefcaseIcon,
  FileTextIcon,
  GearSixIcon,
  KanbanIcon,
  MagicWandIcon,
  PlugsConnectedIcon,
  QuestionIcon,
  RobotIcon,
  ShieldCheckIcon,
  XIcon,
  type Icon,
} from '@/components/ui/icons';
import { isOwnOnlyPath } from '@/lib/profile';
import { APP_NAV, accountNavFor, activeNavHref, type NavItem } from './layout';
import { LogoMark, Wordmark } from './Logo';
import { SheetProfiles } from './profile/ProfilesMenu';
import { useProfile } from './profile/useProfile';

/*
 * v3.2 SHELL (E2; docs/design/v3.1/20-visual-identity.md §5 "The shell"): the app's navigation lives in the header bar,
 * with no sidebar. The bar is the dark denim the sidebar was ("Denim & Tape" kept, E1).
 * - HeaderNav, from 1024 px: one `<nav aria-label="Main">` in the bar with the work (Jobs, Job Tracker, Auto-apply,
 *   Documents). Links 36 px tall, radius 6, an 18 px icon (filled when active) and the name; the active one has
 *   aria-current="page", the lighter band and a 3 px tape bar on the bar's bottom edge under it.
 * - MenuSheet, below 1024 px: the top bar's "Open menu" button opens the same links (then setting up: Integrations,
 *   Settings, Autofill, Admin for administrators) in a sheet from the left edge: a modal dialog named "Menu", focus kept
 *   inside, Escape or the × closes it and focus goes back to the button, a link closes it.
 * Setting up (and Log out) is in the account menu at every width.
 * v33 SHARE-4: the sheet's third group is Profiles (You, each shared profile, All profiles, invites) once the person
 * has one; while the tab works on a shared profile, setting up leaves out the pages only done on one's own.
 */

/** Each destination's icon (the header's links, the sheet's rows, the account menu's rows). */
export const NAV_ICONS: Readonly<Record<string, Icon>> = {
  '/jobs': BriefcaseIcon,
  '/tracker': KanbanIcon,
  '/auto-apply': RobotIcon,
  '/documents': FileTextIcon,
  '/settings/integrations': PlugsConnectedIcon,
  '/settings': GearSixIcon,
  '/settings/autofill': MagicWandIcon,
  '/settings/admin': ShieldCheckIcon,
  '/help': QuestionIcon, // v34 HELP
};

/** Keyboard focus on the dark denim: the tape colour, drawn inside the control so nothing clips it. */
export const FOCUS_ON_DARK = 'outline-offset-[-2px] focus-visible:outline-tape';

/** The header's links, from 1024 px. */
export function HeaderNav({ path, className }: { path: string | null; className?: string }) {
  const active = activeNavHref(path, APP_NAV);
  return (
    <nav aria-label="Main" data-header-nav="" className={clsx('hidden h-full min-w-0 items-center lg:flex', className)}>
      <ul className="flex items-center gap-0.5 xl:gap-1">
        {APP_NAV.map((item) => (
          <li key={item.href}>
            <HeaderLink item={item} active={active === item.href} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function HeaderLink({ item, active }: { item: NavItem; active: boolean }) {
  const ItemIcon = NAV_ICONS[item.href] ?? BriefcaseIcon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      data-active={active ? '' : undefined}
      className={clsx(
        'relative flex h-9 items-center gap-2 rounded-control px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 xl:px-3',
        FOCUS_ON_DARK,
        active ? 'bg-sidebar-active text-sidebar-strong' : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-strong',
      )}
    >
      <ItemIcon size={18} weight={active ? 'fill' : 'regular'} />
      {item.label}
      {/* The link is 36 px in the 56 px bar: 10 px below it is the bar's bottom edge, where the tape lies. */}
      {active && <span aria-hidden="true" data-tape-bar="" className="absolute inset-x-2 -bottom-2.5 h-[3px] rounded-t-full bg-tape" />}
    </Link>
  );
}

/** A row of the sheet: 40 px, the 20 px icon, the tape bar on the sheet's edge when active. */
function SheetLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const ItemIcon = NAV_ICONS[item.href] ?? BriefcaseIcon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      data-active={active ? '' : undefined}
      onClick={onNavigate}
      className={clsx(
        'relative flex h-10 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-150',
        FOCUS_ON_DARK,
        active ? 'bg-sidebar-active text-sidebar-strong' : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-strong',
      )}
    >
      {active && <span aria-hidden="true" data-tape-bar="" className="absolute inset-y-2 -left-3 w-[3px] rounded-r-full bg-tape" />}
      <ItemIcon size={20} weight={active ? 'fill' : 'regular'} />
      <span className="min-w-0 truncate">{item.label}</span>
    </Link>
  );
}

/** The sheet's links: the work, then setting up (Admin for administrators), then (v33 SHARE-4) `profiles`. */
export function SheetNav({
  path,
  account,
  onNavigate,
  acting = false,
  profiles,
}: {
  path: string | null;
  account: Account | null;
  onNavigate: () => void;
  /** v33 SHARE-4: the tab works on a shared profile (Integrations and Admin are left out). */
  acting?: boolean;
  /** v33 SHARE-4: the Profiles group (SheetProfiles), after setting up. */
  profiles?: ReactNode;
}) {
  const setup = accountNavFor(account?.role).filter((item) => !acting || !isOwnOnlyPath(item.href));
  const active = activeNavHref(path, [...APP_NAV, ...setup]);
  return (
    <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 pt-2 pb-3">
      <ul className="flex flex-col gap-0.5">
        {APP_NAV.map((item) => (
          <li key={item.href}>
            <SheetLink item={item} active={active === item.href} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      <ul className="mt-3 flex flex-col gap-0.5 border-t border-sidebar-border pt-3" data-nav-group="setup">
        {setup.map((item) => (
          <li key={item.href}>
            <SheetLink item={item} active={active === item.href} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      {profiles}
    </nav>
  );
}

/** Below 1024 px: the links in a sheet from the left edge (a modal dialog named "Menu"). */
export function MenuSheet({
  open,
  onOpenChange,
  path,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string | null;
  account: Account | null;
}) {
  const close = () => onOpenChange(false);
  const view = useProfile();
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={clsx(BACKDROP, 'lg:hidden')} />
        <BaseDialog.Popup
          aria-label="Menu"
          data-menu-sheet=""
          className={clsx(
            'fixed inset-y-0 left-0 z-50 flex w-[17.5rem] max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-dialog outline-none lg:hidden',
            'transition-transform duration-200 ease-out-soft data-starting-style:-translate-x-full data-ending-style:-translate-x-full',
          )}
        >
          <div className="flex h-topbar shrink-0 items-center justify-between pr-2 pl-3">
            <Link
              href="/jobs"
              aria-label="TailorIT, go to Jobs"
              onClick={close}
              className={clsx('flex min-w-0 items-center gap-2.5 rounded-control p-1', FOCUS_ON_DARK)}
            >
              <LogoMark size={30} />
              <Wordmark size={20} tone="inverse" />
            </Link>
            <BaseDialog.Close
              aria-label="Close menu"
              className={clsx(
                'inline-flex size-10 items-center justify-center rounded-control text-sidebar-foreground transition-colors',
                'hover:bg-sidebar-hover hover:text-sidebar-strong',
                FOCUS_ON_DARK,
              )}
            >
              <XIcon size={20} />
            </BaseDialog.Close>
          </div>
          <SheetNav
            path={path}
            account={account}
            onNavigate={close}
            acting={view.acting}
            profiles={<SheetProfiles view={view} onNavigate={close} />}
          />
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
