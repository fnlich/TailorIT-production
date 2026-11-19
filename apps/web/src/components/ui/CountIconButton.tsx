'use client';

import { clsx } from 'clsx';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

// v32 LAYOUT (E10): a queue pane's toolbar button drawn as its icon alone (the owner: "Filter, Select button will be
// shown with only icon ... so that these button will be located on same line of left tab"), with a small count badge
// when it counts something (Filters' "n on"). It looks like the kit's FilterPill (36 px, radius 6, the strong border;
// denim-soft with a denim border while it counts), has its name and a tooltip, and is 44 px on a phone. v32 INT-1: a
// kit primitive (DEVELOPMENT.md, "Need a new primitive?"; design 20 §8 "Icon-only toolbar buttons").

export interface CountIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The accessible name ("Filters, 2 on"); it says the count, so the badge itself is hidden from screen readers. */
  label: string;
  /** The tooltip's words; the label by default. */
  tooltip?: ReactNode;
  icon: ReactNode;
  /** The count in the badge; 0, null or undefined draws none. */
  count?: number | null;
}

export const CountIconButton = forwardRef<HTMLButtonElement, CountIconButtonProps>(function CountIconButton(
  { label, tooltip, icon, count, className, type, ...rest },
  ref,
) {
  const counted = typeof count === 'number' && count > 0;
  return (
    <Tooltip content={tooltip ?? label}>
      <button
        ref={ref}
        type={type ?? 'button'}
        aria-label={label}
        data-count-icon-button=""
        className={clsx(
          'relative inline-flex size-9 shrink-0 items-center justify-center rounded-control border shadow-control max-sm:size-11',
          'transition-[border-color,background-color,box-shadow] duration-150',
          counted
            ? 'border-primary bg-primary-50 text-primary-ink hover:bg-primary-soft'
            : 'border-border-strong bg-surface text-foreground hover:border-control-hover hover:bg-surface-low',
          'data-popup-open:border-primary data-popup-open:shadow-focus disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
        {...rest}
      >
        {icon}
        {counted && (
          <span
            aria-hidden="true"
            data-count-badge=""
            className="num absolute -top-1.5 -right-1.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none text-on-primary ring-2 ring-surface"
          >
            {count}
          </span>
        )}
      </button>
    </Tooltip>
  );
});
