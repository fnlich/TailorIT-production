'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  ApplicationCountsSchema,
  ApplicationDetailSchema,
  ApplicationListResponseSchema,
  ApplicationQuestionSchema,
  BOARD_PAGE_SIZE,
  BoardResponseSchema,
  BulkApplicationsResponseSchema,
  ArchiveAllResponseSchema,
  ApplyRecordListSchema,
  InsightsResponseSchema,
  MatchResultSchema,
  SankeyResponseSchema,
  StatusChangeResponseSchema,
  SubmittedAnswersResponseSchema,
  TRACKER_LIST_PAGE_SIZE,
  TrackerImportResponseSchema,
  toIsoDate,
  type ApplicationCounts,
  type ApplicationDetail,
  type ApplicationQuestion,
  type ApplicationStatus,
  type ApplicationSummary,
  type ApplyRecordList,
  type BoardResponse,
  type BulkApplicationsBody,
  type CreateApplicationBody,
  type InsightsResponse,
  type ListResponse,
  type MatchResult,
  type PatchApplicationBody,
  type SankeyResponse,
  type StatusChangeResponse,
  type SubmittedAnswersResponse,
  type TrackerImportBody,
  type TrackerImportResponse,
  type TrackerTab,
} from '@tailorit/shared';
import { SavedJobListSchema, type SavedJobItem, type SavedJobList } from '@tailorit/shared/prepare';
import type { ProfileChoice } from '@tailorit/shared/sharing';
import { useState } from 'react';
import { z } from 'zod';
import { api, isApiError } from '@/lib/api';
import { createMatchPendingPoll, readResumeMatches, type ResumeMatchView } from './detail/resumeMatches';
import { filterKey, filterQuery, type FilterState } from './state';

/*
 * Everything the tracker reads and writes through /api/applications, as React Query hooks. All keys start with
 * 'tracker'; a change to applications invalidates the application reads (board, list, counts, chart, detail).
 *
 * v33 SHARE-9 (PLAN F9; SP v33 PLAN-sharing.md §8 "The Tracker's All profiles view"): the All profiles view reads each
 * profile with its own `profile` (apiFetch's per-call choice: "me" or a shared profile's key) under the same keys with
 * the profile appended (`['tracker', 'board', key, limits, {p}]`, profileKey), so prefix invalidation
 * (invalidateApplications) and the optimistic moves (moveOnBoards, patchCachedApplication: application ids are unique
 * across profiles) reach every profile's cache at once. The writes take the card's profile the same way.
 */

export const trackerKeys = {
  all: ['tracker'] as const,
  counts: ['tracker', 'counts'] as const,
  board: (key: string, limits: string) => ['tracker', 'board', key, limits] as const,
  boards: ['tracker', 'board'] as const,
  list: (tab: TrackerTab, key: string) => ['tracker', 'list', tab, key] as const,
  lists: ['tracker', 'list'] as const,
  detail: (id: string) => ['tracker', 'app', id] as const,
  details: ['tracker', 'app'] as const,
  sankey: ['tracker', 'sankey'] as const,
  insights: ['tracker', 'insights'] as const,
  score: (id: string) => ['tracker', 'score', id] as const,
  scores: ['tracker', 'score'] as const,
  companies: ['tracker', 'companies'] as const,
  resumes: ['tracker', 'resumes'] as const,
  /** How the account's resumes rank for each application (the Documents tab's picker). */
  resumeMatches: ['tracker', 'resume-matches'] as const,
  resumeMatchesFor: (id: string) => ['tracker', 'resume-matches', id] as const,
  letters: ['tracker', 'letters'] as const,
  lettersFor: (id: string) => ['tracker', 'letters-for', id] as const,
  // v1.3 A: the answers submitted through the extension (the "Submitted answers" tab).
  submitted: (id: string) => ['tracker', 'submitted', id] as const,
  // v20 A30: what each application was sent with ("Applied with"), and the Saved entries' auto-apply markers.
  applyRecords: (id: string) => ['tracker', 'apply-records', id] as const,
  applyRecordsAll: ['tracker', 'apply-records'] as const,
  savedMarkers: ['tracker', 'saved-markers'] as const,
};

