'use client';

import type { ApplicationDetail } from '@tailorit/shared';
import { LoadError } from '@/components/ui/LoadError';
import { Skeleton } from '@/components/ui/Skeleton';
import { isProfileRefusal } from '@/lib/api';
import { useSubmittedAnswers } from '../data';
import { NotSharedNotice } from '../profiles/NotShared';
import { SubmittedAnswersView } from './SubmittedAnswersView';

/** v1.3 A: the "Submitted answers" tab: reads the application's submitted answers and draws them (SubmittedAnswersView). */
export function SubmittedAnswersTab({ application }: { application: ApplicationDetail }) {
  const answers = useSubmittedAnswers(application.id, true);
  if (answers.isLoading) return <Skeleton className="h-48 w-full" rounded="surface" />;
  if (answers.isError || !answers.data) {
    // v33 SHARE-9 fix (review; PLAN-sharing.md §9): a shared profile's refusal says so in place (the submitted answers
    // need the Job Tracker's See box; the server leaves the sensitive rows out without Sensitive answers' See).
    if (isProfileRefusal(answers.error)) return <NotSharedNotice title="Submitted answers" />;
    // v32 FIX-UX (UXREQ-13): the kit's load error, its reason in view.
    return <LoadError thing="Your submitted answers" error={answers.error} onRetry={() => void answers.refetch()} />;
  }
  return <SubmittedAnswersView data={answers.data} />;
}
