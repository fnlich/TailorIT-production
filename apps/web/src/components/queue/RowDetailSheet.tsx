'use client';

import { useId, type ReactNode } from 'react';
import { Sheet, SheetContent } from '../ui/Sheet';

// v30 ST0: a queue row's detail sheet, from the Auto-apply page's kit sheet (features/auto-apply/KitSheet.tsx, v2.0):
// a side sheet for one row, kept on screen with its row while it slides out (the page holds the last row it opened),
// its title wrapping on a phone; and the numbered steps the kit sheet lists. Admin › Review (wave 2) shows a review's
// evidence in it.

export interface RowDetailSheetProps<T> {
  /** The row shown (kept while the sheet slides out); nothing is drawn while it is null. */
  item: T | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: (item: T) => ReactNode;
  description?: ReactNode;
  /** Buttons at the sheet's foot (Approve, Reject). */
  footer?: (item: T) => ReactNode;
  /** The sheet's width classes (the kit sheet: "sm:max-w-120!"). */
  className?: string;
  children: (item: T) => ReactNode;
}

export function RowDetailSheet<T>({ item, open, onOpenChange, title, description, footer, className, children }: RowDetailSheetProps<T>) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {item && (
        <SheetContent title={title(item)} description={description} footer={footer?.(item)} className={className} wrapTitle>
          {children(item)}
        </SheetContent>
      )}
    </Sheet>
  );
}

/** One numbered step of a detail sheet (the kit sheet's): its number in a round badge, its title, its body. */
export function DetailStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  const id = useId();
  return (
    <li className="flex gap-3" aria-labelledby={id}>
      <span
        aria-hidden="true"
        className="num flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs text-primary-ink"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1">
        <h3 id={id} className="text-sm leading-6 font-semibold text-foreground">
          <span className="sr-only">Step {number}: </span>
          {title}
        </h3>
        <div className="mt-2 flex flex-col gap-2">{children}</div>
      </div>
    </li>
  );
}
