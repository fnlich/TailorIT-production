'use client';

import type { SharePermission } from '@tailorit/shared/sharing';
import { clsx } from 'clsx';
import { useId } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Checkbox } from '../../components/ui/Checkbox';
import { HelpTip } from '../../components/ui/HelpTip';
import { Tooltip } from '../../components/ui/Tooltip';
import { usePublicConstants } from '../../lib/constants';
import { GRANT_COPY } from './copy';
import { gridOf, toggleBox, type GridBox, type GridRow } from './grid';

// v33 SHARE-7 (PLAN F9 "Permissions"; SP v33 PLAN-sharing.md §3): the grid of boxes the person (A) ticks for one share:
// a row per area (its name, its "?" saying what it covers), a See and a Change column. A box another ticked box needs
// is ticked and disabled; its tip (on hover, and in its accessible name) says which row needs it. Ticking a box ticks
// what it needs (grid.ts), so the set sent is always closed.

export interface PermissionGridProps {
  value: readonly SharePermission[];
  onChange: (next: SharePermission[]) => void;
  disabled?: boolean;
  className?: string;
}

export function PermissionGrid({ value, onChange, disabled = false, className }: PermissionGridProps) {
  const { t } = usePublicConstants();
  const captionId = useId();
  const rows = gridOf(value, (label) => t(label));
  const see = t('LABEL_SHARING_SEE');
  const change = t('LABEL_SHARING_CHANGE');
  return (
    <table className={clsx('w-full border-collapse text-sm', className)} aria-labelledby={captionId} data-permission-grid="">
      <caption id={captionId} className="sr-only">
        {GRANT_COPY.grid}
      </caption>
      <thead>
        <tr className="border-b border-border text-left text-xs leading-5 font-semibold text-muted-foreground">
          <th scope="col" className="py-2 pr-2 font-semibold">
            <span className="sr-only">Area</span>
          </th>
          <th scope="col" className="w-16 py-2 text-center font-semibold">
            {see}
          </th>
          <th scope="col" className="w-16 py-2 text-center font-semibold">
            {change}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-divider-soft">
        {rows.map((row) => (
          <GridRowView
            key={row.id}
            row={row}
            seeLabel={see}
            changeLabel={change}
            disabled={disabled}
            onToggle={(perm, on) => onChange(toggleBox(value, perm, on))}
          />
        ))}
      </tbody>
    </table>
  );
}

function GridRowView({
  row,
  seeLabel,
  changeLabel,
  disabled,
  onToggle,
}: {
  row: GridRow;
  seeLabel: string;
  changeLabel: string;
  disabled: boolean;
  onToggle: (perm: SharePermission, on: boolean) => void;
}) {
  const { t } = usePublicConstants();
  const label = t(row.label);
  return (
    <tr data-grid-row={row.id}>
      <th scope="row" className="py-2.5 pr-2 text-left font-normal">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm leading-5 font-medium text-foreground">{label}</span>
          <HelpTip label={label}>{t(row.tip)}</HelpTip>
        </span>
      </th>
      <td className="py-2.5 text-center align-middle">
        {row.see ? <BoxCell box={row.see} rowLabel={label} column={seeLabel} disabled={disabled} onToggle={onToggle} /> : <NotOffered />}
      </td>
      <td className="py-2.5 text-center align-middle">
        {row.change ? (
          <BoxCell box={row.change} rowLabel={label} column={changeLabel} disabled={disabled} onToggle={onToggle} />
        ) : (
          <NotOffered />
        )}
      </td>
    </tr>
  );
}

function BoxCell({
  box,
  rowLabel,
  column,
  disabled,
  onToggle,
}: {
  box: GridBox;
  rowLabel: string;
  column: string;
  disabled: boolean;
  onToggle: (perm: SharePermission, on: boolean) => void;
}) {
  const { t } = usePublicConstants();
  const tip = box.locked && box.neededByRow ? t('MSG_SHARING_NEEDED_BY', { row: box.neededByRow }) : null;
  const checkbox = (
    <Checkbox
      checked={box.checked}
      disabled={disabled || box.locked}
      // The name says the row and the column; a box another box needs also says which (its tip on hover).
      aria-label={tip ? `${rowLabel}: ${column}. ${tip}` : `${rowLabel}: ${column}`}
      onCheckedChange={(next) => onToggle(box.perm, next)}
    />
  );
  return (
    <span className="inline-flex min-h-11 min-w-11 items-center justify-center sm:min-h-8 sm:min-w-8" data-box={box.perm} data-locked={box.locked ? '' : undefined}>
      {tip ? (
        <Tooltip content={tip}>
          <span className="inline-flex" data-needed-by={box.neededByRow ?? undefined}>
            {checkbox}
          </span>
        </Tooltip>
      ) : (
        checkbox
      )}
    </span>
  );
}

function NotOffered() {
  return (
    <span className="text-muted-foreground" aria-label={GRANT_COPY.notApplicable} role="img">
      –
    </span>
  );
}
