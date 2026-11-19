import { AppShell } from '@/components/shell/AppShell';
import { AuthGate } from '@/components/shell/AuthGate';
import { AnnouncementBanner } from '@/features/announcements/AnnouncementBanner';
import { AuthProvider } from '@/lib/auth';

/**
 * The signed-in app: the shell's header bar (v3.2 SHELL, E2: the links are in it; no sidebar) over the page. v2.0: the
 * banner slot between the header bar and the page holds the admin's announcements (docs/design/v2.0/08-ui.md, "The
 * announcement banner").
 */

// v32 SHELL: rendered for each request, as in v3.1 (whose layout read the sidebar's cookie, now gone): every page here is
// the signed-in person's, and some read the address's query without a Suspense boundary (Jobs, the Job Tracker), which a
// prerendered page could not.
export const dynamic = 'force-dynamic';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>
        <AnnouncementBanner />
        {/* tabIndex -1: focus can be put here (a dismissed announcement's ×, v2.0 fix UX-9; the skip link), never tabbed to. */}
        <main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
          <AuthGate>{children}</AuthGate>
        </main>
      </AppShell>
    </AuthProvider>
  );
}
