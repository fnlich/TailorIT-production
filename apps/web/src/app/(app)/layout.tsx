import { cookies } from 'next/headers';
import { AppShell } from '@/components/shell/AppShell';
import { AuthGate } from '@/components/shell/AuthGate';
import { SIDEBAR_COOKIE, sidebarModeOf } from '@/components/shell/layout';
import { AnnouncementBanner } from '@/features/announcements/AnnouncementBanner';
import { AuthProvider } from '@/lib/auth';

/**
 * The signed-in app (v3.1 DS): the shell's sidebar and top bar around the content column. v2.0: the banner slot
 * between the top bar and the page holds the admin's announcements (docs/design/v2.0/08-ui.md, "The announcement
 * banner"). The sidebar's mode is a cookie, read here so the first paint already has the right width.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sidebar = sidebarModeOf((await cookies()).get(SIDEBAR_COOKIE)?.value);
  return (
    <AuthProvider>
      <AppShell initialMode={sidebar}>
        <AnnouncementBanner />
        {/* tabIndex -1: focus can be put here (a dismissed announcement's ×, v2.0 fix UX-9; the skip link), never tabbed to. */}
        <main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
          <AuthGate>{children}</AuthGate>
        </main>
      </AppShell>
    </AuthProvider>
  );
}
