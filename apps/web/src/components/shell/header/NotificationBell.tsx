'use client';

import { BellIcon } from '@phosphor-icons/react/Bell';
import type { Notification } from '@tailorit/shared/notifications';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
// Relative, not '@/': the web tests draw these views.
import { useAuth } from '../../../lib/auth';
import { useNow } from '../../../lib/useNow';
import { Button, buttonClasses } from '../../ui/Button';
import { ArrowRightIcon, GearSixIcon } from '../../ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover';
import { Skeleton } from '../../ui/Skeleton';
import { Tooltip } from '../../ui/Tooltip';
import { useLatestNotifications, useListsFollowUnread, useMarkAllRead, useMarkRead, useHeaderSummary } from './api';
import { BELL_COPY } from './copy';
import { NotificationItem } from './NotificationItem';
import { useHeaderPreview } from './preview';
import { badgeText, bellLabel, unreadAnnouncement } from './view';

// v3.1 HEADER (D8; docs/design/v3.1/24-notifications-usage.md §8): the top bar's bell. Its count comes from the
// header's summary (read every 60 s while the page is shown); its popover lists the latest ten (read when it opens),
// with Mark all read, each one's Mark as read, See all and the settings. A polite live region says when new ones
// arrive. The count is in the button's name ("Notifications, 3 unread"), "99+" from the API's cap.

/** Where "See all" and the settings go. */
export const NOTIFICATIONS_HREF = '/notifications';
export const NOTIFICATION_SETTINGS_HREF = '/settings#notifications';

/** What the live region says: new unread ones since the last read (none on the first; none for a mark). */
function useArrivals(unread: number | undefined): string {
  const previous = useRef<number | undefined>(undefined);
  const [words, setWords] = useState('');
  useEffect(() => {
    if (unread === undefined) return;
    // Cleared when there is nothing new, so the same words said again later are a change the reader hears.
    setWords(unreadAnnouncement(previous.current, unread) ?? '');
    previous.current = unread;
  }, [unread]);
  return words;
}

export function NotificationBell() {
  const preview = useHeaderPreview();
  const { account } = useAuth();
  const summary = useHeaderSummary();
  const unread = summary.data?.unread;
  useListsFollowUnread(preview ? undefined : unread);
  const arrivals = useArrivals(unread);
  const [open, setOpen] = useState(false);
  if (!preview && !account) return null;
  const count = unread ?? 0;
  const badge = badgeText(count);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={bellLabel(count)}
          data-header-bell=""
          className={clsx(
            'relative inline-flex size-9 shrink-0 items-center justify-center rounded-control text-muted-foreground',
            'transition-colors duration-150 hover:bg-hover hover:text-foreground data-popup-open:bg-hover data-popup-open:text-foreground',
          )}
        >
          <BellIcon size={20} weight={badge ? 'fill' : 'regular'} aria-hidden="true" />
          {badge && (
            <span
              data-unread-badge=""
              className="num absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] leading-none text-on-primary ring-2 ring-surface"
            >
              {badge}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent align="end" padding="none" aria-label={BELL_COPY.title} className="w-[min(25rem,calc(100vw-1rem))]">
          {open && <BellPanel count={count} onClose={() => setOpen(false)} />}
        </PopoverContent>
      </Popover>
      {/* A polite live region (aria-live, not role="status"): v31 FIX-WEB, the editors' bar draws the bell too, and its own
          save status is the bar's one status. */}
      <span aria-live="polite" aria-atomic="true" data-header-arrivals="" className="sr-only">
        {arrivals}
      </span>
    </>
  );
}

/** The popover's inside: its heading row, the latest ten, the way to the page and the settings. */
function BellPanel({ count, onClose }: { count: number; onClose: () => void }) {
  const latest = useLatestNotifications(true);
  const markRead = useMarkRead();
  const { markAll, pending } = useMarkAllRead();
  const now = useNow();
  const open = (item: Notification) => {
    markRead(item);
    onClose();
  };
  return (
    <BellPanelView
      count={count}
      items={latest.items}
      pending={latest.isPending}
      failed={latest.isError}
      now={now}
      marking={pending}
      onRetry={latest.refetch}
      onOpenItem={open}
      onMarkRead={markRead}
      onMarkAll={markAll}
      onClose={onClose}
    />
  );
}

export interface BellPanelViewProps {
  count: number;
  items: Notification[] | undefined;
  pending: boolean;
  failed: boolean;
  now: number;
  marking: boolean;
  onRetry: () => void;
  onOpenItem: (item: Notification) => void;
  onMarkRead: (item: Notification) => void;
  onMarkAll: () => void;
  onClose: () => void;
}

/** The panel on given data (drawn statically by the tests). */
export function BellPanelView({ count, items, pending, failed, now, marking, onRetry, onOpenItem, onMarkRead, onMarkAll, onClose }: BellPanelViewProps) {
  const anyUnread = count > 0 || (items ?? []).some((item) => item.readAt === null);
  return (
    <div className="flex max-h-[min(36rem,calc(100dvh-5rem))] flex-col" data-bell-panel="">
      <div className="flex items-center justify-between gap-3 border-b border-divider-soft py-2 pr-2 pl-4">
        <h2 className="text-[15px] leading-5 font-semibold text-foreground">{BELL_COPY.title}</h2>
        <Button variant="ghost" size="sm" disabled={!anyUnread} loading={marking} onClick={onMarkAll} className="max-sm:min-h-11">
          {BELL_COPY.markAll}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failed ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">{BELL_COPY.loadFailed}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              {BELL_COPY.tryAgain}
            </Button>
          </div>
        ) : pending || !items ? (
          <div className="flex flex-col gap-4 px-4 py-4" aria-busy="true">
            <span className="sr-only">{BELL_COPY.loading}</span>
            {[0, 1, 2].map((index) => (
              <div key={index} aria-hidden="true" className="flex items-start gap-3">
                <Skeleton className="size-7" rounded="control" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 py-10 text-center" data-bell-empty="">
            <p className="font-display text-base leading-6 font-semibold text-foreground">{BELL_COPY.empty}</p>
            <p className="text-[13px] leading-5 text-muted-foreground">{BELL_COPY.emptyHint}</p>
          </div>
        ) : (
          <ul aria-label={BELL_COPY.title} className="divide-y divide-divider-soft">
            {items.map((item) => (
              <NotificationItem key={item.id} item={item} now={now} onOpen={onOpenItem} onMarkRead={onMarkRead} />
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-divider-soft bg-surface-low py-1.5 pr-1.5 pl-2 rounded-b-popup">
        <Link
          href={NOTIFICATIONS_HREF}
          onClick={onClose}
          className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'text-primary max-sm:min-h-11' })}
        >
          {BELL_COPY.seeAll}
          <ArrowRightIcon size={14} aria-hidden="true" />
        </Link>
        <Tooltip content={BELL_COPY.settings} side="left">
          <Link
            href={NOTIFICATION_SETTINGS_HREF}
            onClick={onClose}
            aria-label={BELL_COPY.settings}
            data-bell-settings=""
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors duration-150 hover:bg-hover hover:text-foreground max-sm:size-11"
          >
            <GearSixIcon size={18} aria-hidden="true" />
          </Link>
        </Tooltip>
      </div>
    </div>
  );
}
