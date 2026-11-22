'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, CopyIcon } from '@/components/ui/icons';
import { copyText } from '../settings/integrations/integrations';
import { useGuide } from './context';

// v34 HELP: the guide's own small pieces (DEVELOPMENT.md "Need a new primitive? Build it inside your feature folder"):
// prose (paragraphs, lists, steps, the names of buttons and pages), inline code, a code block and a copy button (the
// kit has neither), and a link to a page of the app that is a plain name on the public page (which has no session).

/** A paragraph of the guide's prose. */
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

/** The name of a button, a tab, a page or a setting, as the app writes it. */
export function Ui({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

/** A tool name, a value or an address, in the mono face. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-tag bg-surface-muted px-1 py-px font-mono text-[12.5px] leading-5 break-words text-foreground">{children}</code>
  );
}

/** A short aside: a tip or a caution, in a quiet box. */
export function Aside({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-control border border-border bg-surface-low px-4 py-3">
      <p className="text-sm leading-6 font-semibold text-foreground">{title}</p>
      <div className="mt-1 flex flex-col gap-2 text-sm leading-6 text-foreground">{children}</div>
    </div>
  );
}

/** A heading inside a topic (h4). */
export function Minor({ children }: { children: ReactNode }) {
  return <h4 className="mt-1 text-sm leading-6 font-semibold text-foreground">{children}</h4>;
}

/**
 * A page of the app: a link in the app; on the public page the page's name in bold (its pages need a session). `href`
 * is a path inside TailorIT.
 */
export function AppPage({ href, children }: { href: string; children: ReactNode }) {
  const { frame } = useGuide();
  if (frame === 'public') return <Ui>{children}</Ui>;
  return (
    <Link href={href} className="font-semibold text-primary-ink underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
      {children}
    </Link>
  );
}

/** A link to another part of the guide (its deep link). */
export function See({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={`#${to}`} className="font-medium text-primary-ink underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
      {children}
    </a>
  );
}

/** A link to a public page of TailorIT (support, privacy, terms): a plain link in both frames. */
export function PublicLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="font-medium text-primary-ink underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
      {children}
    </a>
  );
}

/** How long a copy button says "Copied". */
const COPIED_MS = 2_000;

/**
 * Copies `text`. The button says "Copied" for a moment (a live region says it to a screen reader too); when the
 * browser refuses, it says so and the text stays on the page to select by hand.
 */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        data-copy-button=""
        className={clsx(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-xs font-medium text-foreground',
          'transition-colors duration-150 hover:bg-hover',
          className,
        )}
      >
        {state === 'copied' ? <CheckIcon size={14} className="text-success-ink" /> : <CopyIcon size={14} />}
        <span aria-hidden="true">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it to copy' : 'Copy'}</span>
      </button>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy: select the text and copy it" : ''}
      </span>
    </>
  );
}

/** A command or a configuration to copy: a titled block in the mono face, with its copy button. */
export function CodeBlock({ title, text }: { title: string; text: string }) {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5" data-code-block="">
      <div className="flex items-center justify-between gap-3">
        <figcaption className="text-sm leading-5 font-semibold text-foreground">{title}</figcaption>
        <CopyButton text={text} label={`Copy: ${title}`} />
      </div>
      <pre className="overflow-x-auto rounded-control bg-surface-low px-3 py-2.5 font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-all text-foreground">
        {text}
      </pre>
    </figure>
  );
}
