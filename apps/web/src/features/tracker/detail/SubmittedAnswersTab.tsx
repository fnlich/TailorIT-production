'use client';

import type { ApplicationDetail } from '@tailorit/shared';
import { LoadError } from '@/components/ui/LoadError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSubmittedAnswers } from '../data';
import { SubmittedAnswersView } from './SubmittedAnswersView';

/** v1.3 A: the "Submitted answers" tab: reads the application's submitted answers and draws them (SubmittedAnswersView). */
export function SubmittedAnswersTab({ application }: { application: ApplicationDetail }) {
  const answers = useSubmittedAnswers(application.id, true);
  if (answers.isLoading) return <Skeleton className="h-48 w-full" rounded="surface" />;
  if (answers.isError || !answers.data) {
    // v32 FIX-UX (UXREQ-13): the kit's load error, its reason in view.
    return <LoadError thing="Your submitted answers" error={answers.error} onRetry={() => void answers.refetch()} />;
  }
  return <SubmittedAnswersView data={answers.data} />;
}
