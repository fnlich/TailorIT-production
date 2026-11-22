'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { LogoMark, Wordmark } from '@/components/shell/Logo';
import { buttonClasses } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/lib/auth';
import { usePublicConstants } from '@/lib/constants';
import { DEFAULT_AFTER_SIGN_IN } from '@/lib/navigation';
import { operatorOf } from './operator';
import { PUBLIC_PAGES } from './paths';

// v34 PUBLIC (PLAN G8): the frame of the pages anyone may read without signing in (the Guide, Privacy, Terms, Support).
// A light bar (the tape seam along its top, as the sign-in page and the consent page have it): the logo, the public
// pages' links and, at the right, Sign in, or Open TailorIT for someone already signed in. Below 640 px the links take a
// second row. Then the page (its own width and h1) and a footer with the same links and who runs the service.

/** The public pages' links: the header's and the footer's. `current` is marked for screen readers and drawn on the tape. */
function PageLinks({ label, current, className }: { label: string; current: string | null; className?: string }) {
  return (
    <nav aria-label={label} className={className}>
      <ul className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {PUBLIC_PAGES.map((page) => {
          const active = current === page.href;
          return (
            <li key={page.href}>
              <Link
                href={page.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'inline-flex min-h-11 items-center rounded-control px-2.5 text-sm font-medium transition-colors duration-150 sm:min-h-9',
                  active ? 'text-foreground underline decoration-tape decoration-[3px] underline-offset-[6px]' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                )}
              >
                {page.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Sign in, or Open TailorIT once the session is known to be live; a quiet block while it is asked. */
function AccountAction() {
  const { account, status } = useAuth();
  if (status === 'loading') return <Skeleton className="h-9 w-[7.5rem]" rounded="control" />;
  if (account) {
    return (
      <Link href={DEFAULT_AFTER_SIGN_IN} className={buttonClasses({ className: 'max-sm:h-11' })} data-public-open-app="">
        Open TailorIT
      </Link>
    );
  }
  return (
    <Link href="/login" className={buttonClasses({ className: 'max-sm:h-11' })} data-public-sign-in="">
      Sign in
    </Link>
  );
}

/** Who runs the service and how to reach them, in the footer (nothing when the operator has set neither). */
function FooterOperator() {
  const { values } = usePublicConstants();
  const operator = operatorOf(values);
  if (!operator.name && !operator.contactEmail) return null;
  return (
    <p className="text-[13px] leading-5 text-muted-foreground" data-public-operator="">
      {operator.name && (
        <>
          Run by{' '}
          {operator.website ? (
            <a href={operator.website} className="font-medium text-foreground underline underline-offset-2" rel="noopener noreferrer">
              {operator.name}
            </a>
          ) : (
            <span className="font-medium text-foreground">{operator.name}</span>
          )}
          {operator.contactEmail ? ' · ' : null}
        </>
      )}
      {operator.contactEmail && (
        <a href={`mailto:${operator.contactEmail}`} className="font-medium text-foreground underline underline-offset-2">
          {operator.contactEmail}
        </a>
      )}
    </p>
  );
}

export function PublicFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = pathname && pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return (
    <div className="flex min-h-dvh min-w-0 flex-col bg-canvas" data-public-frame="">
      <a
        href="#main"
        className="sr-only z-[90] rounded-control bg-surface px-3 py-2 text-sm font-medium text-primary shadow-popover focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="relative border-b border-border bg-surface" data-public-header="">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-tape" />
        <div className={clsx('mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-4 pt-1', PAGE_GUTTER)}>
          <div className="flex h-topbar min-w-0 flex-1 items-center gap-4 sm:flex-none">
            <Link href="/" aria-label="TailorIT" className="flex shrink-0 items-center gap-2.5 rounded-control p-1 -ml-1">
              <LogoMark size={28} />
              <Wordmark size={19} />
            </Link>
          </div>
          <PageLinks label="TailorIT pages" current={current} className="order-last -mx-2.5 w-full pb-2 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:pb-0" />
          <div className="flex h-topbar shrink-0 items-center">
            <AccountAction />
          </div>
        </div>
      </header>
      {/* tabIndex -1: the skip link puts focus here, never tabbed to. */}
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        {children}
      </main>
      <footer className="border-t border-border bg-surface" data-public-footer="">
        <div className={clsx('mx-auto flex w-full max-w-[1280px] flex-col gap-2 py-5 sm:flex-row sm:items-center sm:justify-between', PAGE_GUTTER)}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <LogoMark size={20} />
              TailorIT
            </span>
            <FooterOperator />
          </div>
          <PageLinks label="TailorIT pages, footer" current={current} className="-mx-2.5 sm:mx-0" />
        </div>
      </footer>
    </div>
  );
}
