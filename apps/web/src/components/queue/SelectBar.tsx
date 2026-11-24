'use client';

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Tooltip } from '../ui/Tooltip';

// v30 ST0: the select mode's action bar of a queue-style pane, from the Saved pane's (features/prepare/SavedPane.tsx,
// v2.0): a toolbar stuck to the pane's bottom (Pane's `footer`) with the select-all box, "N selected" read politely,
// and the bulk actions on the right (Prepare and Cancel there; Approve and Reject in Admin › Review).
// v36 APPLYWEB (PLAN A4; SP v36 REQUEST.md: "there will be `Select All`/`Deselect All`(all saved jobs will be
// selected/deselected)"): a second way to select every row, `selectAllAs: 'button'`: one button that says Select All,
// or Deselect All once every row is selected (the Saved pane, where it loads the remaining pages first); the actions then
// wrap onto a second line where they do not fit. The box stays the default (Admin › Review).

export interface SelectBarProps {
  /** The toolbar's name ("Selected saved jobs"). */
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
  /**
   * v36 APPLYWEB: how every row is selected: the select-all box (default), or one Select All / Deselect All button
   * (`selectAllLabel` is then its tooltip).
   */
  selectAllAs?: 'box' | 'button';
  /** The button's state: every row is selected, so it says Deselect All (default: selected === selectable > 0). */
  allSelected?: boolean;
  /** The button waits (the rows not loaded yet are being read). */
  selectAllBusy?: boolean;
}

/** v36 APPLYWEB: the select-all button's words. */
export const SELECT_ALL_WORDS = { select: 'Select All', deselect: 'Deselect All' } as const;

export function SelectBar({
  'aria-label': label,
  selected,
  selectable,
  selectAllLabel,
  onSelectAll,
  children,
  selectAllAs = 'box',
  allSelected,
  selectAllBusy = false,
}: SelectBarProps) {
  const all = allSelected ?? (selected > 0 && selected === selectable);
  const button = selectAllAs === 'button';
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={clsx(
        'sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-b-card border-t border-border bg-surface-low px-4 py-3 sm:px-5',
        'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
      )}
    >
      {button ? (
        <Tooltip content={selectAllLabel}>
          <Button
            variant="outline"
            size="sm"
            className="max-sm:h-11"
            disabled={selectable === 0}
            loading={selectAllBusy}
            focusableWhenDisabled
            onClick={() => onSelectAll(!all)}
            data-select-all={all ? 'deselect' : 'select'}
          >
            {all ? SELECT_ALL_WORDS.deselect : SELECT_ALL_WORDS.select}
          </Button>
        </Tooltip>
      ) : (
        <Checkbox
          checked={selected > 0 && selected === selectable}
          indeterminate={selected > 0 && selected < selectable}
          disabled={selectable === 0}
          aria-label={selectAllLabel}
          onCheckedChange={(on) => onSelectAll(on)}
        />
      )}
      <span className="text-sm font-medium text-foreground" aria-live="polite">
        {selected} selected
      </span>
      <div className={clsx('ml-auto flex items-center gap-2', button ? 'flex-wrap justify-end' : 'max-sm:w-full')}>{children}</div>
    </div>
  );
}
