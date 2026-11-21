'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  JOB_ROW_MATCHES_MAX_IDS,
  toIsoDate,
  type JobDetail,
  type JobFacet,
  type JobRowMatch,
  type JobsQuery,
  type SavedJobRef,
} from '@tailorit/shared';
import { useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import { PREFERENCES_QUERY_KEY, fetchPreferences } from '@/features/settings/api';
import { readLocation } from '@/features/settings/location';
import { isProfileRefusal, userMessage } from '@/lib/api';
import {
  APPLIED_STATUS,
  SAVED_STATUS,
  archiveApplication,
  createSavedSearch,
  deleteSavedSearch,
  fetchFacet,
  fetchFacetsSummary,
  fetchInsights,
  fetchJob,
  fetchJobsCount,
  fetchJobsPage,
  fetchRowMatches,
  fetchSavedSearches,
  hideCompany,
  hideJob,
  jobsKeys,
  listQueryString,
  restoreApplication,
  saveAllJobs,
  trackJob,
  unhideCompany,
  unhideJob,
  unsaveApplications,
  type ApplicationRef,
  type JobListItem,
  type JobListPage,
} from './api';

/** The tracker's React Query keys all start with 'tracker' (work package T): refetch them after Save or Apply. */
const TRACKER_KEY = ['tracker'] as const;

/** The browser's calendar day: an Applied date is the person's own day. */
export function localToday(): string {
  return toIsoDate(new Date()) ?? new Date().toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------------------------------- reads

export function useJobsList(query: JobsQuery) {
  const queryString = listQueryString(query);
  return useInfiniteQuery({
    queryKey: jobsKeys.list(queryString),
    queryFn: ({ pageParam, signal }) => fetchJobsPage(queryString, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: JobListPage) => last.nextCursor,
    // Saved / applied state can change in the Job Tracker: coming back to the page refetches.
    staleTime: 0,
    // The old results stay on screen while new filters load (no blank flash between searches).
    placeholderData: keepPreviousData,
  });
}

export function useJobsCount(query: JobsQuery, enabled: boolean) {
  const queryString = listQueryString(query);
  return useQuery({
    queryKey: jobsKeys.count(queryString),
    queryFn: ({ signal }) => fetchJobsCount(queryString, signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useJobDetail(id: number | null) {
  return useQuery({
    queryKey: jobsKeys.detail(id ?? 0),
    queryFn: ({ signal }) => fetchJob(id!, signal),
    enabled: id !== null,
    staleTime: 0,
  });
}

/**
 * The analysis and the keyword match read off it, in one answer, so "About the role" and Your match change
 * together. Polled every 4 s while the AI analysis is being made ("Refining…"); what is shown stays on screen until
 * the next answer replaces it whole (no loading state in between).
 */
export function useJobInsights(id: number | null) {
  return useQuery({
    queryKey: jobsKeys.insights(id ?? 0),
    queryFn: ({ signal }) => fetchInsights(id!, signal),
    enabled: id !== null,
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.analysis.refining ? 4000 : false),
  });
}

/**
 * v31 FIX-JOBS: each listed job's keyword match for the feed's tape meters, one request per list page (21 jobs), in a
 * map by job id. A job not in the map yet is still loading (or its page failed: the row then shows no meter).
 */
export function useRowMatches(pages: ReadonlyArray<{ items: ReadonlyArray<{ id: number }> }>) {
  const chunks = pages.flatMap((page) => {
    const ids = page.items.map((item) => item.id);
    const out: number[][] = [];
    for (let start = 0; start < ids.length; start += JOB_ROW_MATCHES_MAX_IDS) out.push(ids.slice(start, start + JOB_ROW_MATCHES_MAX_IDS));
    return out;
  });
  return useQueries({
    queries: chunks.map((ids) => ({
      queryKey: jobsKeys.rowMatches(ids),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchRowMatches(ids, signal),
      staleTime: 60_000,
      enabled: ids.length > 0,
    })),
    combine: (results) => {
      const byJob = new Map<number, JobRowMatch>();
      for (const result of results) for (const item of result.data?.items ?? []) byJob.set(item.jobId, item);
      return { byJob, settled: results.every((result) => !result.isPending) };
    },
  });
}

export function useFacet(facet: JobFacet, q: string, enabled = true) {
  return useQuery({
    queryKey: jobsKeys.facet(facet, q),
    queryFn: ({ signal }) => fetchFacet(facet, q, signal),
    enabled,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useFacetsSummary() {
  return useQuery({
    queryKey: jobsKeys.facetsSummary,
    queryFn: ({ signal }) => fetchFacetsSummary(signal),
    staleTime: 5 * 60_000,
  });
}

/**
 * v30 WEB-JOBS: where the person lives and their time zone (Settings › Job preferences, the same query and cache as the
 * Settings page), for "Jobs I can apply to" to say what it cannot check yet.
 */
export function useApplicantLocation(enabled: boolean) {
  return useQuery({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: ({ signal }) => fetchPreferences(signal),
    enabled,
    staleTime: 60_000,
    // Another page may have cached the answer as it came (the tracker's sheet): read the location from either.
    select: (data: unknown) => readLocation(data),
  });
}

export function useSavedSearches(enabled = true) {
  return useQuery({
    queryKey: jobsKeys.savedSearches,
    queryFn: ({ signal }) => fetchSavedSearches(signal),
    enabled,
  });
}

// ------------------------------------------------------------------------------------------------ cache edits

type ListData = InfiniteData<JobListPage, string | undefined>;

/** What the Jobs page shows of a job's tie to the tracker. */
export type JobPatch = Partial<Pick<JobListItem, 'saved' | 'appliedOn' | 'applicationId'>>;

/** Changes jobs wherever they are cached, in one pass over the lists: every page that shows one, and their details. */
export function patchJobs(client: QueryClient, patches: ReadonlyMap<number, JobPatch>): void {
  if (patches.size === 0) return;
  client.setQueriesData<ListData>({ queryKey: jobsKeys.lists }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => {
              const patch = patches.get(item.id);
              return patch ? { ...item, ...patch } : item;
            }),
          })),
        }
      : data,
  );
  for (const [jobId, patch] of patches) {
    client.setQueryData<JobDetail>(jobsKeys.detail(jobId), (detail) =>
      detail
        ? {
            ...detail,
            ...(patch.saved !== undefined ? { saved: patch.saved } : {}),
            ...(patch.appliedOn !== undefined ? { appliedOn: patch.appliedOn } : {}),
            userState: {
              ...detail.userState,
              ...(patch.saved !== undefined ? { saved: patch.saved } : {}),
              ...(patch.appliedOn !== undefined ? { appliedOn: patch.appliedOn } : {}),
              ...(patch.applicationId !== undefined ? { applicationId: patch.applicationId } : {}),
            },
          }
        : detail,
    );
  }
}

/** Changes one job wherever it is cached: every list page that shows it and its detail. */
export function patchJob(client: QueryClient, jobId: number, patch: JobPatch): void {
  patchJobs(client, new Map([[jobId, patch]]));
}

/** Drops jobs from every cached list (hidden jobs, a hidden company's jobs). */
export function removeJobsFromLists(client: QueryClient, match: (item: JobListItem) => boolean): void {
  client.setQueriesData<ListData>({ queryKey: jobsKeys.lists }, (data) => {
    if (!data) return data;
    let removed = 0;
    const pages = data.pages.map((page) => {
      const items = page.items.filter((item) => {
        const drop = match(item);
        if (drop) removed += 1;
        return !drop;
      });
      return { ...page, items };
    });
    if (removed === 0) return data;
    return {
      ...data,
      pages: pages.map((page, index) =>
        index === 0 && page.total !== undefined ? { ...page, total: Math.max(0, page.total - removed) } : page,
      ),
    };
  });
}

function refreshAfterTracking(client: QueryClient, jobId: number): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: jobsKeys.detail(jobId) }),
    client.invalidateQueries({ queryKey: jobsKeys.lists, refetchType: 'none' }),
    client.invalidateQueries({ queryKey: jobsKeys.counts }),
    client.invalidateQueries({ queryKey: TRACKER_KEY }),
  ]);
}

