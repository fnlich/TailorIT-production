'use client';

import type { SavedJobFilter, SavedJobItem } from '@tailorit/shared/prepare';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { autoApplyKeys, fetchPrepareFilters, fetchQueuePane, fetchSavedJobs } from './api';
import { pollInterval } from './copy';

// v2.0: the Auto-apply page's reads (React Query). The Queue pane decides the pace: every 3 s while anything is
// preparing or applying, every 30 s otherwise; the Saved pane follows it. refetchInterval pauses in a hidden tab
// (React Query's default), so a page left open in the background asks nothing.

/** The Queue pane (preparing, queue rows, usage), read again at its own pace. */
export function useQueuePane() {
  return useQuery({
    queryKey: autoApplyKeys.queue,
    queryFn: ({ signal }) => fetchQueuePane(signal),
    refetchInterval: (query) => pollInterval(query.state.data?.preparing, query.state.data?.items),
  });
}

/** The Saved pane's tab, page by page ("Load more"), read again every `interval` ms. */
export function useSavedJobs(filter: SavedJobFilter, interval: number) {
  const query = useInfiniteQuery({
    queryKey: autoApplyKeys.saved(filter),
    queryFn: ({ pageParam, signal }) => fetchSavedJobs(filter, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: interval,
    // Another tab keeps the rows shown until its own arrive.
    placeholderData: keepPreviousData,
  });
  const items = useMemo<SavedJobItem[] | null>(
    () => (query.data ? query.data.pages.flatMap((page) => page.items) : null),
    [query.data],
  );
  return { ...query, items };
}

/** The saved prepare filters, for the Filters button's count (none shown when they cannot be read). */
export function usePrepareFilters() {
  return useQuery({
    queryKey: autoApplyKeys.filters,
    queryFn: ({ signal }) => fetchPrepareFilters(signal),
    retry: false,
    staleTime: 60_000,
  });
}
