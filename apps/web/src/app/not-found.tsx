import { clsx } from 'clsx';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Logo, LogoMark } from '@/components/shell/Logo';
import { HelpTip } from '@/components/ui/HelpTip';

export const metadata: Metadata = { title: 'Page not found' };

/*
 * Any address TailorIT has no page for (the sign-in gate has already let the person through): a top bar with the
 * logo, and an empty state on pattern paper that says so, with the way back to Jobs. A Server Component, so it stays
 * plain markup (the kit's Button module is a client one; the link carries the primary button's look).
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="h-topbar shrink-0 border-b border-border bg-surface">
        <div className={clsx('flex h-full items-center', PAGE_GUTTER)}>
          <Link href="/jobs" aria-label="TailorIT, go to Jobs" className="flex items-center rounded-control outline-offset-4">
            <Logo className="max-sm:hidden" />
            <LogoMark className="sm:hidden" />
          </Link>
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-16 sm:py-24">
        <div className="paper-grid flex w-full max-w-lg flex-col items-center gap-1.5 stitch rounded-card bg-surface px-6 py-14 text-center">
          <span aria-hidden="true" className="num mb-2 flex h-9 items-center rounded-tag bg-tape px-3 text-sm text-foreground">
            404
          </span>
          <div className="flex items-center gap-1.5">
            <h1 className="font-display text-xl leading-7 font-semibold text-foreground">Page not found</h1>
            <HelpTip label="Page not found">The address may be mistyped or moved; your work is all still here.</HelpTip>
          </div>
          <Link
            href="/jobs"
            className="mt-4 inline-flex h-9 items-center justify-center rounded-control bg-primary px-3.5 text-sm font-medium whitespace-nowrap text-on-primary shadow-control transition-colors duration-150 hover:bg-primary-hover"
          >
            Go to Jobs
          </Link>
        </div>
      </main>
    </div>
  );
}
