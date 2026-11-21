'use client';

import { useQueries, useQueryClient, type InfiniteData, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import {
  ApplicationCountsSchema,
  ApplicationListResponseSchema,
  TRACKER_LIST_PAGE_SIZE,
  type ApplicationCounts,
  type ApplicationSummary,
  type BoardResponse,
  type ListResponse,
  type TrackerTab,
} from '@tailorit/shared';
import { SavedJobListSchema, type SavedJobItem, type SavedJobList } from '@tailorit/shared/prepare';
import type { ProfileChoice } from '@tailorit/shared/sharing';
import { api } from '@/lib/api';
import {
  SAVED_MARKERS_LIMIT,
  boardQueryKey,
  fetchBoard,
  profileKey,
  profileOfKey,
  trackerKeys,
  type ColumnLimits,
} from '../data';
import { filterKey, filterQuery, type FilterState } from '../state';
import type { TrackerProfile } from './scope';

// v33 SHARE-9 (PLAN-sharing.md §8 "The Tracker's All profiles view"): the All profiles view's reads, one per profile
// (client fan-out: apiFetch's per-call `profile`, "me" or the key), under the tracker's own keys with the profile
// appended (profileKey), so invalidateApplications and the optimistic moves reach them as they reach the single view's.
// Each profile keeps its own cursors: the board its per-lane "Load more" counts (ColumnLimits, as the single board),
// the list the number of rows asked for (its pages read again in one go, as the board's lanes are).

/** One profile's list pages, as React Query's infinite data (so patchCachedApplication patches it like the single list). */
export type ListPages = InfiniteData<ListResponse<ApplicationSummary>, string | undefined>;

/** The All profiles board's key of one profile: the single board's key with the profile appended. */
export function profileBoardKey(filters: FilterState, q: string, limits: ColumnLimits, profile: ProfileChoice): QueryKey {
  return profileKey(boardQueryKey(filters, q, limits), profile);
}

/** The All profiles list's key of one profile: the single list's key, the rows asked for, then the profile. */
export function profileListKey(tab: TrackerTab, filters: FilterState, q: string, wanted: number, profile: ProfileChoice): QueryKey {
  return profileKey([...trackerKeys.list(tab, filterKey(filters, q)), String(wanted)] as const, profile);
}

/**
 * One profile's list: its pages from the first, until `wanted` rows are read or there are no more (a "Load more" asks
 * for another page's worth; a refetch after a change keeps what was loaded).
 */
export async function fetchListPages(
  tab: TrackerTab,
  filters: FilterState,
  q: string,
  wanted: number,
  signal: AbortSignal | undefined,
  profile: ProfileChoice,
): Promise<ListPages> {
  const pages: Array<ListResponse<ApplicationSummary>> = [];
  const pageParams: Array<string | undefined> = [];
  let cursor: string | undefined;
  let read = 0;
  do {
    const page = await api.get<ListResponse<ApplicationSummary>>('/api/applications', {
      query: { ...filterQuery(filters, q), tab, cursor, limit: TRACKER_LIST_PAGE_SIZE },
      schema: ApplicationListResponseSchema,
      signal,
      profile,
    });
    pages.push(page);
    pageParams.push(cursor);
    read += page.items.length;
    cursor = page.nextCursor;
  } while (cursor && read < wanted);
  return { pages, pageParams };
}

// v33 SHARE-9 fix (review): a profile's previous answer while its next one loads (a "Load more", a search, a filter).
// useQueries makes a new observer whenever an entry's key changes (query-core 5's QueriesObserver matches observers by
// key), so placeholderData's own "previous" is always empty there: the key each profile's read last answered is kept
// here instead (per read of the view: useId), and its answer is read back from the cache (with any move made since).

/** The key each read's profile last answered, per query client: "<read> <profile>" -> the key. */
const lastAnswered = new WeakMap<QueryClient, Map<string, QueryKey>>();
const slotOf = (read: string, profile: ProfileChoice) => `${read} ${profile}`;

function answeredOf(client: QueryClient): Map<string, QueryKey> {
  let keys = lastAnswered.get(client);
  if (!keys) {
    keys = new Map();
    lastAnswered.set(client, keys);
  }
  return keys;
}

/** Forgets a read's answers (the view left). */
export function forgetAnswers(client: QueryClient, read: string): void {
  const keys = lastAnswered.get(client);
  if (!keys) return;
  for (const slot of [...keys.keys()]) if (slot.startsWith(`${read} `)) keys.delete(slot);
}

/** What `profile`'s read last answered (now in the cache), never another profile's; undefined before its first answer. */
function lastAnswerOf<T>(client: QueryClient, read: string, profile: ProfileChoice): T | undefined {
  const key = lastAnswered.get(client)?.get(slotOf(read, profile));
  return key && profileOfKey(key) === profile ? client.getQueryData<T>(key) : undefined;
}

/**
 * One profile's entry of a useQueries read: its key and read (`load`), the key noted once it answers, and that profile's last
 * answer while a new key loads (isPlaceholderData; the others' entries are untouched). `read` names the read (useId).
 */
export function profileQuery<T>(
  client: QueryClient,
  read: string,
  profile: ProfileChoice,
  queryKey: QueryKey,
  load: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
) {
  return {
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<T> => {
      const data = await load(signal);
      answeredOf(client).set(slotOf(read, profile), queryKey);
      return data;
    },
    placeholderData: (): T | undefined => lastAnswerOf<T>(client, read, profile),
    enabled,
    retry: false,
  };
}

/** The board's entries, one per profile (useProfileBoards; the tests drive them with query-core's QueriesObserver). */
export function profileBoardQueries(
  client: QueryClient,
  read: string,
  profiles: readonly TrackerProfile[],
  filters: FilterState,
  q: string,
  limits: Readonly<Record<string, ColumnLimits>>,
  enabled: boolean,
) {
  return profiles.map((profile) => {
    const mine = limits[profile.choice] ?? {};
    return profileQuery<BoardResponse>(
      client,
      read,
      profile.choice,
      profileBoardKey(filters, q, mine, profile.choice),
      (signal) => fetchBoard(filters, q, mine, signal, profile.choice),
      enabled,
    );
  });
}

/**
 * The list's entries of `tab`, one per profile (useProfileLists). A profile's last answer is kept per tab, as the single
 * list keeps its previous rows only for the same tab: the Archived tab never shows the Active rows while it reads.
 */
export function profileListQueries(
  client: QueryClient,
  read: string,
  profiles: readonly TrackerProfile[],
  tab: TrackerTab,
  filters: FilterState,
  q: string,
  wanted: Readonly<Record<string, number>>,
  enabled: boolean,
) {
  return profiles.map((profile) => {
    const rows = wanted[profile.choice] ?? TRACKER_LIST_PAGE_SIZE;
    return profileQuery<ListPages>(
      client,
      `${read} ${tab}`,
      profile.choice,
      profileListKey(tab, filters, q, rows, profile.choice),
      (signal) => fetchListPages(tab, filters, q, rows, signal, profile.choice),
      enabled,
    );
  });
}

/** A read's name for its answers (useId), forgotten when the view leaves. */
function useAnswersSlot(client: QueryClient): string {
  const read = useId();
  useEffect(() => () => forgetAnswers(client, read), [client, read]);
  return read;
}

/** One profile's read: its data, whether it is loading, failed or shows the last answer while the next loads. */
export interface ProfileRead<T> {
  profile: TrackerProfile;
  data: T | undefined;
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  refetch: () => void;
}

function readsOf<T>(
  profiles: readonly TrackerProfile[],
  results: ReadonlyArray<{ data: T | undefined; error: unknown; isError: boolean; isFetching: boolean; isPlaceholderData: boolean; refetch: () => unknown }>,
): Array<ProfileRead<T>> {
  return profiles.map((profile, index) => {
    const result = results[index];
    return {
      profile,
      data: result?.data,
      error: result?.error ?? null,
      isError: result?.isError ?? false,
      isFetching: result?.isFetching ?? false,
      isPlaceholderData: result?.isPlaceholderData ?? false,
      refetch: () => void result?.refetch(),
    };
  });
}

/** Every profile's board (its lanes' first pages, then what each lane's "Load more" asked for on that profile). */
export function useProfileBoards(
  profiles: readonly TrackerProfile[],
  filters: FilterState,
  q: string,
  limits: Readonly<Record<string, ColumnLimits>>,
  enabled: boolean,
): Array<ProfileRead<BoardResponse>> {
  const client = useQueryClient();
  const read = useAnswersSlot(client);
  const results = useQueries({ queries: profileBoardQueries(client, read, profiles, filters, q, limits, enabled) });
  return readsOf(profiles, results);
}

/** Every profile's list of `tab` (Active or Archived), each with the rows asked for so far. */
export function useProfileLists(
  profiles: readonly TrackerProfile[],
  tab: TrackerTab,
  filters: FilterState,
  q: string,
  wanted: Readonly<Record<string, number>>,
  enabled: boolean,
): Array<ProfileRead<ListPages>> {
  const client = useQueryClient();
  const read = useAnswersSlot(client);
  const results = useQueries({ queries: profileListQueries(client, read, profiles, tab, filters, q, wanted, enabled) });
  return readsOf(profiles, results);
}

/** Every profile's counts (Active and Archived): the tabs show their sum. */
export function useProfileCounts(profiles: readonly TrackerProfile[], enabled: boolean): Array<ProfileRead<ApplicationCounts>> {
  const results = useQueries({
    queries: profiles.map((profile) => ({
      queryKey: profileKey(trackerKeys.counts, profile.choice),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<ApplicationCounts>('/api/applications/counts', { schema: ApplicationCountsSchema, signal, profile: profile.choice }),
      enabled,
      retry: false,
    })),
  });
  return readsOf(profiles, results);
}

/**
 * The Saved cards' auto-apply markers of every profile whose Prepare & queue the person may see (as the single view's
 * useSavedMarkers; a profile without it, or an answer that fails, shows none: a queued card's Draft mark comes with the
 * card itself).
 */
export function useProfileMarkers(profiles: readonly TrackerProfile[], enabled: boolean): ReadonlyMap<string, SavedJobItem> {
  const results = useQueries({
    queries: profiles.map((profile) => ({
      queryKey: profileKey(trackerKeys.savedMarkers, profile.choice),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Array<[string, SavedJobItem]>> => {
        const list = await api.get<SavedJobList>('/api/auto-apply/saved', {
          query: { filter: 'all', limit: SAVED_MARKERS_LIMIT },
          schema: SavedJobListSchema,
          signal,
          profile: profile.choice,
        });
        return list.items.map((item) => [item.applicationId, item]);
      },
      enabled: enabled && profile.canSeePrepare,
      retry: false,
      staleTime: 15_000,
    })),
  });
  const markers = new Map<string, SavedJobItem>();
  for (const result of results) for (const [id, item] of result.data ?? []) markers.set(id, item);
  return markers;
}
