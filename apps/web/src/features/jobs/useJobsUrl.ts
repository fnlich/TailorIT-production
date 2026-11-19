'use client';

import type { JobsQuery } from '@tailorit/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { jobsHref, readJobsUrl, type JobsUrlState } from './url';

export interface JobsUrlApi extends JobsUrlState {
  /** Replaces the filters (any open job closes). */
  setQuery: (query: JobsQuery) => void;
  /** Changes some filters, starting from the latest ones (so quick successive clicks all count). */
  updateQuery: (patch: Partial<JobsQuery>) => void;
  /**
   * Shows another job (or none), keeping the filters; the address is replaced, not pushed. v32 JOBS2: how the split
   * shows a job in its pane (a row, the first job, Previous / Next), and how the open sheet steps.
   */
  selectJob: (jobId: number | null) => void;
  /**
   * v31 FIX-JOBS: opens a job from the list. The address gets its own history entry, so the browser's Back closes it
   * and the job's link can be shared. v32 JOBS2: how the stack (below 1024 px) opens its full-screen sheet.
   */
  openJob: (jobId: number) => void;
  /** v31 FIX-JOBS: closes the sheet: back to the entry `openJob` added, or (a job opened from a link) the address without the job. */
  closeJob: () => void;
  /** v31 FIX-JOBS: the job in the address as last asked for, before the router has applied it (quick Next presses). */
  currentJobId: () => number | null;
}

/** The page state in the address bar, and the ways to change it. */
export function useJobsUrl(): JobsUrlApi {
  const router = useRouter();
  const params = useSearchParams();
  const state = useMemo(() => readJobsUrl(params), [params]);

  // Until the router has applied a change, further changes build on the pending state, not the stale one.
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
  /** The drawer's job came with a history entry of this page's own (openJob), which Back removes. */
  const pushed = useRef(false);
  useEffect(() => {
    // Back, Forward or a link that left no job open: nothing of ours is on the stack any more.
    if (state.jobId === null) pushed.current = false;
  }, [state.jobId]);

  const go = useCallback(
    (next: JobsUrlState, mode: 'replace' | 'push' = 'replace') => {
      latest.current = next;
      const href = jobsHref(next.query, next.jobId);
      if (mode === 'push') router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [router],
  );

  const setQuery = useCallback((query: JobsQuery) => go({ query, jobId: null }), [go]);
  const updateQuery = useCallback(
    (patch: Partial<JobsQuery>) => go({ query: { ...latest.current.query, ...patch, cursor: undefined }, jobId: null }),
    [go],
  );
  const selectJob = useCallback((jobId: number | null) => go({ query: latest.current.query, jobId }), [go]);
  const openJob = useCallback(
    (jobId: number) => {
      if (latest.current.jobId === jobId) return;
      // A job already open (Add job's "Open the job" over a drawer) changes in place.
      const mode = latest.current.jobId === null ? 'push' : 'replace';
      if (mode === 'push') pushed.current = true;
      go({ query: latest.current.query, jobId }, mode);
    },
    [go],
  );
  const closeJob = useCallback(() => {
    if (latest.current.jobId === null) return;
    if (pushed.current) {
      pushed.current = false;
      latest.current = { query: latest.current.query, jobId: null };
      router.back();
      return;
    }
    go({ query: latest.current.query, jobId: null });
  }, [go, router]);

  const currentJobId = useCallback(() => latest.current.jobId, []);

  return { ...state, setQuery, updateQuery, selectJob, openJob, closeJob, currentJobId };
}
