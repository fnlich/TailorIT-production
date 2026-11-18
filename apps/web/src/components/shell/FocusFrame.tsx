'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { Logo } from './Logo';

/**
 * v31 FIX-WEB (REV-UX UX-16): the frame of a signed-in step that stands on its own, such as the consent page where an
 * AI app asks for the person's account: no sidebar, no top bar, nothing to wander off to. The canvas with a tape seam
 * along its top edge (as the sign-in page on a phone and the editors' bar), the logo, the page's card under it, and
 * which account is signed in (the app's account menu is not there to say so). The page owns its h1.
 */
export function FocusFrame({ children }: { children: ReactNode }) {
  const { account } = useAuth();
  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas" data-focus-frame="">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-tape" />
      <div className="flex justify-center px-4 pt-10 sm:pt-14">
        <Logo markSize={36} wordSize={25} gap={10} />
      </div>
      {/* tabIndex -1: focus can be put here (as the app's main), never tabbed to. */}
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {children}
      </main>
      {account && (
        <p className="px-4 pb-8 text-center text-[13px] leading-5 text-muted-foreground" data-focus-account="">
          Signed in as <span className="font-medium text-foreground">{account.email}</span>
        </p>
      )}
    </div>
  );
}
