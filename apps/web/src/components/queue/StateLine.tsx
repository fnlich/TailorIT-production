'use client';

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { Spinner } from '../ui/Spinner';
import { CheckCircleIcon, ClockIcon, HandPointingIcon, InfoIcon, WarningCircleIcon, XCircleIcon } from '../ui/icons';

// v30 ST0: a queue row's state line, from the Queue pane's rows (features/auto-apply/QueuePane.tsx, v2.0): the state's
// icon, its words (a STATE_* constant), and a detail after a middle dot, coloured by its tone. The icons are the Queue
// pane's set, by name, so a row says which one it shows and the pane draws it.
// v31 AUTO: the tones are the v3.1 status tokens (warning and danger as text on a white row; info for the info icon).

/** The state icons, by name (the Queue pane's StateIcon). */
export const STATE_ICON_NAMES = ['spinner', 'clock', 'pulse', 'check', 'x', 'warning', 'hand', 'info', 'dot'] as const;
export type StateIconName = (typeof STATE_ICON_NAMES)[number];

export const STATE_ICONS: Record<StateIconName, ReactNode> = {
  spinner: <Spinner size={14} />,
  clock: <ClockIcon size={14} aria-hidden="true" />,
  pulse: <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-primary motion-safe:animate-pulse" />,
  check: <CheckCircleIcon size={14} weight="fill" className="text-success" aria-hidden="true" />,
  x: <XCircleIcon size={14} className="text-danger" aria-hidden="true" />,
  warning: <WarningCircleIcon size={14} className="text-warning" aria-hidden="true" />,
  hand: <HandPointingIcon size={14} className="text-warning" aria-hidden="true" />,
  info: <InfoIcon size={14} className="text-info" aria-hidden="true" />,
  dot: <span aria-hidden="true" className="inline-block size-2 rounded-full bg-primary" />,
};

export type StateTone = 'muted' | 'warning' | 'error';

export interface StateLineProps {
  icon: StateIconName;
  /** The state's words. */
  text: string;
  /** What follows the middle dot (a reason, a place in line), or nothing. */
  detail?: string | null;
  tone?: StateTone;
}

export function StateLine({ icon, text, detail, tone = 'muted' }: StateLineProps) {
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] leading-5" data-state-line="">
      <span className="flex shrink-0 items-center">{STATE_ICONS[icon]}</span>
      <span className="font-medium whitespace-nowrap text-foreground" data-state-words="">
        {text}
      </span>{' '}
      {detail && (
        <span className={clsx(tone === 'warning' ? 'text-warning' : tone === 'error' ? 'text-danger' : 'text-muted-foreground')}>
          · {detail}
        </span>
      )}
    </p>
  );
}