/**
 * v33 SHARE-9: a key of the All profiles view: `key` with the profile appended (`{p: 'me' | <key>}`), so every prefix
 * of trackerKeys still matches it. The single-profile view's keys name none (its document's profile is fixed: a
 * switch loads a new document with an empty cache).
 */
export function profileKey<K extends readonly unknown[]>(key: K, profile: ProfileChoice): readonly [...K, { p: ProfileChoice }] {
  return [...key, { p: profile }] as const;
}

/** v33 SHARE-9: the profile a key of the All profiles view names (its last part), or null for a single-profile key. */
export function profileOfKey(key: readonly unknown[]): ProfileChoice | null {
  const last = key[key.length - 1];
  return last && typeof last === 'object' && 'p' in last ? ((last as { p: ProfileChoice }).p ?? null) : null;
}

/** The Jobs page's insights: their keyword card scores the resume linked to a tracked job. */
const JOBS_INSIGHTS_KEY = ['jobs', 'insights'] as const;

/** Status moves share a key, so overlapping ones settle together (see useMoveStatus). */
const MOVE_KEY = ['tracker', 'move'] as const;

/** The browser's calendar day: status dates are the person's own day, not the server's. */
export function localToday(): string {
  return toIsoDate(new Date()) ?? new Date().toISOString().slice(0, 10);
}

/** Refetches everything that shows applications (not the resume or letter pickers). */
export function invalidateApplications(client: QueryClient): Promise<void> {
  const keys = [
    trackerKeys.counts,
    trackerKeys.boards,
    trackerKeys.lists,
    trackerKeys.details,
    trackerKeys.sankey,
    trackerKeys.insights,
    trackerKeys.scores,
    trackerKeys.companies,
    trackerKeys.applyRecordsAll,
    trackerKeys.savedMarkers,
    // v34 FANWEB fix (spec L1): the Jobs page's "Saved on" follows the Job Tracker's own changes (archive, delete, move).
    ['jobs', 'saved-on'] as const,
  ];
  return Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey }))).then(() => undefined);
}

/**
 * What an application's resume changing affects beyond the application: its ranking (which says who chose), its
 * Resume Score, and the Jobs page's keyword card for its job. Rankings are invalidated only here (a link changed) and
 * by a change to the resumes themselves (`invalidateResumes`), never by moves or archiving: each read scores every
 * resume of the account.
 */
export function invalidateResumeChoice(client: QueryClient, id: string): Promise<void> {
  const keys = [trackerKeys.resumeMatchesFor(id), trackerKeys.scores, JOBS_INSIGHTS_KEY];
  return Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey }))).then(() => undefined);
}

// ----------------------------------------------------------------------------------------------------- reads

export function useCounts() {
  return useQuery({
    queryKey: trackerKeys.counts,
    queryFn: ({ signal }) => api.get<ApplicationCounts>('/api/applications/counts', { schema: ApplicationCountsSchema, signal }),
  });
}

/** "Load more" per column (v33 TRACKER: the stored statuses' columns only; there is no Draft column). */
export type ColumnLimits = Partial<Record<ApplicationStatus, number>>;

/**
 * The board: every column's first page, then more pages for columns where "Load more applications" asked for them
 * (`limits`), so a refetch after a change keeps what was loaded.
 */
