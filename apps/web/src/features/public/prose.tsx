import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';

// v34 PUBLIC: the public pages' prose pieces (DEVELOPMENT.md "Need a new primitive? Build it inside your feature
// folder"): paragraphs, lists, the names of pages and buttons, addresses, and links that read as links inside a sentence
// (underlined, so colour is never the only sign). The policy pages are reference prose, not UI copy: the v3.2 "brief
// copy" rule covers controls, and none of this goes into a description, hint or tip prop.

/** A paragraph. */
export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={clsx('text-sm leading-6 text-foreground', className)}>{children}</p>;
}

/** A bulleted list. */
export function Bullets({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm leading-6 text-foreground marker:text-subtle-foreground">{children}</ul>;
}

/** Numbered steps. */
export function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-6 text-foreground marker:font-semibold marker:text-muted-foreground">
      {children}
    </ol>
  );
}

/** A lead-in word or phrase of a list item ("Resumes."), or the name of a page, a tab or a button. */
export function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

/** An address, a value or a message's exact words, in the mono face. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-tag bg-surface-muted px-1 py-px font-mono text-[12.5px] leading-5 [overflow-wrap:anywhere] text-foreground">{children}</code>
  );
}

const TEXT_LINK = 'font-medium text-primary-ink underline underline-offset-2 hover:text-primary';

/** A link inside a sentence: a page of this site (client navigation, keeping a #section), or an outside address. */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith('/')) {
    return (
      <Link href={href} className={TEXT_LINK}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={TEXT_LINK} rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** "1 day", "90 days". */
export const days = (count: number): string => `${count} ${count === 1 ? 'day' : 'days'}`;
/** "1 minute", "10 minutes". */
export const minutes = (count: number): string => `${count} ${count === 1 ? 'minute' : 'minutes'}`;
