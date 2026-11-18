import type { ReactNode } from 'react';
import { Logo } from '@/components/shell/Logo';

/** What TailorIT does, in the person's words: the denim side of the sign-in page. */
const STORY_LINES = [
  'Search jobs and save the ones that fit you.',
  'Track every application from saved to offer.',
  'Keep your resumes and cover letters in one place.',
] as const;

/**
 * The sign-in page's frame (v3.1 "Denim & Tape"): from 1024 px a dark denim side with the brand, what TailorIT does
 * and a strip of measuring tape, beside the canvas that holds the sign-in card; below 1024 px the canvas alone with
 * a tape seam along the top and the logo above the card. The card (and the page's h1) is the child.
 */
export function SignInFrame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="relative grid min-h-dvh bg-canvas lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {/* Below 1024 px the tape runs along the top edge, as on the editors' bar. */}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-tape lg:hidden" />
      <div className="relative hidden flex-col justify-between gap-12 overflow-hidden bg-sidebar px-12 py-10 text-sidebar-foreground lg:flex">
        <Logo markSize={36} wordSize={26} gap={10} tone="inverse" />
        <div className="max-w-md">
          <p className="font-display text-[34px] leading-10 font-semibold tracking-[-0.01em] text-sidebar-strong">
            Every application, cut to fit the job.
          </p>
          <ul className="mt-6 flex flex-col gap-3 text-[15px] leading-6">
            {STORY_LINES.map((line) => (
              <li key={line} className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-2.5 h-0.5 w-4 shrink-0 rounded-full bg-tape" />
                {line}
              </li>
            ))}
          </ul>
        </div>
        {/* A strip of the tailor's tape: decoration only. */}
        <div aria-hidden="true" className="-mx-12 flex h-10 items-end bg-tape tape-ticks px-12" />
      </div>
      <div className="flex min-w-0 flex-col items-center justify-center px-4 py-12 sm:px-6">
        <div className="mb-8 flex items-center lg:hidden">
          <Logo markSize={40} wordSize={28} gap={10} />
        </div>
        {children}
        {footer}
      </div>
    </main>
  );
}

/** The sign-in card: white, card radius, the card shadow. */
export const SIGN_IN_CARD = 'w-full max-w-md rounded-card border border-border bg-surface p-6 shadow-card sm:p-8';

/** The card's h1 ("Sign in", "This account is disabled"): Bricolage, the page-title size. */
export const SIGN_IN_TITLE = 'page-title';
