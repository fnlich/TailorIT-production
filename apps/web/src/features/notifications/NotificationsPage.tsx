'use client';

import { BellIcon } from '@phosphor-icons/react/Bell';
import type { Notification } from '@tailorit/shared/notifications';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useId, useState } from 'react';
// Relative, not '@/': the web tests draw these views.
import { useHeaderSummary, useMarkAllRead, useMarkRead } from '../../components/shell/header/api';
import { GROUP_LABEL } from '../../components/shell/header/copy';
import { NotificationItem } from '../../components/shell/header/NotificationItem';
import { NOTIFICATION_SETTINGS_HREF } from '../../components/shell/header/NotificationBell';
import { badgeText } from '../../components/shell/header/view';
import { PAGE_GUTTER } from '../../components/shell/layout';
import { Button, buttonClasses } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { CheckIcon, GearSixIcon } from '../../components/ui/icons';
import { Notice } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Skeleton } from '../../components/ui/Skeleton';
import { userMessage } from '../../lib/api';
import { useNow } from '../../lib/useNow';
import { groupNotifications, useNotificationPages, type NotificationFilter } from './api';
import { PAGE_COPY } from './copy';

// v3.1 HEADER (D8; docs/design/v3.1/24-notifications-usage.md §8): /notifications, every notification kept (90 days),
// newest first, under its group's heading (the group of the freshest first), All or Unread; Mark all read; each row
// opens what it is about (and is then read) or is marked read where it stands; Show more reads the next page. The
// bell's "See all" comes here.

export function NotificationsPage() {
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const pages = useNotificationPages(filter);
  const summary = useHeaderSummary();
  const { markAll, pending: marking } = useMarkAllRead();
  const markRead = useMarkRead();
  const now = useNow();
  const unread = summary.data?.unread ?? 0;
  const unreadBadge = badgeText(unread);
  const items = pages.data?.pages.flatMap((page) => page.items);

  return (
    <div className={clsx('mx-auto w-full max-w-[880px] pt-7 pb-20', PAGE_GUTTER)}>
      <PageHeader
        title={PAGE_COPY.title}
        description={PAGE_COPY.description}
        actions={
          <>
            <Link href={NOTIFICATION_SETTINGS_HREF} className={buttonClasses({ variant: 'ghost', className: 'max-sm:min-h-11' })}>
              <GearSixIcon size={16} aria-hidden="true" />
              {PAGE_COPY.settings}
            </Link>
            <Button
              variant="outline"
              icon={<CheckIcon size={16} />}
              disabled={unread === 0}
              loading={marking}
              onClick={markAll}
              className="max-sm:min-h-11"
            >
              {PAGE_COPY.markAll}
            </Button>
          </>
        }
      />
      <SegmentedControl
        aria-label={PAGE_COPY.filterLabel}
        className="mt-6"
        listClassName="max-sm:h-11"
        value={filter}
        onValueChange={setFilter}
        items={[
          { value: 'all', label: PAGE_COPY.all },
          { value: 'unread', label: unreadBadge ? PAGE_COPY.unreadCount(unreadBadge) : PAGE_COPY.unread },
        ]}
      />
      <div className="mt-4" data-notifications-list={filter}>
        {pages.isError && !items ? (
          <Notice
            tone="error"
            title={PAGE_COPY.loadFailed}
            action={
              <Button variant="outline" size="sm" onClick={() => void pages.refetch()}>
                {PAGE_COPY.tryAgain}
              </Button>
            }
          >
            {userMessage(pages.error, PAGE_COPY.loadFailedHint)}
          </Notice>
        ) : !items ? (
          <ListSkeleton />
        ) : items.length === 0 ? (
          <Card padding="none">
            {filter === 'unread' ? (
              <EmptyState
                icon={<CheckIcon size={24} />}
                title={PAGE_COPY.emptyUnread}
                description={PAGE_COPY.emptyUnreadHint}
                action={
                  <Button variant="outline" onClick={() => setFilter('all')}>
                    {PAGE_COPY.showAll}
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={<BellIcon size={24} />} title={PAGE_COPY.emptyAll} description={PAGE_COPY.emptyAllHint} />
            )}
          </Card>
        ) : (
          <NotificationGroups items={items} now={now} onOpen={markRead} onMarkRead={markRead} />
        )}
        {pages.hasNextPage && (
          <div className="mt-6 flex justify-center">
            <Button variant="outline" loading={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()} className="max-sm:min-h-11">
              {PAGE_COPY.more}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The list under its groups' headings (drawn statically by the tests). */
export function NotificationGroups({
  items,
  now,
  onOpen,
  onMarkRead,
}: {
  items: readonly Notification[];
  now: number;
  onOpen: (item: Notification) => void;
  onMarkRead: (item: Notification) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {groupNotifications(items).map((block) => (
        <GroupBlock key={block.group} group={block.group} items={block.items} now={now} onOpen={onOpen} onMarkRead={onMarkRead} />
      ))}
    </div>
  );
}

function GroupBlock({
  group,
  items,
  now,
  onOpen,
  onMarkRead,
}: {
  group: Notification['group'];
  items: Notification[];
  now: number;
  onOpen: (item: Notification) => void;
  onMarkRead: (item: Notification) => void;
}) {
  const headingId = useId();
  return (
    <div data-notification-group={group}>
      <h2 id={headingId} className="mb-2 px-1 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
        {GROUP_LABEL[group]}
      </h2>
      <Card padding="none" className="overflow-hidden">
        <ul aria-labelledby={headingId} className="divide-y divide-divider-soft">
          {items.map((item) => (
            <NotificationItem key={item.id} item={item} now={now} onOpen={onOpen} onMarkRead={onMarkRead} variant="page" />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ListSkeleton() {
  return (
    <Card padding="none" aria-busy="true">
      <span className="sr-only">{PAGE_COPY.loading}</span>
      <div aria-hidden="true" className="flex flex-col divide-y divide-divider-soft">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex items-start gap-3 px-4 py-3">
            <Skeleton className="size-7" rounded="control" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
