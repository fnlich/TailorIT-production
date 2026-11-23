'use client';

import { usePublicConstants } from '@/lib/constants';
import { Guide } from './Guide';

/**
 * v34 HELP (PLAN G6, G8): the User Guide without sign-in (/guide): the documentation address Claude's directory asks
 * for. No user data and no Admin. v34 INT-A (PUBLIC's exact edit 1): the numbers are the server's public constants,
 * which app/(public)/layout.tsx reads on the server (signed out) and hands to the query cache, so the first paint has
 * them; when that read failed, the browser reads them itself (GET /api/constants/public answers signed out) and the
 * defaults show until it has. It draws inside the layout app/(public) gives it.
 */
export function PublicGuide() {
  const { values } = usePublicConstants();
  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-20 sm:px-6 lg:px-7" data-public-guide="">
      <header className="mb-6 max-w-[48rem]">
        <p className="mb-1 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">TailorIT</p>
        <h1 className="page-title">User guide</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          What TailorIT does, page by page, and how to use it from Claude, ChatGPT or another AI app: connecting, what to ask,
          and every tool your AI can use.
        </p>
      </header>
      <Guide frame="public" values={values} />
    </div>
  );
}