/**
 * After Save all and its Undo: many jobs changed, most of them beyond the loaded pages. The lists on screen are read
 * again now (not only marked stale, unlike a single save), with the counts, the details, the keyword cards (a saved
 * job scores the resume linked to it) and the Job Tracker.
 */
function refreshAfterBulkTracking(client: QueryClient): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: jobsKeys.lists }),
    client.invalidateQueries({ queryKey: jobsKeys.counts }),
    client.invalidateQueries({ queryKey: jobsKeys.details }),
    client.invalidateQueries({ queryKey: jobsKeys.allInsights }),
    client.invalidateQueries({ queryKey: jobsKeys.allRowMatches }), // v31 FIX-JOBS
    client.invalidateQueries({ queryKey: TRACKER_KEY }),
  ]);
}

// --------------------------------------------------------------------------------------------------- writes

interface TrackJobInput {
  jobId: number;
}

/** Save (bookmark): tracks the job as Saved. Optimistic. */
export function useSaveJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId }: TrackJobInput) => trackJob(jobId, SAVED_STATUS, localToday()),
    onMutate: async ({ jobId }) => {
      await client.cancelQueries({ queryKey: jobsKeys.detail(jobId) });
      patchJob(client, jobId, { saved: true });
    },
    // The tracker answers the existing application when there is one (restored if it was archived): still Saved, or
    // already further along.
    onSuccess: (application, { jobId }) => patchJob(client, jobId, savedStateOf(application)),
    onError: (_error, { jobId }) => patchJob(client, jobId, { saved: false }),
    onSettled: (_data, _error, { jobId }) => refreshAfterTracking(client, jobId),
  });
}

