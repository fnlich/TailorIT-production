import { AppHeader } from '@/components/shell/AppHeader';
import { AuthGate } from '@/components/shell/AuthGate';
import { AnnouncementBanner } from '@/features/announcements/AnnouncementBanner';
import { AuthProvider } from '@/lib/auth';

/**
 * The signed-in app: Simplify's header over the #fcfcfc canvas. v2.0: the banner slot between the header and the page
 * holds the admin's announcements (docs/design/v2.0/08-ui.md, "The announcement banner").
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <div className="flex min-h-dvh flex-col bg-canvas">
        <AppHeader />
        <AnnouncementBanner />
        {/* tabIndex -1: focus can be put here (a dismissed announcement's ×, v2.0 fix UX-9), never tabbed to. */}
        <main tabIndex={-1} className="flex flex-1 flex-col outline-none">
          <AuthGate>{children}</AuthGate>
        </main>
      </div>
    </AuthProvider>
  );
}
