'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApplicationDetail } from '@tailorit/shared';
import { LoadError } from '@/components/ui/LoadError';
import { Skeleton } from '@/components/ui/Skeleton';
import { isProfileRefusal } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { LetterPreviewDialog } from '../../documents/preview/LetterPreviewDialog';
import { ResumePreviewDialog } from '../../documents/preview/ResumePreviewDialog';
import { fetchApplicationDraft, prepareKeys } from '../../prepare/api';
import { useApplyRecords } from '../data';
import { isDraft } from '../draft';
import { NotSharedNotice } from '../profiles/NotShared';
import { DraftView } from './DraftView';

/**
 * v2.0: the "Prepared" tab: reads the application's kit (frozen when it was queued, A30) and its apply records ("Applied
 * with"), draws them (DraftView), with the full-page previews.
 */
export function DraftTab({ application }: { application: ApplicationDetail }) {
  const { t } = usePublicConstants();
  const draft = useQuery({
    queryKey: prepareKeys.draft(application.id),
    queryFn: ({ signal }) => fetchApplicationDraft(application.id, signal),
  });
  const records = useApplyRecords(application.id, true);
  const [previewing, setPreviewing] = useState<'resume' | 'letter' | null>(null);
  if (draft.isLoading) return <Skeleton className="h-48 w-full" rounded="surface" />;
  if (draft.isError || !draft.data) {
    // v33 SHARE-9 fix (review; PLAN-sharing.md §9): a shared profile's refusal (no Prepare box) says so in place.
    if (isProfileRefusal(draft.error)) return <NotSharedNotice title="What was prepared" />;
    // v32 FIX-UX (UXREQ-13): the kit's load error, its reason in view.
    return <LoadError thing="What was prepared for this application" error={draft.error} onRetry={() => void draft.refetch()} />;
  }
  const { resume, letter } = draft.data.draft ?? { resume: null, letter: null };
  return (
    <>
      <DraftView
        data={draft.data}
        records={records.data?.items ?? null}
        draft={isDraft(application)}
        draftLabel={t('STATUS_DRAFT_LABEL')}
        onPreview={setPreviewing}
      />
      {resume?.resumeId && (
        <ResumePreviewDialog
          open={previewing === 'resume'}
          onOpenChange={(open) => !open && setPreviewing(null)}
          resumeId={resume.resumeId}
          label={draft.data.resumeTitle ?? 'Resume'}
        />
      )}
      {letter?.coverLetterId && (
        <LetterPreviewDialog
          open={previewing === 'letter'}
          onOpenChange={(open) => !open && setPreviewing(null)}
          letterId={letter.coverLetterId}
          title={draft.data.coverLetterTitle ?? 'Cover letter'}
        />
      )}
    </>
  );
}
