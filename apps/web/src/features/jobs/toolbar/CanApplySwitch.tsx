'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import { useId } from 'react';
import { CheckIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Switch } from '@/components/ui/Switch';
import { WHERE_YOU_LIVE_ANCHOR } from '@/features/settings/prepare/PrepareFilters';
import { CAN_APPLY_COPY, applicantGap } from '../format';
import { useApplicantLocation } from '../hooks';

// v30 WEB-JOBS (owner question 4; 11-database.md §6 Q4): "Jobs I can apply to", off by default (the address's
// `canApply=1`). The API keeps the jobs whose rules on where candidates live and work admit the person's location and
// time zone (Settings › Job preferences › Where you live), a part it does not know passing; while the switch is on and
// a part is missing, a notice says what is not checked and links to Settings.

/** Settings › Job preferences › Where you live. */
export const WHERE_YOU_LIVE_HREF = `/settings#${WHERE_YOU_LIVE_ANCHOR}`;

/**
 * v30 FIX-WEB (INT-4 open item 8, REV-UX): "Jobs I can apply to" in the toolbar's row of filters, a toggle (pressed while
 * on), so the switch that lives in All filters is seen and turned off where the other filters are.
 */
export function CanApplyPill({ on, onChange, className }: { on: boolean; onChange: (on: boolean) => void; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={clsx(
        'inline-flex h-9 shrink-0 items-center gap-2 rounded-control border pr-3 pl-3 text-sm font-medium shadow-control',
        'transition-[border-color,background-color] duration-150',
        on
          ? 'border-primary bg-primary-50 text-primary-ink hover:bg-primary-soft'
          : 'border-border-strong bg-surface text-foreground hover:border-control-hover hover:bg-surface-low',
        className,
      )}
      data-can-apply-pill={on ? 'on' : 'off'}
    >
      {on && <CheckIcon size={14} weight="bold" className="text-primary" aria-hidden="true" />}
      <span className="whitespace-nowrap">{CAN_APPLY_COPY.label}</span>
    </button>
  );
}

export function CanApplySwitch({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (on: boolean) => void }) {
  const hintId = useId();
  const location = useApplicantLocation(checked);
  const gap = checked && location.data ? applicantGap(location.data) : null;
  return (
    <div className="flex flex-col gap-2" data-can-apply="">
      <Switch label={CAN_APPLY_COPY.label} checked={checked} onCheckedChange={onCheckedChange} aria-describedby={hintId} />
      <p id={hintId} className="text-[13px] leading-5 text-muted-foreground">
        {CAN_APPLY_COPY.hint}
      </p>
      {gap && (
        <Notice tone="warning">
          {CAN_APPLY_COPY.missing[gap]}{' '}
          <Link href={WHERE_YOU_LIVE_HREF} className="font-semibold underline underline-offset-2">
            {CAN_APPLY_COPY.settingsLink}
          </Link>
        </Notice>
      )}
    </div>
  );
}