export async function fetchBoard(
  filters: FilterState,
  q: string,
  limits: ColumnLimits,
  signal: AbortSignal,
  // v33 SHARE-9: the All profiles view reads each profile on its own (left out: the document's profile).
  profile?: ProfileChoice,
): Promise<BoardResponse> {
  const query = filterQuery(filters, q);
  const board = await api.get<BoardResponse>('/api/applications/board', {
    query: { ...query, limit: BOARD_PAGE_SIZE },
    schema: BoardResponseSchema,
    signal,
    profile,
  });
  const columns = await Promise.all(
    board.columns.map(async (column) => {
      const wanted = limits[column.status] ?? BOARD_PAGE_SIZE;
      let { items, nextCursor } = column;
      while (nextCursor && items.length < wanted) {
        const page = await api.get<BoardResponse>('/api/applications/board', {
          query: { ...query, status: column.status, cursor: nextCursor, limit: Math.min(100, wanted - items.length) },
          schema: BoardResponseSchema,
          signal,
          profile,
        });
        const more = page.columns[0];
        if (!more) break;
        items = [...items, ...more.items];
        nextCursor = more.nextCursor;
      }
      return { ...column, items, nextCursor };
    }),
  );
  return { columns };
}

export function boardQueryKey(filters: FilterState, q: string, limits: ColumnLimits) {
  return trackerKeys.board(filterKey(filters, q), JSON.stringify(limits));
}

export function useBoard(filters: FilterState, q: string, limits: ColumnLimits, enabled: boolean) {
  return useQuery({
    queryKey: boardQueryKey(filters, q, limits),
    queryFn: ({ signal }) => fetchBoard(filters, q, limits, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useApplicationList(tab: TrackerTab, filters: FilterState, q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: trackerKeys.list(tab, filterKey(filters, q)),
    queryFn: ({ pageParam, signal }) =>
      api.get<ListResponse<ApplicationSummary>>('/api/applications', {
        query: { ...filterQuery(filters, q), tab, cursor: pageParam, limit: TRACKER_LIST_PAGE_SIZE },
        schema: ApplicationListResponseSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    // Keep showing the rows while a search or filter reloads, but never the other tab's rows.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === tab ? previous : undefined),
    enabled,
  });
}

/**
 * One application's detail. `enabled` is false while its sheet is closed (the data stays for the exit animation).
 * While TailorIT is still choosing the resume of a saved job (`resumeMatchPending`) it is read again every few seconds,
 * for up to a minute, so the choice shows once the match worker links it; then what scores the linked resume (the
 * Resume Score, the Jobs card) is marked stale.
 */
export function useApplication(id: string | null, enabled = true) {
  const client = useQueryClient();
  const [poll] = useState(createMatchPendingPoll);
  return useQuery({
    queryKey: trackerKeys.detail(id ?? ''),
    queryFn: async ({ signal }) => {
      const before = client.getQueryData<ApplicationDetail>(trackerKeys.detail(id!));
      const detail = await api.get<ApplicationDetail>(`/api/applications/${encodeURIComponent(id!)}`, {
        schema: ApplicationDetailSchema,
        signal,
      });
      if (before?.resumeMatchPending && before.resumeId !== detail.resumeId) {
        for (const queryKey of [trackerKeys.score(detail.id), JOBS_INSIGHTS_KEY]) void client.invalidateQueries({ queryKey });
      }
      return detail;
    },
    enabled: enabled && Boolean(id),
    refetchInterval: (query) => poll.next(id ?? '', query.state.data?.resumeMatchPending === true, Date.now()),
  });
}

export function useSankey(enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.sankey,
    queryFn: ({ signal }) => api.get<SankeyResponse>('/api/applications/sankey', { schema: SankeyResponseSchema, signal }),
    enabled,
  });
}

export function useInsights(enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.insights,
    queryFn: ({ signal }) => api.get<InsightsResponse>('/api/applications/insights', { schema: InsightsResponseSchema, signal }),
    enabled,
  });
}

// v1.3 A
/** The "Submitted answers" tab: the form's questions and the answers the person submitted through the extension. */
export function useSubmittedAnswers(id: string, enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.submitted(id),
    queryFn: ({ signal }) =>
      api.get<SubmittedAnswersResponse>(`/api/applications/${encodeURIComponent(id)}/submitted-answers`, {
        schema: SubmittedAnswersResponseSchema,
        signal,
      }),
    enabled,
  });
}
// end v1.3 A

