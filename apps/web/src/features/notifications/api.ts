'use client';

import {
  NotificationPrefsSchema,
  type Notification,
  type NotificationGroup,
  type NotificationList,
  type NotificationPref,
  type NotificationPrefs,
} from '@tailorit/shared/notifications';
import { useInfiniteQuery } from '@tanstack/react-query';
// Relative, not '@/': the web tests read these.
import { fetchNotifications, NOTIFICATIONS_QUERY_KEY } from '../../components/shell/header/api';
import { apiFetch } from '../../lib/api';

// v3.1 HEADER (docs/design/v3.1/24-notifications-usage.md §5, §8): the /notifications page's list and Settings ›
// Notification settings' switches, on NOTIFY's routes. The page's lists live under NOTIFICATIONS_QUERY_KEY, so the
// bell's marks change them too.

/** GET /api/notifications/prefs (outside NOTIFICATIONS_QUERY_KEY: the lists' updates never touch it). */
export const PREFS_QUERY_KEY = ['notification-prefs'] as const;
/** The page reads this many at a time. */
export const PAGE_SIZE = 20;

export type NotificationFilter = 'all' | 'unread';

export const pageQueryKey = (filter: NotificationFilter) => [...NOTIFICATIONS_QUERY_KEY, 'page', filter] as const;

/** The page's list, newest first, a page of PAGE_SIZE at a time ("Show more" reads the next). */
export function useNotificationPages(filter: NotificationFilter) {
  return useInfiniteQuery({
    queryKey: pageQueryKey(filter),
    queryFn: ({ pageParam, signal }) => fetchNotifications({ cursor: pageParam, unread: filter === 'unread', limit: PAGE_SIZE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: NotificationList) => last.nextCursor,
    staleTime: 0,
  });
}

export function fetchNotificationPrefs(signal?: AbortSignal): Promise<NotificationPrefs> {
  return apiFetch<NotificationPrefs>('/api/notifications/prefs', { schema: NotificationPrefsSchema, signal });
}

/** PUT /api/notifications/prefs: changes the named groups only. */
export function saveNotificationPref(pref: NotificationPref): Promise<NotificationPrefs> {
  return apiFetch<NotificationPrefs>('/api/notifications/prefs', {
    method: 'PUT',
    body: { groups: [pref] },
    schema: NotificationPrefsSchema,
  });
}

/** `prefs` with `group` switched (the switch shows the change at once; the server's answer follows). */
export function withPref(prefs: NotificationPrefs, group: NotificationGroup, enabled: boolean): NotificationPrefs {
  return { groups: prefs.groups.map((pref) => (pref.group === group ? { group, enabled } : pref)) };
}

export interface NotificationGroupBlock {
  group: Notification['group'];
  items: Notification[];
}

/**
 * The page's blocks: one per group, in the order of each group's newest notification (the freshest first), each
 * newest first, as the list came.
 */
export function groupNotifications(items: readonly Notification[]): NotificationGroupBlock[] {
  const blocks = new Map<Notification['group'], Notification[]>();
  for (const item of items) {
    const block = blocks.get(item.group);
    if (block) block.push(item);
    else blocks.set(item.group, [item]);
  }
  return [...blocks].map(([group, list]) => ({ group, items: list }));
}
