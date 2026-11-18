'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { EyeIcon } from '@/components/ui/icons';
import { ActionMenu } from './ActionMenu';
import type { ActionMenuItem, DocumentKind } from './types';

export interface DocumentCardProps {
  kind: DocumentKind;
  id: string;
  /** The card's title (and the accessible name of its links). */
  label: string;
  /** The editor (or viewer) address; the page and the title link there. */
  href?: string;
  /** Instead of `href`: what opening the card does. */
  onOpen?: () => void;
  /**
   * v1.4 E: the full-page preview. A "Preview" button over the bottom of the page, shown on hover or focus (always on
   * a touch screen, which has no hover).
   */
  onPreview?: () => void;
  /** The first page, usually <DocumentThumb …/>. */
  thumb: ReactNode;
  /**
   * Badges under the title (★ Default, Uploaded, PDF, Generated), as kit tags (`<Badge>`): the page itself stays
   * uncovered.
   */
  badges?: ReactNode;
  /** Lines under the title ("Edited 6 hours ago · Modern"). */
  meta?: ReactNode[];
  /** A cautionary line under the meta. */
  warning?: ReactNode;
  /** Greys the page out (e.g. a disabled document). */
  dimmed?: boolean;
  menuItems?: readonly ActionMenuItem[];
  /** Selection checkbox over the page's top-right corner. */
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (checked: boolean, options: { shiftKey: boolean }) => void;
  className?: string;
}

/**
 * A document in the grid view (v31 FIX-DOCS): one framed tile. Its top is a tray (surface-muted) holding the first
 * page like a sheet on a cutting table, its foot cut by the tray's edge; the whole tray is the link that opens it (a
 * frame may not sit inside a link). Under it, on white: the title with the ⋮ menu, the badges and the meta lines.
 * Quick actions show on hover or focus (always on a touch screen): Preview at the tray's foot, the selection box at
 * its corner.
 */
export function DocumentCard({
  kind,
  id,
  label,
  href,
  onOpen,
  onPreview,
  thumb,
  badges,
  meta,
  warning,
  dimmed,
  menuItems,
  selectable,
  selected = false,
  onSelectedChange,
  className,
}: DocumentCardProps) {
  const dataAttr = { [`data-${kind}-card`]: id };
  const coverClasses = 'absolute inset-0 z-[1] focus-visible:outline-none';
  return (
    <article
      {...dataAttr}
      data-selected={selected ? '' : undefined}
      className={clsx(
        'group/card flex h-full min-w-0 flex-col overflow-hidden rounded-card border bg-surface shadow-card',
        'transition-[box-shadow,border-color] duration-150 ease-out-soft hover:shadow-popover',
        'has-[[data-cover]:focus-visible]:outline-2 has-[[data-cover]:focus-visible]:outline-offset-[3px] has-[[data-cover]:focus-visible]:outline-focus',
        selected ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-control-hover',
        className,
      )}
    >
      <div className="relative aspect-[1/1] overflow-hidden border-b border-border bg-surface-muted">
        <div
          className={clsx(
            'absolute inset-x-[11%] top-[9%] overflow-hidden rounded-t-[3px] bg-surface shadow-[0_1px_3px_var(--color-grid),0_0_0_1px_var(--color-border)]',
            'transition-transform duration-200 ease-out-soft group-hover/card:-translate-y-1',
            dimmed && 'opacity-50',
          )}
        >
          {thumb}
        </div>
        {href ? (
          <Link href={href} data-cover aria-label={`Open ${label}`} className={coverClasses} />
        ) : onOpen ? (
          <button type="button" data-cover aria-label={`Open ${label}`} onClick={onOpen} className={coverClasses} />
        ) : null}
        {onPreview && (
          <span className="pointer-events-none absolute inset-x-0 bottom-3 z-[2] flex justify-center">
            <button
              type="button"
              onClick={onPreview}
              aria-label={`Preview ${label}`}
              data-preview-button=""
              className={clsx(
                'pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-[13px] font-medium text-foreground shadow-control',
                'transition-opacity duration-150 hover:bg-surface-low focus-visible:opacity-100',
                'opacity-0 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100',
              )}
            >
              <EyeIcon size={14} />
              Preview
            </button>
          </span>
        )}
        {selectable && onSelectedChange && (
          <span
            className={clsx(
              'absolute top-2.5 right-2.5 z-[2] flex rounded-control bg-surface p-1 shadow-control transition-opacity',
              selected ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100 focus-within:opacity-100',
            )}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={(checked, details) => onSelectedChange(checked, details)}
              aria-label={`Select ${label}`}
            />
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-start justify-between gap-1.5 px-3.5 pt-3 pb-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] leading-6 font-semibold text-foreground" title={label}>
            {href ? (
              <Link href={href} className="block truncate hover:underline hover:underline-offset-2">
                {label}
              </Link>
            ) : onOpen ? (
              <button type="button" onClick={onOpen} className="block max-w-full truncate text-left hover:underline hover:underline-offset-2">
                {label}
              </button>
            ) : (
              label
            )}
          </h3>
          {badges && <div className="mt-1 mb-1.5 flex flex-wrap items-center gap-1.5">{badges}</div>}
          {meta?.map((line, index) => (
            <p key={index} className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">
              {line}
            </p>
          ))}
          {warning && <p className="mt-1.5 text-xs leading-4 text-warning-ink">{warning}</p>}
        </div>
        {menuItems && menuItems.length > 0 && (
          <ActionMenu items={menuItems} label={`Actions for ${label}`} className="-mt-0.5 -mr-1.5" />
        )}
      </div>
    </article>
  );
}
