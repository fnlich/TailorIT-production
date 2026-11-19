'use client';

import { IsoDateTime } from '@tailorit/shared/core';
import {
  HeaderSummarySchema,
  NotificationListSchema,
  NotificationReadAllSchema,
  type Notification,
  type NotificationList,
  type NotificationReadAll,
} from '@tailorit/shared/notifications';
import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { z } from 'zod';
// Relative, not '@/': the web tests read these.
import { api, apiFetch } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useToast } from '../../ui/Toast';
import { BELL_COPY } from './copy';
import { browserPollHost, HEADER_FOCUS_GAP_MS, startVisiblePoll } from './poll';
import { useHeaderPreview } from './preview';
import { allRead, markedRead } from './view';

// v3.1 HEADER (D8, D9; docs/design/v3.1/24-notifications-usage.md §5, §6, §8): the header's reads and the marks, on
// NOTIFY's routes. Every list of notifications in the cache lives under NOTIFICATIONS_QUERY_KEY (the bell's latest
// ten, the /notifications page's lists), so a mark updates them all at once.

/** GET /api/me/header. */
export const HEADER_QUERY_KEY = ['me', 'header'] as const;
/** Every list of notifications (the bell's, the page's). */
export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const;
/** The bell's latest notifications. */
export const LATEST_QUERY_KEY = ['notifications', 'latest'] as const;
/** The bell lists this many. */
export const BELL_LIMIT = 10;

/**
 * v32 SHELL (E7): GET /api/me/header as the web reads it, from either API: v3.2 sends `ai.percent` (today's share of the
 * daily limit, 0-100; null with no daily limit) and leaves the money out for anyone but an administrator; v3.1 sent the
 * micros only. The chip reads `percent` when it is there, else works it out from the micros (view.ts aiPercent).
 */
export const HeaderSummaryReadSchema = HeaderSummarySchema.extend({
  ai: z.object({
    percent: z.number().int().min(0).max(100).nullable().optional(),
    usedMicros: z.number().int().nonnegative().optional(),
    budgetMicros: z.number().int().nonnegative().nullable().optional(),
    resetsAt: IsoDateTime,
  }),
});
/** The header's summary as the slots read it (HeaderSummaryReadSchema). */
export type HeaderSummaryRead = z.infer<typeof HeaderSummaryReadSchema>;

export function fetchHeaderSummary(signal?: AbortSignal): Promise<HeaderSummaryRead> {
  return apiFetch<HeaderSummaryRead>('/api/me/header', { schema: HeaderSummaryReadSchema, signal });
}

export interface NotificationsQuery {
  cursor?: string | null;
  unread?: boolean;
  limit?: number;
}

/** GET /api/notifications (newest first; `unread` lists only unread ones). */
export function fetchNotifications({ cursor, unread, limit }: NotificationsQuery, signal?: AbortSignal): Promise<NotificationList> {
  return apiFetch<NotificationList>('/api/notifications', {
    query: { cursor: cursor ?? undefined, unread: unread ? '1' : undefined, limit },
    schema: NotificationListSchema,
    signal,
  });
}

/** POST /api/notifications/:id/read (204; already read stays as it was). */
export function markNotificationRead(id: string): Promise<void> {
  return api.post<void>(`/api/notifications/${encodeURIComponent(id)}/read`);
}

/** POST /api/notifications/read-all. */
export function markAllNotificationsRead(): Promise<NotificationReadAll> {
  return api.post<NotificationReadAll>('/api/notifications/read-all', undefined, { schema: NotificationReadAllSchema });
}

// The header's reads drive one poll per tab (both slots ask for it; the first starts it, the last stops it).
let pollUsers = 0;
let stopPoll: (() => void) | null = null;

function useHeaderPoll(enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return undefined;
    pollUsers += 1;
    if (pollUsers === 1) {
      stopPoll = startVisiblePoll({
        refresh: () => void queryClient.invalidateQueries({ queryKey: HEADER_QUERY_KEY }),
        host: browserPollHost(),
      });
    }
    return () => {
      pollUsers -= 1;
      if (pollUsers === 0) {
        stopPoll?.();
        stopPoll = null;
      }
    };
  }, [enabled, queryClient]);
}

/**
 * The header's summary: read once the account is known, then every 60 s while the page is shown and when it comes
 * back (poll.ts); never in a hidden tab. A preview (HeaderPreview) answers its own data and reads nothing.
 */
