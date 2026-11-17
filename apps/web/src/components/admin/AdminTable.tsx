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
}

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
 * Simplify's table in a white card: #f8f8f8 header row, #e8e8e8 dividers. `renderExpanded` adds a full-width row under
 * a row whose key is in `expanded` (a run's log).
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
    <ScrollRegion label={label} className={clsx('rounded-surface border border-border bg-surface shadow-soft', className)}>
      <table aria-label={label} className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="h-11 bg-surface-low">
            {columns.map((column) => (
              <th key={column.key} scope="col" className={clsx('px-4 text-sm font-semibold whitespace-nowrap text-foreground', column.className)}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const key = getKey(item);
            const open = expanded?.has(key) ?? false;
            return (
              <Fragment key={key}>
                <tr data-admin-row={key} className="border-t border-border align-middle transition-colors hover:bg-[#fcfcfc]">
                  {columns.map((column) => (
                    <td key={column.key} className={clsx('px-4 py-3.5 text-sm text-foreground', column.className)}>
                      {column.cell(item)}
                    </td>
                  ))}
                </tr>
                {open && renderExpanded && (
                  <tr className="border-t border-border bg-surface-low/60">
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
    <div className="rounded-surface border border-border bg-surface p-4 shadow-soft" aria-busy="true">
      <div className="flex flex-col gap-4">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}

/** A tab's heading row: title and description on the left, actions on the right. */
export function SectionHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl leading-7 font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
