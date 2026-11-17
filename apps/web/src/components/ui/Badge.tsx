import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeTone =
  | 'outline'
  | 'primary'
  | 'tint'
  | 'neutral'
  | 'success'
  | 'destructive'
  | 'warning'
  | 'sky'
  | 'dark';

const TONES: Record<BadgeTone, string> = {
  // "Generated", "Uploaded", "PDF", "System Default"
  outline: 'border-border bg-surface text-foreground',
  // "Default" resume
  primary: 'border-transparent bg-primary text-white',
  // "Full-Time"
  tint: 'border-transparent bg-primary-container text-primary-ink',
  neutral: 'border-transparent bg-chip text-foreground',
  success: 'border-transparent bg-success-container text-[#02703c]',
  destructive: 'border-transparent bg-destructive-container text-[#c62a29]',
  warning: 'border-transparent bg-amber text-amber-foreground',
  sky: 'border-transparent bg-sky text-sky-foreground',
  // over a page thumbnail
  dark: 'border-transparent bg-black/75 text-white backdrop-blur-sm',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: ReactNode;
  /** Long words wrap onto a second line instead of being cut ("Filtered: location (TX or CA only)" on a phone). */
  wrap?: boolean;
}

/** Simplify's badge: `rounded-full border px-2 py-0.5 text-xs font-medium`, 22 px tall. */
export function Badge({ tone = 'outline', icon, wrap = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full shrink-0 items-center gap-1 border px-2 text-xs leading-4 font-semibold',
        // A wrapped badge keeps the one-line badge's corners (11 px), not a stadium's.
        wrap ? 'min-h-[22px] rounded-[11px] py-[3px]' : 'h-[22px] rounded-full whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {icon && wrap ? <span className="flex shrink-0">{icon}</span> : icon}
      <span className={wrap ? 'min-w-0 break-words' : 'truncate'}>{children}</span>
    </span>
  );
}

/** Small round count, as in Simplify's "Job Type [1]" pill. */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-chip px-1.5 text-xs leading-none font-medium text-muted-foreground tabular-nums',
        className,
      )}
    >
      {count}
    </span>
  );
}
