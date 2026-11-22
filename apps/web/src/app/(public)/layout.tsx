import { HydrationBoundary } from '@tanstack/react-query';
import { PublicFrame } from '@/features/public/PublicFrame';
import { publicConstantsState, readPublicConstantsOnServer } from '@/features/public/server-constants';
import { AuthProvider } from '@/lib/auth';

/**
 * v34 PUBLIC (PLAN G8): the pages anyone may read without signing in: /guide (HELP's User Guide), /privacy, /terms and
 * /support. proxy.ts lets exactly these through without a session. The frame is a light bar (the logo, the pages' links,
 * Sign in or Open TailorIT) over the page and a footer; each page sets its own width and h1. AuthProvider only asks
 * whether someone is signed in (GET /api/auth/me answers either way).
 *
 * The public constants (the operator's name, website and contact address, the retention days, the plans' limits) are
 * read here on the server and handed to the browser's query cache, so the HTML already carries them (the review's
 * finding 3); rendered for each request, with the server's own answer kept a few minutes (server-constants.ts).
 */
export const dynamic = 'force-dynamic';

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const constants = await readPublicConstantsOnServer();
  return (
    <AuthProvider>
      <HydrationBoundary state={publicConstantsState(constants)}>
        <PublicFrame>{children}</PublicFrame>
      </HydrationBoundary>
    </AuthProvider>
  );
}