// v20 A30
/**
 * The application's apply records, newest first ("Applied with": the resume, the letter and the answers each
 * application was sent with). An API that does not serve them yet (404) answers none.
 */
export function useApplyRecords(id: string, enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.applyRecords(id),
    queryFn: async ({ signal }): Promise<ApplyRecordList> => {
      try {
        return await api.get<ApplyRecordList>(`/api/applications/${encodeURIComponent(id)}/apply-records`, {
          schema: ApplyRecordListSchema,
          signal,
        });
      } catch (error) {
        if (isApiError(error) && error.status === 404) return { items: [] };
        throw error;
      }
    },
    enabled,
    retry: false,
  });
}

/** How many Saved entries' markers the board reads (the newest saved first, as the Saved column lists them). */
export const SAVED_MARKERS_LIMIT = 100;

/**
 * The Saved entries' auto-apply markers (Preparing, Filtered, Preparation failed, …), the Saved pane's, for the
 * board's Saved cards (08-ui.md: "the card shows the Saved pane's marker"). Off when the API cannot answer.
 */
export function useSavedMarkers(enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.savedMarkers,
    queryFn: async ({ signal }): Promise<ReadonlyMap<string, SavedJobItem>> => {
      try {
        const list = await api.get<SavedJobList>('/api/auto-apply/saved', {
          query: { filter: 'all', limit: SAVED_MARKERS_LIMIT },
          schema: SavedJobListSchema,
          signal,
        });
        return new Map(list.items.map((item) => [item.applicationId, item] as const));
      } catch (error) {
        if (isApiError(error) && error.status === 404) return new Map();
        throw error;
      }
    },
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}
// end v20 A30

export function useResumeScore(id: string, enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.score(id),
    queryFn: ({ signal }) =>
      api.get<MatchResult>(`/api/applications/${encodeURIComponent(id)}/resume-score`, { schema: MatchResultSchema, signal }),
    enabled,
  });
}

/** How long a ranking stays fresh: each read scores every resume of the account (see invalidateResumeChoice). */
export const RESUME_MATCHES_STALE_MS = 30_000;

/** How the account's resumes rank for one application, best first; null when the server has none for it (404). */
export async function fetchResumeMatches(id: string, signal?: AbortSignal): Promise<ResumeMatchView | null> {
  try {
    return readResumeMatches(await api.get(`/api/applications/${encodeURIComponent(id)}/resume-matches`, { signal }));
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
}

/**
 * The Documents tab's ranked resume picker. No ranking (null, or a failure) sends the picker back to the plain list
 * (`useResumeOptions`); it is not retried, so that list comes at once.
 */
export function useResumeMatches(id: string, enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.resumeMatchesFor(id),
    queryFn: ({ signal }) => fetchResumeMatches(id, signal),
    enabled,
    retry: false,
    staleTime: RESUME_MATCHES_STALE_MS,
  });
}

/** Company suggestions: the account's companies and the job board's, searched on the server by `q`. */
export function useCompanyNames(q: string, enabled = true) {
  const query = q.trim().toLowerCase();
  return useQuery({
    queryKey: [...trackerKeys.companies, query] as const,
    queryFn: ({ signal }) =>
      api.get<{ items: string[] }>('/api/applications/companies', {
        query: { q: query || undefined },
        schema: z.object({ items: z.array(z.string()) }),
        signal,
      }),
    // The previous suggestions stay while the next ones load.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled,
  });
}

/** What the pickers need of a resume or a letter; read leniently, so another package's extra fields never matter. */
export interface ResumeOption {
  id: string;
  label: string;
  isDefault: boolean;
  kind: string;
}

export interface LetterOption {
  id: string;
  title: string;
}

const LooseResumeList = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        label: z.string().optional(),
        title: z.string().nullable().optional(),
        isDefault: z.boolean().optional(),
        kind: z.string().optional(),
      })
      .passthrough(),
  ),
});

