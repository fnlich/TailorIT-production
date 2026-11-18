'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { SIDEBAR_COOKIE, sectionTitle, type SidebarMode } from './layout';
import { Sidebar, SidebarDrawer } from './Sidebar';
import { TopBar } from './TopBar';

/** Remembers the person's choice for a year, in this browser (the layout reads it on the next page load). */
function rememberMode(mode: 'collapsed' | 'expanded') {
  document.cookie = `${SIDEBAR_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
}

export interface AppShellProps {
  /** The banner and the page's <main> (app/(app)/layout.tsx). */
  children?: ReactNode;
  /** The sidebar's mode on the first paint (the layout reads the cookie); `auto` by default. */
  initialMode?: SidebarMode;
  /** Overrides the current path for the active item and the title (dev kit, tests). */
  activePath?: string;
}

/**
 * v3.1 DS: the signed-in app's frame. A skip link, the dark sidebar (a column from 1024 px, a drawer below), and the
 * content column: the top bar, then `children` (the announcement banner and <main id="main">). The page scrolls as a
 * whole, so sticky parts of a page sit under the top bar (`top-topbar`).
 */
export function AppShell({ children, initialMode = 'auto', activePath }: AppShellProps) {
  const currentPath = usePathname();
  const path = activePath ?? currentPath;
  const { account, signingOut, signOut } = useAuth();
  const [mode, setMode] = useState<SidebarMode>(initialMode);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The drawer is for narrow windows: widening past 1024 px while it is open closes it (it would trap focus unseen).
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const wide = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (wide.matches) setDrawerOpen(false);
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, [drawerOpen]);

  const chooseMode = (next: 'collapsed' | 'expanded') => {
    setMode(next);
    rememberMode(next);
  };

  return (
    <div className="flex min-h-dvh bg-canvas">
      <a
        href="#main"
        className="sr-only z-[90] rounded-control bg-surface px-3 py-2 text-sm font-medium text-primary shadow-popover focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Sidebar path={path} account={account} mode={mode} onModeChange={chooseMode} />
      <SidebarDrawer open={drawerOpen} onOpenChange={setDrawerOpen} path={path} account={account} />
      <div data-app-content="" className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={sectionTitle(path)}
          onOpenMenu={() => setDrawerOpen(true)}
          menuOpen={drawerOpen}
          account={account}
          signingOut={signingOut}
          onSignOut={() => void signOut()}
        />
        {children}
      </div>
    </div>
  );
}