function savedStateOf(application: ApplicationRef): Pick<JobListItem, 'saved' | 'applicationId'> {
  return {
    saved: application.currentStatus === undefined || application.currentStatus === SAVED_STATUS,
    applicationId: application.id,
  };
}

interface ApplicationInput extends TrackJobInput {
  applicationId: string;
}

/**
 * Un-save: archives the job's application (its notes and dates stay in the Job Tracker's archive, and Undo restores
 * it). Optimistic.
 */
export function useUnsaveJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ applicationId }: ApplicationInput) => archiveApplication(applicationId),
    onMutate: async ({ jobId }) => {
      await client.cancelQueries({ queryKey: jobsKeys.detail(jobId) });
      patchJob(client, jobId, { saved: false });
    },
    onSuccess: (_data, { jobId }) => patchJob(client, jobId, { saved: false, applicationId: null }),
    onError: (_error, { jobId }) => patchJob(client, jobId, { saved: true }),
    onSettled: (_data, _error, { jobId }) => refreshAfterTracking(client, jobId),
  });
}

/** Undo of an un-save: restores the archived application, so the job is saved again. Optimistic. */
export function useRestoreSavedJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ applicationId }: ApplicationInput) => restoreApplication(applicationId),
    onMutate: async ({ jobId, applicationId }) => {
      await client.cancelQueries({ queryKey: jobsKeys.detail(jobId) });
      patchJob(client, jobId, { saved: true, applicationId });
    },
    onSuccess: (application, { jobId }) => patchJob(client, jobId, savedStateOf(application)),
    onError: (_error, { jobId }) => patchJob(client, jobId, { saved: false, applicationId: null }),
    onSettled: (_data, _error, { jobId }) => refreshAfterTracking(client, jobId),
  });
}

/**
 * v33 FIX-1 (PLAN-sharing §9: a refused write shows one alert): says why a job action failed in a toast, unless it is a
 * shared profile's refusal, which the shell's alert already says (the toast and the alert disagreed on the owner's
 * name). For the Jobs page's save, un-save, mark applied, hide and Save all.
 */
export function failure(toast: Pick<ReturnType<typeof useToast>, 'error'>, title: string, error: unknown): void {
  if (isProfileRefusal(error)) return;
  toast.error(title, userMessage(error));
}

/** What the bookmark needs to know about a job: the list card's fields, or the detail's user state and id. */
export interface SaveTarget {
  jobId: number;
  saved: boolean;
  appliedOn: string | null;
  applicationId: string | null;
}

/**
 * The Save bookmark of the list cards and the detail: saves the job, or un-saves it with "Removed from saved jobs" and
 * Undo. An applied job is left as it is (it is in the Job Tracker as Applied). `confirmSave` also confirms a save.
 */
export function useSaveToggle() {
  const toast = useToast();
  const save = useSaveJob();
  const unsave = useUnsaveJob();
  const restore = useRestoreSavedJob();
  const { mutate: saveJob } = save;
  const { mutate: unsaveJob } = unsave;
  const { mutate: restoreJob } = restore;

  const toggle = useCallback(
    (job: SaveTarget, options: { confirmSave?: boolean } = {}) => {
      if (job.appliedOn) {
        toast.info("You've applied to this job", 'It is in your Job Tracker as Applied.');
        return;
      }
      const { jobId, applicationId } = job;
      if (job.saved && applicationId) {
        unsaveJob(
          { jobId, applicationId },
          {
            onSuccess: () =>
              toast.toast({
                type: 'info',
                title: 'Removed from saved jobs',
                description: 'It is archived in your Job Tracker, notes and all.',
                action: {
                  label: 'Undo',
                  onClick: () =>
                    restoreJob(
                      { jobId, applicationId },
                      { onError: (error) => failure(toast, 'The job could not be saved again', error) },
                    ),
                },
              }),
            onError: (error) => failure(toast, 'The job could not be removed from saved jobs', error),
          },
        );
        return;
      }
      saveJob(
        { jobId },
        {
          onSuccess: () => {
            if (options.confirmSave) toast.success('Job saved', 'Find it in your Job Tracker under Saved.');
          },
          onError: (error) => failure(toast, 'The job could not be saved', error),
        },
      );
    },
    [toast, saveJob, unsaveJob, restoreJob],
  );

  return { toggle, pending: save.isPending || unsave.isPending || restore.isPending };
}

