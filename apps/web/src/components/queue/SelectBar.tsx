'use client';

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { Checkbox } from '../ui/Checkbox';

// v30 ST0: the select mode's action bar of a queue-style pane, from the Saved pane's (features/prepare/SavedPane.tsx,
// v2.0): a toolbar stuck to the pane's bottom (Pane's `footer`) with the select-all box, "N selected" read politely,
// and the bulk actions on the right (Prepare & Queue and Cancel there; Approve and Reject in Admin › Review).

export interface SelectBarProps {
  /** The toolbar's name ("Prepare & Queue the selected jobs"). */
  'aria-label': string;
  /** How many rows are selected. */
  selected: number;
  /** How many rows shown can be selected (the select-all box selects them all). */
  selectable: number;
  /** The select-all box's name ("Select every saved job shown that can be prepared"). */
  selectAllLabel: string;
  /** The select-all box changed: select every selectable row (true) or none (false). */
  onSelectAll: (all: boolean) => void;
  /** The bulk actions (buttons), right-aligned; the full width on a phone. */
  children: ReactNode;
}

export function SelectBar({ 'aria-label': label, selected, selectable, selectAllLabel, onSelectAll, children }: SelectBarProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={clsx(
        'sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-b-card border-t border-border bg-surface-low px-4 py-3 sm:px-5',
        'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
      )}
    >
      <Checkbox
        checked={selected > 0 && selected === selectable}
        indeterminate={selected > 0 && selected < selectable}
        disabled={selectable === 0}
        aria-label={selectAllLabel}
        onCheckedChange={(on) => onSelectAll(on)}
      />
      <span className="text-sm font-medium text-foreground" aria-live="polite">
        {selected} selected
      </span>
      <div className="ml-auto flex items-center gap-2 max-sm:w-full">{children}</div>
    </div>
  );
}
