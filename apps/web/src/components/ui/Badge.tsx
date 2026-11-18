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
  | 'dark'
  | 'tape';

const TONES: Record<BadgeTone, string> = {
  // "Generated", "Uploaded", "PDF", "Built in"
  outline: 'border-border-strong bg-surface text-foreground',
  // "Default" resume
  primary: 'border-transparent bg-primary text-on-primary',
  // "Full-Time"
  tint: 'border-transparent bg-primary-soft text-primary-ink',
  neutral: 'border-transparent bg-surface-muted text-foreground',
  success: 'border-transparent bg-success-soft text-success-ink',
  destructive: 'border-transparent bg-danger-soft text-danger-ink',
  warning: 'border-transparent bg-warning-soft text-warning-ink',
  sky: 'border-transparent bg-info-soft text-info-ink',
  // over a page thumbnail
  dark: 'border-transparent bg-sidebar/85 text-sidebar-strong backdrop-blur-sm',
  // a highlight ("Best match", "New"): the tape, always with ink text
  tape: 'border-transparent bg-tape text-foreground',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: ReactNode;
  /** Long words wrap onto a second line instead of being cut ("Filtered: location (TX or CA only)" on a phone). */
  wrap?: boolean;
}

/**
 * A tag: 22 px, radius 4 (a garment label, not a pill), `px-2 text-xs font-medium` with a 1 px border; one tone per
 * meaning (see docs/design/v3.1/20-visual-identity.md, "Badges").
 */
export function Badge({ tone = 'outline', icon, wrap = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full shrink-0 items-center gap-1 rounded-tag border px-2 text-xs leading-4 font-medium',
        wrap ? 'min-h-[22px] py-[2px]' : 'h-[22px] whitespace-nowrap',
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

/** A small round count ("Job Type 1"), set in the measurement face. */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={clsx(
        'num inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-muted px-1.5 text-[11px] leading-none text-muted-foreground',
        className,
      )}
    >
      {count}
    </span>
  );
}
