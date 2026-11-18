'use client';

import { clsx } from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import type { Selection } from './useSelection';
import type { DocumentColumn, DocumentKind } from './types';

export type DocumentListVariant = 'table' | 'cards';

export interface DocumentListProps<T> {
  kind: DocumentKind;
  /**
   * v31 FIX-DOCS: both draw the documents table in a bordered box (a 44 px header row on surface-low with
   * spaced-capital column heads, divider-soft lines between rows, rows at least 56 px), as it sits inside the
   * Documents panel. "table": a 5.5rem actions column (✎ and ⋮); "cards": a 2.5rem ⋮ column.
   */
  variant: DocumentListVariant;
  items: readonly T[];
  getId: (item: T) => string;
  /** For accessible names: "Select {label}". */
  getLabel: (item: T) => string;
  columns: readonly DocumentColumn<T>[];
  /** The last cell of each row (table: ✎ Edit and ⋮; cards: a ⋮ ActionMenu). */
  renderActions?: (item: T) => ReactNode;
  /** Header of the actions column (default "Actions", for screen readers only). */
  actionsHeader?: ReactNode;
  /** Track of the actions column (table default 5.5rem, cards 2.5rem). */
  actionsTrack?: string;
  /** Adds a checkbox column (with select-all in the header). */
  selection?: Selection;
  /** Rows that cannot be selected (e.g. system templates) get a disabled box. */
  isSelectable?: (item: T) => boolean;
  /** Greys out a row's cells. */
  dimmed?: (item: T) => boolean;
  /** Names the select-all box: "Select all resumes". */
  selectAllLabel?: string;
  'aria-label': string;
  className?: string;
}

/**
 * The list view of a document collection, laid out with CSS grid but exposed as an ARIA table (column headers
 * are announced, unlike free_tailor's aria-hidden header). Rows carry `data-{kind}-row="{id}"` for focus moves.
 */
export function DocumentList<T>({
  kind,
  variant,
  items,
  getId,
  getLabel,
  columns,
  renderActions,
  actionsHeader,
  actionsTrack,
  selection,
  isSelectable,
  dimmed,
  selectAllLabel = 'Select all',
  className,
  ...aria
}: DocumentListProps<T>) {
  const table = variant === 'table';
  const hasActions = Boolean(renderActions);
  const tracks = [
    selection ? '18px' : null,
    ...columns.map((column) => column.track),
    hasActions ? (actionsTrack ?? (table ? '5.5rem' : '2.5rem')) : null,
  ].filter(Boolean);
  const mobileTracks = [selection ? '18px' : null, 'minmax(0,1fr)', hasActions ? 'auto' : null].filter(Boolean);
  const gridStyle = {
    '--doc-cols': tracks.join(' '),
    '--doc-cols-sm': mobileTracks.join(' '),
  } as CSSProperties;

  const rowGrid = clsx(
    'grid items-center [grid-template-columns:var(--doc-cols-sm)] sm:[grid-template-columns:var(--doc-cols)]',
    'gap-x-4 px-4',
  );
  // On phones the extra cells stack under the name; checkbox and actions stay on the first line.
  const mainCol = selection ? 'max-sm:col-start-2' : 'max-sm:col-start-1';
  const actionsCol = selection ? 'max-sm:col-start-3' : 'max-sm:col-start-2';

  const selectableIds = selection ? items.filter((item) => isSelectable?.(item) ?? true).map(getId) : [];
  // Column heads in the group-label style (spaced capitals); the words themselves stay as written for screen readers.
  const headerTone = 'text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase';

  return (
    <div
      role="table"
      aria-label={aria['aria-label']}
      className={clsx('overflow-hidden rounded-card border border-border bg-surface', className)}
      style={gridStyle}
    >
      <div role="rowgroup">
        <div
          role="row"
          className={clsx(
            rowGrid,
            'h-11 border-b border-border bg-surface-low',
            !selection && 'max-sm:hidden',
          )}
        >
          {selection && (
            <span role="columnheader" className="flex items-center">
              <Checkbox
                checked={selection.allSelected}
                indeterminate={selection.someSelected}
                disabled={selectableIds.length === 0}
                onCheckedChange={(checked) => selection.setAll(checked)}
                aria-label={selectAllLabel}
              />
            </span>
          )}
          {columns.map((column, index) => (
            <span
              key={column.key}
              role="columnheader"
              className={clsx(
                'truncate',
                headerTone,
                column.align === 'end' && 'text-right',
                index > 0 && 'max-sm:hidden',
                index === 0 && mainCol,
              )}
            >
              {column.header}
            </span>
          ))}
          {hasActions && (
            <span role="columnheader" className={clsx(headerTone, 'max-sm:hidden')}>
              {actionsHeader ?? <span className="sr-only">Actions</span>}
            </span>
          )}
        </div>
      </div>
      <div role="rowgroup">
        {items.map((item) => {
          const id = getId(item);
          const canSelect = isSelectable?.(item) ?? true;
          const selected = selection?.isSelected(id) ?? false;
          const isDimmed = dimmed?.(item) ?? false;
          return (
            <div
              key={id}
              role="row"
              data-selected={selected ? '' : undefined}
              {...{ [`data-${kind}-row`]: id }}
              className={clsx(
                rowGrid,
                'gap-y-1 transition-colors duration-100',
                // Each colour is chosen once (classes are not merged, so two backgrounds must never meet).
                'min-h-14 border-b border-divider-soft py-3 last:border-b-0',
                selected ? 'bg-primary-soft' : 'hover:bg-surface-low',
              )}
            >
              {selection && (
                <span role="cell" className="flex items-center max-sm:row-start-1 max-sm:self-start max-sm:pt-0.5">
                  <Checkbox
                    checked={selected}
                    disabled={!canSelect}
                    onCheckedChange={(checked, details) => selection.toggle(id, checked, details)}
                    aria-label={`Select ${getLabel(item)}`}
                  />
                </span>
              )}
              {columns.map((column, index) => (
                <div
                  key={column.key}
                  role="cell"
                  className={clsx(
                    'min-w-0 text-sm text-foreground',
                    column.align === 'end' && 'sm:text-right',
                    index === 0 ? clsx(mainCol, 'max-sm:row-start-1') : clsx(mainCol, 'max-sm:text-[13px] max-sm:text-muted-foreground'),
                    column.hideOnMobile && 'max-sm:hidden',
                    isDimmed && 'opacity-60',
                    column.className,
                  )}
                >
                  {column.cell(item)}
                </div>
              ))}
              {renderActions && (
                <div role="cell" className={clsx('flex min-w-0 items-center justify-end', actionsCol, 'max-sm:row-start-1 max-sm:self-start')}>
                  {renderActions(item)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
