'use client';

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { CheckCircleIcon, InfoIcon, WarningCircleIcon } from './icons';

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const TONES: Record<NoticeTone, string> = {
  info: 'border-info bg-info-soft text-info-ink',
  success: 'border-success bg-success-soft text-success-ink',
  warning: 'border-warning bg-warning-soft text-warning-ink',
  error: 'border-danger bg-danger-soft text-danger-ink',
};

const ICONS: Record<NoticeTone, ReactNode> = {
  info: <InfoIcon size={18} weight="fill" />,
  success: <CheckCircleIcon size={18} weight="fill" />,
  warning: <WarningCircleIcon size={18} weight="fill" />,
  error: <WarningCircleIcon size={18} weight="fill" />,
};

/**
 * An inline message block: the sign-in page's info/error lines, a form's failure. A soft tone with a 3 px bar of the
 * full tone on its leading edge. Errors and warnings are announced (role="alert"); info and success politely
 * (role="status").
 */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  /** A button or link at the end (e.g. "Try again"). */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      className={clsx('flex items-start gap-2.5 rounded-control border-l-[3px] px-3.5 py-3 text-sm leading-5', TONES[tone], className)}
    >
      <span className="mt-px flex shrink-0">{ICONS[tone]}</span>
      <div className="min-w-0 flex-1 break-words">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && 'mt-0.5')}>{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}