/**
 * Save all: saves the jobs matching the filters the confirm was shown for (`queryString`), at most 100, on the
 * browser's day. Their cards read Saved as soon as the answer is in; the rest is read again afterwards. The refresh is
 * not awaited (nor returned from onSettled), so `mutateAsync`, and with it the confirm dialog, finishes with the save.
 */
export function useSaveAll() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ queryString }: { queryString: string }) => saveAllJobs(queryString, localToday()),
    onSuccess: (result) =>
      patchJobs(
        client,
        new Map<number, JobPatch>(result.items.map((item) => [item.jobId, { saved: true, applicationId: item.applicationId }])),
      ),
    onSettled: () => {
      void refreshAfterBulkTracking(client);
    },
  });
}

/**
 * Save all's Undo: archives exactly the applications the click saved (an application applied to since is left as it
 * is). Optimistic: the cards read not saved at once, and come back if it fails.
 */
export function useUndoSaveAll() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (items: readonly SavedJobRef[]) => unsaveApplications(items.map((item) => item.applicationId)),
    onMutate: async (items) => {
      // A refetch still running (the one after Save all) would bring the saved state back over the change.
      await Promise.all([client.cancelQueries({ queryKey: jobsKeys.lists }), client.cancelQueries({ queryKey: jobsKeys.details })]);
      patchJobs(client, new Map<number, JobPatch>(items.map((item) => [item.jobId, { saved: false, applicationId: null }])));
    },
    onError: (_error, items) =>
      patchJobs(
        client,
        new Map<number, JobPatch>(items.map((item) => [item.jobId, { saved: true, applicationId: item.applicationId }])),
      ),
    onSettled: () => {
      void refreshAfterBulkTracking(client);
    },
  });
}

/** "Applied to this job?" → Yes, and "Mark as applied": tracks the job as Applied today. */
export function useMarkApplied() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId }: TrackJobInput) => trackJob(jobId, APPLIED_STATUS, localToday()),
    onSuccess: (application, { jobId }) =>
      patchJob(client, jobId, { saved: false, appliedOn: localToday(), applicationId: application.id }),
    onSettled: (_data, _error, { jobId }) => refreshAfterTracking(client, jobId),
  });
}

export function useHideJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, hidden }: { jobId: number; hidden: boolean }) => (hidden ? hideJob(jobId) : unhideJob(jobId)),
    onSuccess: (_data, { jobId, hidden }) => {
      if (hidden) removeJobsFromLists(client, (item) => item.id === jobId);
      client.setQueryData<JobDetail>(jobsKeys.detail(jobId), (detail) =>
        detail ? { ...detail, userState: { ...detail.userState, hidden } } : detail,
      );
    },
    // Hiding already took the jobs out of the cached lists; unhiding brings them back with a refetch.
    onSettled: (_data, _error, { hidden }) =>
      client.invalidateQueries({ queryKey: jobsKeys.lists, refetchType: hidden ? 'none' : 'active' }),
  });
}

export function useHideCompany() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, hidden }: { companyId: number; hidden: boolean }) =>
      hidden ? hideCompany(companyId) : unhideCompany(companyId),
    onSuccess: (_data, { companyId, hidden }) => {
      if (hidden) removeJobsFromLists(client, (item) => item.company.id === companyId);
      client.setQueriesData<JobDetail>({ queryKey: jobsKeys.details }, (detail) =>
        detail && detail.company.id === companyId
          ? { ...detail, userState: { ...detail.userState, companyHidden: hidden } }
          : detail,
      );
    },
    // Hiding already took the jobs out of the cached lists; unhiding brings them back with a refetch.
    onSettled: (_data, _error, { hidden }) =>
      client.invalidateQueries({ queryKey: jobsKeys.lists, refetchType: hidden ? 'none' : 'active' }),
  });
}

export function useCreateSavedSearch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, query }: { name: string; query: JobsQuery }) => createSavedSearch(name, query),
    onSettled: () => client.invalidateQueries({ queryKey: jobsKeys.savedSearches }),
  });
}

export function useDeleteSavedSearch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSavedSearch(id),
    onSettled: () => client.invalidateQueries({ queryKey: jobsKeys.savedSearches }),
  });
}
