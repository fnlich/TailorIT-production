'use client';

import { clsx } from 'clsx';
import { resetText as resetTextOf } from '@tailorit/shared/constants';
import { usePublicConstants } from '../../lib/constants';
// Relative, not '@/': the web tests draw these views.
import { Skeleton } from '../ui/Skeleton';
import { TapeMeter } from '../ui/TapeMeter';
import { LIMIT_COPY } from './copy';
import { usageState } from './limits';

// v2.0: the Free auto-apply usage, "3 of 7 used today" (docs/design/v2.0/08-ui.md, "Shared pieces"), `role="meter"`.
// v31 AUTO: drawn as the kit's TapeMeter (docs/design/v3.1/20-visual-identity.md §7): a denim fill against the limit and
// the words in mono beside it (also its aria-valuetext); the runs still in progress are said under it ("1 applying
// now"). At the limit the fill turns to the warning tone and a line says when it resets. A Paid (unlimited) account
// shows no meter: the caller leaves it out (Settings › Account says "Unlimited").

export interface UsageMeterProps {
  /** Reserved and used auto-applies in the current window (the server's count). */
  used: number;
  /** The plan's limit for the window (a number: an unlimited account shows no meter). */
  limit: number;
  /** Of `used`, the runs still in progress. */
  reserved?: number;
  /** "12:00 AM Pacific Time", from the server's answer; by default from the public constants. */
  resetText?: string;
  /** The meter's accessible name. */
  label?: string;
  /**
   * The words beside the bar (also its aria-valuetext); by default MSG_AUTO_APPLY_USAGE, "3 of 7 used today". Another
   * count passes its own (Settings › Account's "23 of 30 resumes", with `showReset` off).
   */
  text?: string;
  /** Lay the reset line under the bar at the limit (default) or leave it out. */
  showReset?: boolean;
  className?: string;
}

export function UsageMeter({
  used,
  limit,
  reserved = 0,
  resetText,
  label = LIMIT_COPY.usageLabel,
  text,
  showReset = true,
  className,
}: UsageMeterProps) {
  const { t, values } = usePublicConstants();
  const state = usageState(used, limit, reserved);
  const words = text ?? t('MSG_AUTO_APPLY_USAGE', { used: state.used, limit: state.limit });
  const when = resetText ?? resetTextOf(values.DAY_RESET_TIME, values.DAY_RESET_ZONE_LABEL);
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1', className)} data-usage-meter={state.reached ? 'reached' : 'normal'}>
      <TapeMeter
        label={label}
        value={state.valueNow}
        max={state.limit}
        valueText={words}
        tone={state.reached ? 'warning' : 'primary'}
        size="sm"
        layout="inline"
        className="w-64 max-w-full"
      />
      {state.reserved > 0 && (
        <p className="text-xs leading-4 text-muted-foreground" data-usage-running={state.reserved}>
          {LIMIT_COPY.running(state.reserved)}
        </p>
      )}
      {state.reached && showReset && <p className="text-xs leading-4 text-warning">{LIMIT_COPY.resetsAt(when)}</p>}
    </div>
  );
}

/** The meter's place while the account loads (08-ui.md: "The meter shows a skeleton bar."). */
export function UsageMeterSkeleton({ className }: { className?: string }) {
  return (
    <span className={clsx('flex w-64 max-w-full items-center gap-2.5', className)} aria-hidden="true">
      <Skeleton className="h-1.5 flex-1" />
      <Skeleton className="h-3 w-24" />
    </span>
  );
}
