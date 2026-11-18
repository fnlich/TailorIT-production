'use client';

import { clsx } from 'clsx';
import { Fragment, type ReactNode } from 'react';
import { Skeleton } from '../ui/Skeleton';

// v30 ST0: the admin tabs' table, its loading rows and its heading row, moved unchanged from
// features/settings/admin/parts.tsx (which re-exports them). AdminResourceTab builds a whole tab from them.

/** A column of an admin table: its header and how a row renders in it. */
export interface AdminColumn<T> {
  key: string;
  header: ReactNode;
  cell: (item: T) => ReactNode;
  /** Width/alignment classes for the header and cells (e.g. "w-40 text-right"). */
  className?: string;
  /** v31 ADMINWEB: a column of numbers: right-aligned, its cells in the measurement face (`num`, the guide §3). */
  numeric?: boolean;
  /**
   * v31 FIX-WEB (REV-UX UX-2): the column stays at the box's left edge while a table wider than its box scrolls
   * sideways (a row's name stays beside its actions).
   */
  sticky?: boolean;
}

/** A sticky column's cells: at the left edge, over the cells scrolling under them, in the row's own colour. */
const STICKY_CELL = 'sticky left-0 z-[1] bg-inherit';

/**
 * v30 FIX-WEB (REV-UX UX-7): a box that scrolls sideways when its table is wider than the screen. It is `relative`, so
 * an absolutely placed sr-only word in a cell (Sources' "Actions" header) stays inside it instead of widening the whole
 * page, and it is a named, focusable region, so a keyboard can scroll it (axe `scrollable-region-focusable`).
 */
export function ScrollRegion({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className={clsx('relative overflow-x-auto', className)} data-scroll-region="">
      {children}
    </div>
  );
}

/**
 * A table in a white card (v3.1 "Denim & Tape", docs/design/v3.1/20-visual-identity.md §8): a 44 px header row on
 * `surface-low` with the column heads in spaced capitals, rows of at least 44 px split by `divider-soft` that lighten on
 * hover. `renderExpanded` adds a full-width row under a row whose key is in `expanded` (a run's log).
 * v31 FIX-WEB (REV-UX UX-2): the scroll box is a size container (`@container/table`), so a tab lays its columns out by
 * the room the table has (the content column, not the window: the sidebar takes 64 or 240 px of it).
 */
export function AdminTable<T>({
  items,
  columns,
  getKey,
  renderExpanded,
  expanded,
  'aria-label': label,
  className,
}: {
  items: readonly T[];
  columns: readonly AdminColumn<T>[];
  getKey: (item: T) => string | number;
  renderExpanded?: (item: T) => ReactNode;
  expanded?: ReadonlySet<string | number>;
  'aria-label': string;
  className?: string;
}) {
  return (
    <ScrollRegion label={label} className={clsx('@container/table rounded-card border border-border bg-surface shadow-card', className)}>
      <table aria-label={label} className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="h-11 border-b border-border bg-surface-low">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={clsx(
                  'px-4 text-[11px] leading-4 font-semibold tracking-[0.06em] whitespace-nowrap text-subtle-foreground uppercase',
                  column.numeric && 'text-right',
                  column.sticky && STICKY_CELL,
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-divider-soft">
          {items.map((item) => {
            const key = getKey(item);
            const open = expanded?.has(key) ?? false;
            return (
              <Fragment key={key}>
                <tr data-admin-row={key} className="bg-surface align-middle transition-colors hover:bg-surface-low">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={clsx('px-4 py-3.5 text-sm text-foreground', column.numeric && 'num text-right', column.sticky && STICKY_CELL, column.className)}
                    >
                      {column.cell(item)}
                    </td>
                  ))}
                </tr>
                {open && renderExpanded && (
                  <tr className="bg-surface-low">
                    <td colSpan={columns.length} className="px-4 py-4">
                      {renderExpanded(item)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/** A few grey rows while a table loads. */
export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-card" aria-busy="true">
      <div className="flex flex-col gap-4">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}

/** A tab's heading row: its h2 (a section heading, 18/24) and description on the left, actions on the right. */
export function SectionHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-heading font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-1 max-w-3xl text-[13px] leading-5 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
