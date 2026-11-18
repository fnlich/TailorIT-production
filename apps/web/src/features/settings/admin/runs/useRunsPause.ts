'use client';

import type { RunsPaused } from '@tailorit/shared/sourcing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { focusLater } from '@/lib/focusLater';
import { sourceKeys } from '../sources/api';
import { continueAllRuns, fetchRunsPaused, pauseAllRuns, runKeys } from './api';
import { continuedAllToast, pausedAllToast } from './pause';

/** v31 RUNS: how often a tab asks again whether every run is paused (another admin may pause them). */
const PAUSED_FOLLOW_MS = 30_000;
/** Where focus goes once Continue gave way to Pause all (Admin › Runs' bar). */
const PAUSE_ALL_BUTTON = '[data-runs-pause-all]';

/**
 * v31 RUNS: whether every run is paused, and the bar's Pause all and Continue (docs/design/v3.1/22-runs-pause.md). Shared
 * by Admin › Runs (its bar) and Admin › Sources (its notice while paused).
 */
export function useRunsPause() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const paused = useQuery({
    queryKey: runKeys.paused,
    queryFn: ({ signal }) => fetchRunsPaused(signal),
    refetchInterval: PAUSED_FOLLOW_MS,
    retry: false,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: runKeys.all });
    void queryClient.invalidateQueries({ queryKey: sourceKeys.all });
  };
  /** Pause all, for a ConfirmDialog's onConfirm (a failure keeps the dialog open with its words). */
  const pauseAll = async () => {
    const result = await pauseAllRuns();
    queryClient.setQueryData<RunsPaused | null>(runKeys.paused, result.paused);
    const words = pausedAllToast(result.stopping);
    toast.success(words.title, words.description);
    refresh();
  };
  const continueAll = useMutation({
    mutationFn: continueAllRuns,
    onSuccess: (result) => {
      queryClient.setQueryData<RunsPaused | null>(runKeys.paused, null);
      const words = continuedAllToast(result.resumed);
      toast.success(words.title, words.description);
      refresh();
      focusLater(PAUSE_ALL_BUTTON);
    },
    onError: (error) => toast.error('The runs did not continue', userMessage(error)),
  });
  return { paused: paused.data ?? null, known: paused.isSuccess, pauseAll, continueAll, refresh };
}