const LooseLetterList = z.object({
  items: z.array(z.object({ id: z.string(), title: z.string().optional() }).passthrough()),
});

/** The account's resumes for the pickers (Documents' API; the tracker degrades when it is not there). */
export function useResumeOptions(enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.resumes,
    queryFn: async ({ signal }): Promise<{ items: ResumeOption[] }> => {
      const data = await api.get<z.infer<typeof LooseResumeList>>('/api/resumes', { schema: LooseResumeList, signal });
      return {
        items: data.items.map((item) => ({
          id: item.id,
          label: item.label || item.title || 'Untitled resume',
          isDefault: item.isDefault ?? false,
          kind: item.kind ?? 'built',
        })),
      };
    },
    enabled,
    retry: false,
    // Read again whenever a picker opens: a resume made in another tab must be there.
    staleTime: 0,
  });
}

export function useCoverLetterOptions(enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.letters,
    queryFn: async ({ signal }): Promise<{ items: LetterOption[] }> => {
      const data = await api.get<z.infer<typeof LooseLetterList>>('/api/cover-letters', { schema: LooseLetterList, signal });
      return { items: data.items.map((item) => ({ id: item.id, title: item.title || 'Untitled cover letter' })) };
    },
    enabled,
    retry: false,
    staleTime: 0,
  });
}

/** Letters the cover letter editor wrote for this application ("Generate cover letter"). */
export function useLettersForApplication(id: string, enabled: boolean) {
  return useQuery({
    queryKey: trackerKeys.lettersFor(id),
    queryFn: ({ signal }) =>
      api.get<{ items: Array<{ id: string; title: string; updatedAt: string }> }>(
        `/api/applications/${encodeURIComponent(id)}/cover-letters`,
        {
          schema: z.object({ items: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.string() })) }),
          signal,
        },
      ),
    enabled,
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------------------------------------- writes

const path = (id: string) => `/api/applications/${encodeURIComponent(id)}`;

export const trackerApi = {
  create: (body: CreateApplicationBody) => api.post<ApplicationDetail>('/api/applications', body, { schema: ApplicationDetailSchema }),
  // v33 SHARE-9: `profile`, the card's profile in the All profiles view (left out: the document's).
  patch: (id: string, body: PatchApplicationBody, profile?: ProfileChoice) =>
    api.patch<ApplicationDetail>(path(id), body, { schema: ApplicationDetailSchema, profile }),
  /** "Let TailorIT choose": links the best-matching resume now (origin 'auto'); 409 when the application is not a Saved job. */
  autoMatchResume: (id: string) =>
    api.post<ApplicationDetail>(`${path(id)}/resume-match`, {}, { schema: ApplicationDetailSchema }),
  remove: (id: string) => api.delete(path(id)),
  status: (id: string, status: ApplicationStatus, occurredOn = localToday(), profile?: ProfileChoice) =>
    api.put<StatusChangeResponse>(`${path(id)}/status`, { status, occurredOn }, { schema: StatusChangeResponseSchema, profile }),
  setDate: (id: string, status: ApplicationStatus, occurredOn: string) =>
    api.put<StatusChangeResponse>(`${path(id)}/events/${status}`, { occurredOn }, { schema: StatusChangeResponseSchema }),
  clearDate: (id: string, status: ApplicationStatus) =>
    api.delete<StatusChangeResponse>(`${path(id)}/events/${status}`, { schema: StatusChangeResponseSchema }),
  archive: (id: string, profile?: ProfileChoice) =>
    api.post<ApplicationDetail>(`${path(id)}/archive`, undefined, { schema: ApplicationDetailSchema, profile }),
  restore: (id: string, profile?: ProfileChoice) =>
    api.post<ApplicationDetail>(`${path(id)}/restore`, undefined, { schema: ApplicationDetailSchema, profile }),
  bulk: (body: BulkApplicationsBody) =>
    api.post<{ affected: number }>('/api/applications/bulk', body, { schema: BulkApplicationsResponseSchema }),
  archiveAll: () => api.post<{ archived: number }>('/api/applications/archive-all', undefined, { schema: ArchiveAllResponseSchema }),
  import: (body: TrackerImportBody) =>
    api.post<TrackerImportResponse>('/api/applications/import', body, { schema: TrackerImportResponseSchema }),
  /** Which of an import file's company names TailorIT knows (up to 1,000 at a time), each with its known name. */
  knownCompanies: (names: string[]) =>
    api.post<{ known: Record<string, string> }>(
      '/api/applications/import/companies',
      { names },
      { schema: z.object({ known: z.record(z.string(), z.string()) }) },
    ),
  addQuestion: (id: string, question: string, answer = '') =>
    api.post<ApplicationQuestion>(`${path(id)}/questions`, { question, answer }, { schema: ApplicationQuestionSchema }),
  patchQuestion: (id: string, questionId: string, body: { question?: string; answer?: string; position?: number }) =>
    api.patch<ApplicationQuestion>(`${path(id)}/questions/${encodeURIComponent(questionId)}`, body, { schema: ApplicationQuestionSchema }),
  deleteQuestion: (id: string, questionId: string) => api.delete(`${path(id)}/questions/${encodeURIComponent(questionId)}`),
};

