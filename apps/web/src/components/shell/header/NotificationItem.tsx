'use client';

import type { Notification, NotificationTone } from '@tailorit/shared/notifications';
import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { relativeTime } from '../../../lib/format';
import { IconButton } from '../../ui/IconButton';
import { CheckCircleIcon, CheckIcon, InfoIcon, WarningCircleIcon, XCircleIcon } from '../../ui/icons';
import { BELL_COPY, GROUP_LABEL } from './copy';
import { safeLink, TONE_MARK } from './view';

// v3.1 HEADER: one notification as the bell and the /notifications page list it (docs/design/v3.1/24-notifications-
// usage.md §8): the tone's mark, the title (the link to what it is about; opening it marks it read), the body, when,
// and for an unread one a dot and "Mark as read". An unread row sits on the denim wash and its title is bold; the
// words "Unread" go to screen readers.

const TONE_ICON: Record<NotificationTone, ReactNode> = {
  info: <InfoIcon size={16} weight="fill" />,
  success: <CheckCircleIcon size={16} weight="fill" />,
  warning: <WarningCircleIcon size={16} weight="fill" />,
  danger: <XCircleIcon size={16} weight="fill" />,
};

/** The tone's mark: a small soft tile with the tone's icon (decoration: the title says what happened). */
export function ToneMark({ tone }: { tone: NotificationTone }) {
  return (
    <span aria-hidden="true" className={clsx('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-control', TONE_MARK[tone])}>
      {TONE_ICON[tone]}
    </span>
  );
}

export interface NotificationItemProps {
  item: Notification;
  /** The clock (useNow), for "3 hours ago". */
  now: number;
  /** The title was followed (its link): the caller marks it read and closes what it must. */
  onOpen: (item: Notification) => void;
  onMarkRead: (item: Notification) => void;
  /** `bell`: two lines of body and the group's name beside the time; `page`: the whole body, the time alone. */
  variant?: 'bell' | 'page';
  className?: string;
}

/** One row (an `<li>`): the title is the row's link when the notification has one. */
export function NotificationItem({ item, now, onOpen, onMarkRead, variant = 'bell', className }: NotificationItemProps) {
  const unread = item.readAt === null;
  const link = safeLink(item.link);
  const title = (
    <>
      {unread && <span className="sr-only">{BELL_COPY.unread}: </span>}
      {item.title}
    </>
  );
  const titleClass = clsx('text-sm leading-5 text-foreground', unread ? 'font-semibold' : 'font-medium');
  return (
    <li
      data-notification={item.id}
      data-unread={unread ? '' : undefined}
      data-tone={item.tone}
      className={clsx(
        'relative flex items-start gap-3 px-4 py-3 transition-colors duration-150',
        unread ? 'bg-primary-50 hover:bg-primary-soft' : 'hover:bg-surface-low',
        className,
      )}
    >
      <ToneMark tone={item.tone} />
      <div className="min-w-0 flex-1">
        {link ? (
          <Link
            href={link}
            onClick={() => onOpen(item)}
            // The whole row opens it (the ::after covers the row); the mark button sits above it.
            className={clsx(titleClass, 'rounded-tag after:absolute after:inset-0 after:content-[""] hover:underline')}
          >
            {title}
          </Link>
        ) : (
          <p className={titleClass}>{title}</p>
        )}
        {item.body && (
          <p className={clsx('mt-0.5 text-[13px] leading-[18px] break-words text-muted-foreground', variant === 'bell' && 'line-clamp-2')}>
            {item.body}
          </p>
        )}
        <p className="mt-1 text-xs leading-4 text-muted-foreground">
          {variant === 'bell' && (
            <>
              {GROUP_LABEL[item.group]}
              <span aria-hidden="true"> · </span>
            </>
          )}
          <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString('en-US')}>
            {relativeTime(item.createdAt, now)}
          </time>
        </p>
      </div>
      {unread && (
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          <span aria-hidden="true" data-unread-dot="" className="size-2 rounded-full bg-primary" />
          <IconButton
            label={BELL_COPY.markReadOf(item.title)}
            tooltip={BELL_COPY.markRead}
            tooltipSide="left"
            icon={<CheckIcon size={16} />}
            size="sm"
            className="max-sm:size-11"
            onClick={() => onMarkRead(item)}
          />
        </div>
      )}
    </li>
  );
}
