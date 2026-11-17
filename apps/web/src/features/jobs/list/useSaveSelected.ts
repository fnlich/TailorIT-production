'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { redirectToLogin } from '@/lib/navigation';
import type { JobListItem } from '../api';
import { useSaveJob } from '../hooks';

// v2.0 (A4): the Jobs list's selection saves the chosen jobs to Saved Jobs, the existing Save one job at a time, then
// says so with "Open Auto-apply", where they can be prepared. Nothing is queued from here any more: a job reaches the
// auto-apply queue only through Prepare & Queue.

/** The result toast stays this long, so "Open Auto-apply" can be reached. */
const RESULT_TOAST_MS = 10_000;

/** Why a job cannot be chosen to save, or null: applied to already, or saved already. */
export function saveBlockReason(job: Pick<JobListItem, 'appliedOn' | 'saved'>): string | null {
  if (job.appliedOn !== null) return 'You have applied to this job already.';
  if (job.saved) return 'Saved already: it is in your Saved Jobs.';
  return null;
}

/** The toast's title and words after saving `saved` of `asked` jobs. */
export function saveSelectedCopy(saved: number, asked: number): { title: string; description: string } {
  const jobs = (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'}`;
  return {
    title: `${jobs(saved)} saved`,
    description:
      saved === asked
        ? 'Prepare & Queue them on the Auto-apply page, and TailorIT applies to the ready ones for you.'
        : `${asked - saved} could not be saved. They stay chosen: try again.`,
  };
}

/**
 * Saves the chosen jobs (one request each, in the list's order). `onDone` gets the jobs it could not save (a request
 * that failed, and the ones after it): they stay chosen.
 */
export function useSaveSelected(onDone: (left: readonly number[]) => void) {
  const toast = useToast();
  const router = useRouter();
  const save = useSaveJob();
  const mutation = useMutation({
    mutationFn: async (jobIds: readonly number[]) => {
      const done: number[] = [];
      for (const jobId of jobIds) {
        try {
          await save.mutateAsync({ jobId });
          done.push(jobId);
        } catch (error) {
          return { done, error, left: jobIds.filter((id) => !done.includes(id)) };
        }
      }
      return { done, error: null as unknown, left: [] as number[] };
    },
    onSuccess: ({ done, error, left }, jobIds) => {
      if (error instanceof ApiError && error.isSessionExpired) {
        redirectToLogin();
        return;
      }
      const open = { label: 'Open Auto-apply', onClick: () => router.push('/auto-apply') };
      if (error !== null && done.length === 0) {
        toast.error('The jobs could not be saved', userMessage(error, 'Please try again.'));
      } else {
        const copy = saveSelectedCopy(done.length, jobIds.length);
        toast.toast({ type: error === null ? 'success' : 'info', ...copy, timeout: RESULT_TOAST_MS, action: open });
      }
      onDone(left);
    },
  });
  return {
    saveSelected: (jobIds: readonly number[]) => {
      if (mutation.isPending || jobIds.length === 0) return;
      mutation.mutate(jobIds);
    },
    pending: mutation.isPending,
  };
}
