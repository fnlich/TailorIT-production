'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { sectionTitle } from './layout';
import { MenuSheet } from './Nav';
import { TopBar } from './TopBar';

export interface AppShellProps {
  /** The banner and the page's <main> (app/(app)/layout.tsx). */
  children?: ReactNode;
  /** Overrides the current path for the active link and the title (dev kit, tests). */
  activePath?: string;
}

/**
 * v3.2 SHELL (E2): the signed-in app's frame, with no sidebar. A skip link, the header bar (the logo, the links, the
 * usage chip, the bell, the account menu; below 1024 px the menu button that opens the links in a sheet), then
 * `children` (the announcement banner and <main id="main">) across the window's width. The page scrolls as a whole, so
 * sticky parts of a page sit under the header bar (`top-topbar`).
 */
export function AppShell({ children, activePath }: AppShellProps) {
  const currentPath = usePathname();
  const path = activePath ?? currentPath;
  const { account, signingOut, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  // The sheet is for narrow windows: widening past 1024 px while it is open closes it (it would trap focus unseen).
  useEffect(() => {
    if (!menuOpen) return undefined;
    const wide = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (wide.matches) setMenuOpen(false);
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, [menuOpen]);

  return (
    <div data-app-content="" className="flex min-h-dvh min-w-0 flex-col bg-canvas">
      <a
        href="#main"
        className="sr-only z-[90] rounded-control bg-surface px-3 py-2 text-sm font-medium text-primary shadow-popover focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <TopBar
        title={sectionTitle(path)}
        path={path}
        onOpenMenu={() => setMenuOpen(true)}
        menuOpen={menuOpen}
        account={account}
        signingOut={signingOut}
        onSignOut={() => void signOut()}
      />
      <MenuSheet open={menuOpen} onOpenChange={setMenuOpen} path={path} account={account} />
      {children}
    </div>
  );
}
