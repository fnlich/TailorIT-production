import Link from 'next/link'; // v34 PUBLIC
import type { ReactNode } from 'react';
import { Logo } from '@/components/shell/Logo';
import { PUBLIC_PAGE_PATHS } from '@tailorit/shared/public-pages'; // v34 PUBLIC
import { PUBLIC_PAGES } from '@/features/public/paths'; // v34 PUBLIC

/**
 * v34 PUBLIC (PLAN G8): the public pages (Guide, Privacy, Terms, Support), small, under the card: anyone may read them
 * before signing in.
 */
function PublicPageLinks() {
  return (
    <nav aria-label="About TailorIT" className="mt-6" data-sign-in-public-links="">
      <ul className="flex flex-wrap items-center justify-center gap-x-1 text-[13px] leading-5">
        {PUBLIC_PAGES.map((page) => (
          <li key={page.href}>
            <Link
              href={page.href}
              className="inline-flex min-h-11 items-center rounded-control px-2 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:min-h-8"
            >
              {page.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * v34 PUBLIC (the owner's decision after the review's finding 7): signing in accepts the Terms of use and the Privacy
 * policy, said under the card (the Terms page's lead says the same).
 */
function AcceptTerms() {
  const link = 'font-medium text-foreground underline underline-offset-2 hover:text-primary';
  return (
    <p className="mt-4 w-full max-w-md text-center text-[13px] leading-5 text-muted-foreground" data-sign-in-accept="">
      By continuing, you accept the{' '}
      <Link href={PUBLIC_PAGE_PATHS.terms} className={link}>
        Terms of use
      </Link>{' '}
      and the{' '}
      <Link href={PUBLIC_PAGE_PATHS.privacy} className={link}>
        Privacy policy
      </Link>
      .
    </p>
  );
}

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
        <AcceptTerms />
        {footer}
        <PublicPageLinks />
      </div>
    </main>
  );
}

/** The sign-in card: white, card radius, the card shadow. */
export const SIGN_IN_CARD = 'w-full max-w-md rounded-card border border-border bg-surface p-6 shadow-card sm:p-8';

/** The card's h1 ("Sign in", "This account is disabled"): Bricolage, the page-title size. */
export const SIGN_IN_TITLE = 'page-title';
