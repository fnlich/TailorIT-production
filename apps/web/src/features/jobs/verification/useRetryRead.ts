'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AddJobResult } from '@tailorit/shared';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { retryJobRead } from '../add/api';
import { jobsKeys } from '../api';
import { RETRY_READ_COPY, retryReadAnswer } from './copy';

/** The tracker's React Query keys all start with 'tracker'. */
const TRACKER_KEY = ['tracker'] as const;

/**
 * v31 JOBSWEB: Retry read (POST /api/jobs/:id/verify) of a job only its adder sees. Read now, the shared job takes the
 * place of the person's own (their tracker entry moves to it), and `onRead` gets its id; still unread, a toast says
 * why. Every jobs list, detail and the tracker are read again afterwards.
 */
export function useRetryRead({ onRead }: { onRead?: (jobId: number) => void } = {}) {
  const client = useQueryClient();
  const toast = useToast();
  const { t } = usePublicConstants();
  const mutation = useMutation({
    mutationFn: (jobId: number) => retryJobRead(jobId),
    onSuccess: (result: AddJobResult) => {
      const answer = retryReadAnswer(result, t);
      toast[answer.tone](answer.title, answer.body);
      if (answer.read && result.jobId !== null) onRead?.(result.jobId);
    },
    onError: (error) => toast.error(RETRY_READ_COPY.failed, userMessage(error)),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: jobsKeys.all }),
        client.invalidateQueries({ queryKey: TRACKER_KEY }),
      ]),
  });
  return { retry: (jobId: number) => mutation.mutate(jobId), pending: mutation.isPending, pendingId: mutation.isPending ? mutation.variables : null };
}
