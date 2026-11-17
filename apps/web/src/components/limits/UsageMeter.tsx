'use client';

import { clsx } from 'clsx';
import { resetText as resetTextOf } from '@tailorit/shared/constants';
import { usePublicConstants } from '../../lib/constants';
// Relative, not '@/': the web tests draw these views.
import { Skeleton } from '../ui/Skeleton';
import { LIMIT_COPY } from './copy';
import { usageState } from './limits';

// v2.0: the Free auto-apply usage, "3 of 7 used today" (docs/design/v2.0/08-ui.md, "Shared pieces"): a short segmented
// bar plus the words (MSG_AUTO_APPLY_USAGE), `role="meter"`. Reserved runs (in progress) are striped. At the limit the
// bar and words turn to the warning colours and a line says when it resets. A Paid (unlimited) account shows no meter:
// the caller leaves it out (Settings › Account says "Unlimited").

/** Above this many, one continuous bar replaces the segments (an admin may raise the limit). */
export const USAGE_SEGMENTS_MAX = 20;

const STRIPES = {
  normal: 'bg-[repeating-linear-gradient(135deg,var(--color-primary)_0_3px,var(--color-primary-200)_3px_6px)]',
  reached: 'bg-[repeating-linear-gradient(135deg,var(--color-warning)_0_3px,var(--color-amber)_3px_6px)]',
};

export interface UsageMeterProps {
  /** Reserved and used auto-applies in the current window (the server's count). */
  used: number;
  /** The plan's limit for the window (a number: an unlimited account shows no meter). */
  limit: number;
  /** Of `used`, the runs still in progress (striped). */
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
  const tone = state.reached ? 'reached' : 'normal';
  const filled = state.reached ? 'bg-warning' : 'bg-primary';
  const done = state.used - state.reserved;
  return (
    <div className={clsx('flex flex-col gap-1', className)} data-usage-meter={tone}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={state.limit}
        aria-valuenow={state.valueNow}
        aria-valuetext={words}
        className="flex items-center gap-2"
      >
        {state.limit > 0 && state.limit <= USAGE_SEGMENTS_MAX ? (
          <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
            {Array.from({ length: state.limit }, (_unused, index) => (
              <span
                key={index}
                data-segment={index < done ? 'used' : index < state.used ? 'reserved' : 'free'}
                className={clsx(
                  'h-2 w-2.5 rounded-[2px]',
                  index < done ? filled : index < state.used ? STRIPES[tone] : 'bg-chip',
                )}
              />
            ))}
          </span>
        ) : (
          <span className="relative h-2 w-20 shrink-0 overflow-hidden rounded-full bg-chip" aria-hidden="true">
            <span
              className={clsx('absolute inset-y-0 left-0', filled)}
              style={{ width: `${state.limit === 0 ? 100 : Math.min(100, (state.used / state.limit) * 100)}%` }}
            />
          </span>
        )}
        <span
          className={clsx(
            'text-xs leading-4 font-semibold tabular-nums',
            state.reached ? 'text-amber-foreground' : 'text-foreground',
          )}
        >
          {words}
        </span>
      </div>
      {state.reached && showReset && (
        <p className="text-xs leading-4 text-amber-foreground">{LIMIT_COPY.resetsAt(when)}</p>
      )}
    </div>
  );
}

/** The meter's place while the account loads (08-ui.md: "The meter shows a skeleton bar."). */
export function UsageMeterSkeleton({ className }: { className?: string }) {
  return (
    <span className={clsx('flex items-center gap-2', className)} aria-hidden="true">
      <Skeleton className="h-2 w-20" rounded="full" />
      <Skeleton className="h-3 w-24" />
    </span>
  );
}
