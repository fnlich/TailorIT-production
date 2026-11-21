'use client';

import type { Account } from '@tailorit/shared/auth';
import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ListIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { AccountMenu } from './AccountMenu';
import { HeaderNotifications, HeaderUsage } from './header/slots';
import { HeaderToneProvider } from './header/tone';
import { PAGE_GUTTER } from './layout';
import { LogoMark, Wordmark } from './Logo';
import { FOCUS_ON_DARK, HeaderNav } from './Nav';
import { ProfileChip } from './profile/ProfileChip';

export interface TopBarProps {
  /** The section's name (layout.ts sectionTitle) below 1024 px, or any node a page puts there. Never a heading: pages own the h1. */
  title: ReactNode;
  /** The path whose link is active (the header's links, the account menu's trigger). */
  path?: string | null;
  /** Below 1024 px: opens the menu sheet. */
  onOpenMenu: () => void;
  menuOpen: boolean;
  account: Account | null;
  signingOut?: boolean;
  onSignOut: () => void;
}

/**
 * v3.2 SHELL (E2): the app's one bar, with no sidebar. 56 px, sticky, the dark denim the sidebar was. From 1024 px: the
 * logo (mark and wordmark, a link to Jobs), the links (Jobs, Job Tracker, Auto-apply, Documents; the active one on the
 * tape), then on the right HEADER's usage chip and bell and the account menu (Integrations, Settings, Autofill, Admin,
 * Log out). Below 1024 px: the menu button (the links in a sheet), the logo mark and the section's name in Bricolage
 * Grotesque (left out on a page with a PageHeader, which names it), then the same right cluster.
 * v33 SHARE-4: the profile chip (whose profile the tab works on) leads the right cluster once the person has a shared
 * profile; nothing of it otherwise.
 */
export function TopBar({ title, path = null, onOpenMenu, menuOpen, account, signingOut = false, onSignOut }: TopBarProps) {
  return (
    <header
      data-topbar=""
      className={clsx(
        'sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-2 bg-sidebar text-sidebar-foreground',
        // Keyboard focus on the dark bar is the tape colour (the page's denim ring would not show).
        '[&_:focus-visible]:outline-tape',
        PAGE_GUTTER,
      )}
    >
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        onClick={onOpenMenu}
        className={clsx(
          '-ml-2 inline-flex size-9 shrink-0 items-center justify-center rounded-control text-sidebar-foreground transition-colors duration-150',
          'hover:bg-sidebar-hover hover:text-sidebar-strong lg:hidden',
          FOCUS_ON_DARK,
        )}
      >
        <ListIcon size={20} />
      </button>
      <Link
        href="/jobs"
        aria-label="TailorIT, go to Jobs"
        data-topbar-logo=""
        className={clsx('flex shrink-0 items-center gap-2.5 rounded-control lg:-ml-1 lg:p-1', FOCUS_ON_DARK)}
      >
        <LogoMark size={28} />
        <Wordmark size={19} tone="inverse" className="max-lg:hidden" />
      </Link>
      {/* Below 1024 px the section's name, only where the page has no PageHeader of its own (v31 FIX-WEB, REV-UX UX-7);
          from 1024 px the active link says where you are. */}
      <p
        data-topbar-title=""
        className="ml-1 min-w-0 truncate font-display text-[17px] leading-6 font-semibold text-sidebar-strong lg:hidden [[data-app-content]:has([data-page-header])_&]:hidden"
      >
        {title}
      </p>
      <HeaderNav path={path} className="ml-4 xl:ml-8" />
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
        <HeaderToneProvider value="dark">
          <ProfileChip />
          <HeaderUsage />
          <HeaderNotifications />
          {account ? (
            <AccountMenu account={account} signingOut={signingOut} onSignOut={onSignOut} path={path} />
          ) : (
            <span className="flex h-9 items-center gap-2 pl-1" aria-hidden="true">
              <Skeleton className="size-7" rounded="control" />
            </span>
          )}
        </HeaderToneProvider>
      </div>
    </header>
  );
}
