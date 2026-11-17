'use client';

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { SparkleIcon, XIcon } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/Spinner';

/*
 * Small pieces the editor's toolbars and its phone forms share, so they read alike.
 */

/** Removable chips; `renderExtra` puts a control inside a chip, before its ✕ (the heading select). */
export function ChipList({
  items,
  onRemove,
  renderExtra,
  tone = 'tint',
  label,
}: {
  items: readonly string[];
  onRemove: (item: string) => void;
  renderExtra?: (item: string) => ReactNode;
  tone?: 'tint' | 'neutral';
  /** Names the list for assistive tech ("Technical skills"). */
  label: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-2">
      {items.map((item, index) => (
        // The index joins the key: a stored list may hold a name twice; a chip has no state to lose.
        <li
          key={`${index}:${item}`}
          className={clsx(
            'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full py-1 pr-1 pl-3 text-[13px] leading-5 font-medium',
            tone === 'tint' ? 'bg-primary-container text-primary-ink' : 'bg-chip text-foreground',
          )}
        >
          <span className="truncate">{item}</span>
          {renderExtra?.(item)}
          <button
            type="button"
            onClick={() => onRemove(item)}
            aria-label={`Remove ${item}`}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full opacity-70 transition-[opacity,background-color] hover:bg-black/[0.08] hover:opacity-100"
          >
            <XIcon size={11} weight="bold" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Write with AI / Improve with AI: Simplify's "Improve your resume" tint, a sparkle, a spinner while it runs. */
export function AiButton({
  children,
  onClick,
  disabled,
  running,
  describedBy,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  running?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || running}
      aria-describedby={describedBy}
      aria-busy={running || undefined}
      className={clsx(
        'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-control border border-improve-border bg-improve px-3.5 text-sm font-semibold whitespace-nowrap text-primary-ink',
        'transition-colors duration-150 hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {running ? <Spinner size={16} /> : <SparkleIcon size={16} weight="fill" />}
      {children}
    </button>
  );
}
