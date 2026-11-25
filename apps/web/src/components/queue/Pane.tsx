'use client';

import { clsx } from 'clsx';
import type { ReactNode } from 'react';

// v30 ST0: the queue-style pane's chrome, moved unchanged from features/auto-apply/Pane.tsx (v2.0's Auto-apply page,
// docs/design/v2.0/08-ui.md, "Layout"): a card with a sticky header (the `h2` title and its count, the controls), its
// list scrolling inside the pane on wide screens so two panes stay in view. The Auto-apply page's Saved and Queue
// panes use it, and Admin › Review (wave 2) will.
// v31 AUTO: on the v3.1 tokens (docs/design/v3.1/20-visual-identity.md): a card (radius 10, the card shadow), the
// title as a section heading with its count in mono, and the scrolling body's height from the top bar's token.
// v36 APPLYWEB (PLAN A1; SP v36 REQUEST.md: "In Auto-Apply Page, There will be no scroll for full screen"): a `fill` mode
// beside `scroll`: the pane takes its parent's whole height (the Auto-apply page's frame, measured to the window by
// lib/useFrameHeight) and its body scrolls in what is left under the header, above the footer; no guessed height. Admin
// › Review keeps `scroll` as it was.

export interface PaneProps {
  /** The h2's id (the section's aria-labelledby). */
  id: string;
  title: string;
  /** The count beside the title (null while loading). */
  count: number | null;
  /** The controls under the title: the filter tabs, Filters, Select, Clear finished. */
  controls?: ReactNode;
  /** v32 LAYOUT (E4): a small state beside the title (the "Out of date" mark of a refresh that failed). */
  status?: ReactNode;
  /** Wide screens: the list scrolls inside the pane. Tabs (narrow screens): the page scrolls. */
  scroll: boolean;
  /**
   * v36 APPLYWEB (PLAN A1): the pane fills its parent's height (a measured frame) and its body scrolls in the rest; wins
   * over `scroll`'s guessed height. Default false.
   */
  fill?: boolean;
  /** A bar stuck to the pane's bottom (the select mode's action bar: SelectBar). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Pane({ id, title, count, controls, status, scroll, fill = false, footer, children, className }: PaneProps) {
  return (
    <section
      aria-labelledby={id}
      className={clsx('flex min-w-0 flex-col rounded-card border border-border bg-surface shadow-card', fill && 'h-full min-h-0', className)}
      data-pane-mode={fill ? 'fill' : undefined}
    >
      <header
        className={clsx(
          'flex flex-col gap-3 rounded-t-card border-b border-border bg-surface px-4 pt-4 pb-3 sm:px-5',
          fill && 'shrink-0',
          !scroll && !fill && 'sticky top-topbar z-10',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-baseline gap-2">
            <h2 id={id} className="text-heading font-semibold text-foreground">
              {title}
            </h2>
            {count !== null && (
              <span className="num text-sm text-muted-foreground" data-pane-count="">
                {/* v37 REVIEW: "1,240", as the nav and the lanes write thousands. */}
                {count.toLocaleString('en-US')}
              </span>
            )}
          </div>
          {status}
        </div>
        {controls}
      </header>
      {/* v2.0 fix (UX-1, UX-2): the rows lay out by the pane's width (`@container/pane`), not the viewport's: a pane is
          about 390 px wide at 1024 and 490 px at 1440, beside the other one. */}
      <div
        className={clsx(
          '@container/pane min-h-0',
          fill
            ? // `relative`: what is positioned inside the list (a screen reader's live line) stays in its scroller, never
              // below the window's edge, where it would scroll the page.
              'relative flex-1 overflow-y-auto overscroll-contain'
            : scroll && 'max-h-[calc(100dvh_-_var(--spacing-topbar)_-_10rem)] overflow-y-auto overscroll-contain',
        )}
        data-pane-body=""
      >
        {children}
      </div>
      {footer}
    </section>
  );
}
