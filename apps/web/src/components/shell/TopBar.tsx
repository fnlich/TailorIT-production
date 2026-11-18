'use client';

import type { Account } from '@tailorit/shared/auth';
import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { ListIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { AccountMenu } from './AccountMenu';
import { HeaderNotifications, HeaderUsage } from './header/slots';
import { PAGE_GUTTER } from './layout';
import { LogoMark } from './Logo';

export interface TopBarProps {
  /** The section's name (layout.ts sectionTitle), or any node a page puts there. Never a heading: pages own the h1. */
  title: ReactNode;
  /** Below 1024 px: opens the sidebar drawer. */
  onOpenMenu: () => void;
  menuOpen: boolean;
  account: Account | null;
  signingOut?: boolean;
  onSignOut: () => void;
}

/**
 * v3.1 DS: the top bar over the content column. 56 px, white (95 %, blurred under), a 1 px border below, sticky.
 * Below 1024 px it starts with the menu button and the logo mark (the sidebar is a drawer there). The section's name in
 * Bricolage Grotesque (left out on a page with a PageHeader, which names it), then the right cluster: HEADER's usage and notifications slots and the account menu.
 */
export function TopBar({ title, onOpenMenu, menuOpen, account, signingOut = false, onSignOut }: TopBarProps) {
  return (
    <header
      data-topbar=""
      className={clsx(
        'sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-2 border-b border-border bg-surface/95 backdrop-blur-md',
        PAGE_GUTTER,
      )}
    >
      <IconButton
        label="Open menu"
        icon={<ListIcon size={20} />}
        tooltip={false}
        onClick={onOpenMenu}
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        className="-ml-2 lg:hidden"
      />
      <Link href="/jobs" aria-label="TailorIT, go to Jobs" className="flex shrink-0 rounded-control lg:hidden">
        <LogoMark size={26} />
      </Link>
      {/* v31 FIX-WEB (REV-UX UX-7): the section's name only where the page has no PageHeader of its own (Jobs, Settings,
          Admin... draw their title one line below; a company page, a page still loading, a missing page do not). */}
      <p
        data-topbar-title=""
        className="ml-1 min-w-0 truncate font-display text-[17px] leading-6 font-semibold text-foreground lg:ml-0 [[data-app-content]:has([data-page-header])_&]:hidden"
      >
        {title}
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
        <HeaderUsage />
        <HeaderNotifications />
        {account ? (
          <AccountMenu account={account} signingOut={signingOut} onSignOut={onSignOut} />
        ) : (
          <span className="flex h-9 items-center gap-2 pl-1" aria-hidden="true">
            <Skeleton className="size-7" rounded="control" />
            <Skeleton className="h-3.5 w-16 max-md:hidden" />
          </span>
        )}
      </div>
    </header>
  );
}
