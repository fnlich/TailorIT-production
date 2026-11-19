'use client';

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { HelpTip } from '../../../components/ui/HelpTip';
import { CheckCircleIcon, InfoIcon, WarningCircleIcon } from '../../../components/ui/icons';
import { Spinner } from '../../../components/ui/Spinner';

// v32 COPY (E4/E5): a task's state on a Documents tab (an editable copy being made, ready, stopped; a list that could
// not be read) is one compact line, never a coloured banner: an icon of its tone, a short title, the details in a "?"
// beside it, and its buttons. Problems are announced (role="alert"), the rest politely (role="status").

export type StatusTone = 'busy' | 'info' | 'success' | 'warning' | 'error';

const ICONS: Record<StatusTone, ReactNode> = {
  busy: <Spinner size={16} />,
  info: <InfoIcon size={18} weight="fill" className="text-info" />,
  success: <CheckCircleIcon size={18} weight="fill" className="text-success" />,
  warning: <WarningCircleIcon size={18} weight="fill" className="text-warning" />,
  error: <WarningCircleIcon size={18} weight="fill" className="text-danger" />,
};

export function StatusLine({
  tone,
  title,
  details,
  actions,
  className,
  ...data
}: {
  tone: StatusTone;
  /** Short: "Editable copy ready". */
  title: ReactNode;
  /** The rest, in the "?" tooltip (and read by screen readers). */
  details?: ReactNode;
  /** Small buttons at the end (Open, Dismiss). */
  actions?: ReactNode;
  className?: string;
  [key: `data-${string}`]: string | undefined;
}) {
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      data-status-line={tone}
      className={clsx('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-5', className)}
      {...data}
    >
      <span className="flex shrink-0" aria-hidden="true">
        {ICONS[tone]}
      </span>
      <span className="min-w-0 font-medium text-foreground">{title}</span>
      {details ? <HelpTip label={typeof title === 'string' ? title : undefined}>{details}</HelpTip> : null}
      {actions ? <span className="flex flex-wrap items-center gap-1.5">{actions}</span> : null}
    </div>
  );
}
