'use client';

import { clsx } from 'clsx';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { CaretUpDownIcon } from './icons';

export interface FilterPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: ReactNode;
  /** How many values are chosen; 0 / undefined shows the up-down caret instead of a count. */
  count?: number;
  /** A leading icon (Options: sliders). */
  icon?: ReactNode;
  /** Highlights the control while its panel is open or it filters something. */
  active?: boolean;
  /**
   * Draws the ⇕ caret when nothing is counted (default): the control opens a list. False for one that opens a dialog
   * (Auto-apply's Filters, v31 FIX-WEB REV-UX UX-12), so it does not look like a select.
   */
  caret?: boolean;
}

/**
 * A filter control: a 36 px white box (radius 6, the strong border) reading "Location ⇕" or "Job Type 1"; while it
 * filters something it turns denim-soft with a denim border and a denim count. It is a plain button that forwards ref
 * and props, so a Menu/Popover trigger can render it.
 */
export const FilterPill = forwardRef<HTMLButtonElement, FilterPillProps>(function FilterPill(
  { label, count, icon, active, caret = true, className, type, ...rest },
  ref,
) {
  const counted = Boolean(count && count > 0);
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={clsx(
        'inline-flex h-9 shrink-0 items-center gap-2 rounded-control border pl-3 text-sm shadow-control',
        counted || caret ? 'pr-2.5' : 'pr-3',
        'transition-[border-color,background-color,box-shadow] duration-150',
        active || counted
          ? 'border-primary bg-primary-50 text-primary-ink hover:bg-primary-soft'
          : 'border-border-strong bg-surface text-foreground hover:border-control-hover hover:bg-surface-low',
        'data-popup-open:border-primary data-popup-open:shadow-focus',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {icon && <span className="flex">{icon}</span>}
      <span className="font-medium whitespace-nowrap">{label}</span>
      {counted ? (
        <span className="num inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] leading-none text-on-primary">
          {count}
        </span>
      ) : caret ? (
        <CaretUpDownIcon size={14} className="text-muted-foreground" data-filter-caret="" />
      ) : null}
    </button>
  );
});