export function useHeaderSummary(): { data: HeaderSummaryRead | undefined; isError: boolean } {
  const preview = useHeaderPreview();
  const { account } = useAuth();
  const live = !preview && account !== null;
  const query = useQuery({
    queryKey: HEADER_QUERY_KEY,
    queryFn: ({ signal }) => fetchHeaderSummary(signal),
    enabled: live,
    staleTime: HEADER_FOCUS_GAP_MS,
    refetchOnWindowFocus: false,
  });
  useHeaderPoll(live);
  if (preview) return { data: preview.summary, isError: false };
  return { data: query.data, isError: query.isError && query.data === undefined };
}

/**
 * More unread found by a read of the header: the open bell and the /notifications page list the new ones at once. A
 * smaller count comes from a mark, which updates the lists itself. (The bell calls it: it is on every app page.)
 */
export function useListsFollowUnread(unread: number | undefined): void {
  const queryClient = useQueryClient();
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (unread === undefined) return;
    if (seen.current !== undefined && unread > seen.current) void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
    seen.current = unread;
  }, [unread, queryClient]);
}

/** The bell's latest ten, read while its popover is open (and again whenever the unread count moves). */
export function useLatestNotifications(open: boolean) {
  const preview = useHeaderPreview();
  const { account } = useAuth();
  const query = useQuery({
    queryKey: LATEST_QUERY_KEY,
    queryFn: ({ signal }) => fetchNotifications({ limit: BELL_LIMIT }, signal),
    enabled: open && !preview && account !== null,
    staleTime: 0,
  });
  if (preview) {
    return {
      items: preview.notifications.slice(0, BELL_LIMIT),
      isPending: false,
      isError: false,
      refetch: () => undefined,
    };
  }
  return {
    items: query.data?.items,
    isPending: query.isPending,
    isError: query.isError && query.data === undefined,
    refetch: () => void query.refetch(),
  };
}

type CachedList = NotificationList | InfiniteData<NotificationList, unknown> | undefined;

/** Applies `change` to every list of notifications in the cache, whatever its shape (one page, or pages). */
function updateLists(queryClient: QueryClient, change: (items: Notification[]) => Notification[], unread: (count: number) => number) {
  queryClient.setQueriesData<CachedList>({ queryKey: NOTIFICATIONS_QUERY_KEY }, (old) => {
    if (!old) return old;
    if ('pages' in old) return { ...old, pages: old.pages.map((page) => ({ ...page, items: change(page.items), unread: unread(page.unread) })) };
    if ('items' in old) return { ...old, items: change(old.items), unread: unread(old.unread) };
    return old;
  });
}

function settle(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: HEADER_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
}

/**
 * Marks one notification read: the badge and every list change at once, then the server's word is read again. A
 * preview marks its own data.
 */
export function useMarkRead(): (item: Notification) => void {
  const preview = useHeaderPreview();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onMutate: async (id) => {
      // A read already on its way would answer the row as unread again.
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      const at = new Date().toISOString();
      queryClient.setQueryData<HeaderSummaryRead>(HEADER_QUERY_KEY, (old) => (old ? { ...old, unread: Math.max(0, old.unread - 1) } : old));
      updateLists(queryClient, (items) => markedRead(items, id, at), (count) => Math.max(0, count - 1));
    },
    onError: () => toast.error(BELL_COPY.markFailed),
    onSettled: () => settle(queryClient),
  });
  return (item) => {
    if (item.readAt !== null) return;
    if (preview) preview.markRead(item.id);
    else mutation.mutate(item.id);
  };
}

/** Marks every notification read (the bell's and the page's Mark all read). */
export function useMarkAllRead(): { markAll: () => void; pending: boolean } {
  const preview = useHeaderPreview();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      const at = new Date().toISOString();
      queryClient.setQueryData<HeaderSummaryRead>(HEADER_QUERY_KEY, (old) => (old ? { ...old, unread: 0 } : old));
      updateLists(queryClient, (items) => allRead(items, at), () => 0);
    },
    onError: () => toast.error(BELL_COPY.markFailed),
    onSettled: () => settle(queryClient),
  });
  return {
    markAll: () => (preview ? preview.markAllRead() : mutation.mutate()),
    pending: mutation.isPending,
  };
}