/** Applies `update` to every cached application summary with this id (board columns, list pages, the detail). */
export function patchCachedApplication(
  client: QueryClient,
  id: string,
  update: (summary: ApplicationSummary) => ApplicationSummary,
): void {
  client.setQueriesData<BoardResponse>({ queryKey: trackerKeys.boards }, (board) =>
    board
      ? {
          columns: board.columns.map((column) => ({
            ...column,
            items: column.items.map((item) => (item.id === id ? update(item) : item)),
          })),
        }
      : board,
  );
  client.setQueriesData<{ pages: ListResponse<ApplicationSummary>[]; pageParams: unknown[] }>(
    { queryKey: trackerKeys.lists },
    (data) =>
      data
        ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.id === id ? update(item) : item)) })) }
        : data,
  );
  client.setQueryData<ApplicationDetail>(trackerKeys.detail(id), (detail) =>
    detail ? { ...detail, ...update(detail) } : detail,
  );
}

/**
 * Moves a card between columns in every cached board (the optimistic drag and drop): out of the column it is in, into
 * its new status's. v33 TRACKER (F1): a Draft card is a Saved card; moved, it carries no Draft mark until the board
 * reads again.
 */
export function moveOnBoards(client: QueryClient, id: string, to: ApplicationStatus): void {
  client.setQueriesData<BoardResponse>({ queryKey: trackerKeys.boards }, (board) => {
    if (!board) return board;
    let moving: ApplicationSummary | undefined;
    let from: ApplicationStatus | undefined;
    for (const column of board.columns) {
      const found = column.items.find((item) => item.id === id);
      if (found && !moving) {
        moving = found;
        from = column.status;
      }
    }
    if (!moving || moving.currentStatus === to) return board;
    const moved = { ...moving, currentStatus: to, queued: false };
    return {
      columns: board.columns.map((column) => {
        if (column.status === from) {
          return { ...column, total: Math.max(0, column.total - 1), items: column.items.filter((item) => item.id !== id) };
        }
        if (column.status === to) return { ...column, total: column.total + 1, items: [moved, ...column.items] };
        return column;
      }),
    };
  });
}

/** What a status move sends: the application, its new status, where it was, and (v33 SHARE-9) the card's profile. */
export interface MoveStatusVariables {
  id: string;
  status: ApplicationStatus;
  from?: ApplicationStatus | null;
  /** v33 SHARE-9: the card's profile in the All profiles view (left out: the document's). */
  profile?: ProfileChoice;
}

