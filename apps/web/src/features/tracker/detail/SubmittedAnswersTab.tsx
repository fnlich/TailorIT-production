'use client';

import type { ApplicationDetail } from '@tailorit/shared';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { userMessage } from '@/lib/api';
import { useSubmittedAnswers } from '../data';
import { SubmittedAnswersView } from './SubmittedAnswersView';

/** v1.3 A: the "Submitted answers" tab: reads the application's submitted answers and draws them (SubmittedAnswersView). */
export function SubmittedAnswersTab({ application }: { application: ApplicationDetail }) {
  const answers = useSubmittedAnswers(application.id, true);
  if (answers.isLoading) return <Skeleton className="h-48 w-full" rounded="surface" />;
  if (answers.isError || !answers.data) {
    return <Notice tone="error">{userMessage(answers.error, "We couldn't load your submitted answers. Please try again.")}</Notice>;
  }
  return <SubmittedAnswersView data={answers.data} />;
}
