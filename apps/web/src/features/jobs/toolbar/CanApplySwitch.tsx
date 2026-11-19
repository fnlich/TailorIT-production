'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import { CheckIcon, WarningCircleIcon } from '@/components/ui/icons';
import { Switch } from '@/components/ui/Switch';
import { WHERE_YOU_LIVE_ANCHOR } from '@/features/settings/prepare/PrepareFilters';
import { CAN_APPLY_COPY, applicantGap } from '../format';
import { HelpTip } from '@/components/ui/HelpTip';
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

/**
 * The switch in All filters. v32 JOBS2 (E4, E5): what it does is its "?"; while on and a part of the person's place is
 * missing, one short line under it says what to add, with the Settings link (next to the field, not a banner).
 */
export function CanApplySwitch({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (on: boolean) => void }) {
  const location = useApplicantLocation(checked);
  const gap = checked && location.data ? applicantGap(location.data) : null;
  return (
    <div className="flex flex-col gap-2" data-can-apply="">
      <div className="flex items-center gap-1.5">
        <Switch label={CAN_APPLY_COPY.label} checked={checked} onCheckedChange={onCheckedChange} />
        <HelpTip label={CAN_APPLY_COPY.label}>{CAN_APPLY_COPY.hint}</HelpTip>
      </div>
      {gap && (
        <p role="alert" className="flex items-start gap-1.5 text-[13px] leading-5 text-warning-ink" data-can-apply-gap={gap}>
          <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <span>
            {CAN_APPLY_COPY.missing[gap]}{' '}
            <Link href={WHERE_YOU_LIVE_HREF} className="font-semibold underline underline-offset-2">
              {CAN_APPLY_COPY.settingsLink}
            </Link>
          </span>
        </p>
      )}
    </div>
  );
}