interface MoveContext {
  boards: Array<[readonly unknown[], BoardResponse | undefined]>;
  detail: ApplicationDetail | undefined;
}

/**
 * The status move's mutation (useMoveStatus; v33 SHARE-9: the tests run it with a MutationObserver): optimistic on every
 * cached board (the All profiles view's per-profile boards included), rolled back on failure, sent to the card's
 * profile.
 */
export function moveStatusOptions(
  client: QueryClient,
  options: { onMoved?: (result: StatusChangeResponse, previous: ApplicationStatus | null) => void } = {},
) {
  return {
    mutationKey: MOVE_KEY,
    mutationFn: ({ id, status, profile }: MoveStatusVariables) => trackerApi.status(id, status, localToday(), profile),
    onMutate: async ({ id, status }: MoveStatusVariables): Promise<MoveContext> => {
      await client.cancelQueries({ queryKey: trackerKeys.boards });
      const boards = client.getQueriesData<BoardResponse>({ queryKey: trackerKeys.boards });
      const detail = client.getQueryData<ApplicationDetail>(trackerKeys.detail(id));
      moveOnBoards(client, id, status);
      // The detail's select shows the choice at once (its timeline follows with the server's events).
      if (detail) client.setQueryData<ApplicationDetail>(trackerKeys.detail(id), { ...detail, currentStatus: status });
      return { boards, detail };
    },
    onError: (_error: unknown, { id }: MoveStatusVariables, context: MoveContext | undefined) => {
      // Put the snapshot back only when no other move is in flight (it would undo that one too); otherwise the
      // refetch below restores the truth.
      if (client.isMutating({ mutationKey: MOVE_KEY }) > 1) return;
      for (const [key, data] of context?.boards ?? []) client.setQueryData(key, data);
      if (context?.detail) client.setQueryData(trackerKeys.detail(id), context.detail);
    },
    onSuccess: (result: StatusChangeResponse, { from }: MoveStatusVariables) => {
      patchCachedApplication(client, result.id, (summary) => ({
        ...summary,
        currentStatus: result.currentStatus,
        events: result.events,
        updatedAt: result.updatedAt,
      }));
      options.onMoved?.(result, from ?? null);
    },
    // Refetch once the last overlapping move settles, so a refetch never overwrites another move's optimistic card.
    onSettled: () =>
      client.isMutating({ mutationKey: MOVE_KEY }) === 1 ? invalidateApplications(client) : Promise.resolve(),
  };
}

/** "Move to", drag and drop, the list's Status menu and the detail's select: optimistic, rolled back on failure. */
export function useMoveStatus(options: { onMoved?: (result: StatusChangeResponse, previous: ApplicationStatus | null) => void } = {}) {
  const client = useQueryClient();
  return useMutation(moveStatusOptions(client, options));
}

/** The heart's variables. v33 SHARE-9: `profile`, the card's in the All profiles view (left out: the document's). */
export interface ToggleFavoriteVariables {
  id: string;
  favorite: boolean;
  profile?: ProfileChoice;
}

/** The heart's mutation options (useToggleFavorite; v33 SHARE-9 fix: the tests drive them with a MutationObserver). */
export function toggleFavoriteOptions(client: QueryClient) {
  return {
    mutationFn: ({ id, favorite, profile }: ToggleFavoriteVariables) => trackerApi.patch(id, { favorite }, profile),
    onMutate: ({ id, favorite }: ToggleFavoriteVariables) => {
      patchCachedApplication(client, id, (summary) => ({ ...summary, favorite }));
    },
    onError: (_error: unknown, { id, favorite }: ToggleFavoriteVariables) => {
      patchCachedApplication(client, id, (summary) => ({ ...summary, favorite: !favorite }));
    },
    onSettled: () => invalidateApplications(client),
  };
}

/** The heart: flips at once, rolled back on failure. */
export function useToggleFavorite() {
  const client = useQueryClient();
  return useMutation(toggleFavoriteOptions(client));
}
