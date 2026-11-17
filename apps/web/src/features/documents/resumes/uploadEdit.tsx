'use client';

import type { ResumeSummary } from '@tailorit/shared/resume';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { readStored, writeStored } from '@/lib/storage';
import { resumeEditRouteHref } from '../../resume-editor/api';

/*
 * v1.5 W (decision 3): Edit on an uploaded resume. An upload is never changed, so editing it means opening its
 * editable copy, which TailorIT's AI makes the first time (/resumes/<id>/edit, with progress). Before that the person
 * is told so once, with "Don't show this again", remembered per account in this browser. A built resume's Edit opens
 * the editor at once.
 */

export const UPLOAD_EDIT_TITLE = 'Edit an uploaded resume';
export const UPLOAD_EDIT_TEXT =
  "Editing an uploaded resume needs an editable copy. TailorIT's AI reads your file to make it, which can take a little " +
  'while. Continue?';
export const UPLOAD_EDIT_DONT_SHOW = "Don't show this again";

/** The remembered "Don't show this again", one per account (another account in the same browser is asked). */
export function uploadEditSkipKey(accountId: string | null | undefined): string | null {
  return accountId ? `tailorit.resumes.uploadEditConfirm.skip.${accountId}` : null;
}

/** Whether Edit on an upload asks first: always, unless this account said not to. */
export function uploadEditAsks(accountId: string | null | undefined, read: (key: string) => string | null = readStored): boolean {
  const key = uploadEditSkipKey(accountId);
  return key === null || read(key) !== '1';
}

/** Remembers "Don't show this again" for the account (nothing without one). */
export function rememberUploadEditSkip(
  accountId: string | null | undefined,
  write: (key: string, value: string | null) => void = writeStored,
): void {
  const key = uploadEditSkipKey(accountId);
  if (key) write(key, '1');
}

/** The question's own content under its sentence: the "Don't show this again" box. */
export function UploadEditDontShow({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <Checkbox checked={checked} onCheckedChange={(next) => onCheckedChange(next)} label={UPLOAD_EDIT_DONT_SHOW} />;
}

/**
 * Edit for an upload: `request(resume)` asks first (unless this account said not to), then opens
 * /resumes/<id>/edit. `dialog` is drawn once by the page.
 */
export function useUploadEdit(): { request: (resume: Pick<ResumeSummary, 'id' | 'label'>) => void; dialog: ReactNode } {
  const router = useRouter();
  const { account } = useAuth();
  const [asking, setAsking] = useState<Pick<ResumeSummary, 'id' | 'label'> | null>(null);
  const [dontShow, setDontShow] = useState(false);

  const open = (id: string) => router.push(resumeEditRouteHref(id));
  const request = (resume: Pick<ResumeSummary, 'id' | 'label'>) => {
    if (!uploadEditAsks(account?.id)) {
      open(resume.id);
      return;
    }
    setDontShow(false);
    setAsking(resume);
  };

  const dialog = (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(next) => {
        if (!next) setAsking(null);
      }}
      title={UPLOAD_EDIT_TITLE}
      description={UPLOAD_EDIT_TEXT}
      confirmLabel="Continue"
      cancelLabel="Cancel"
      tone="primary"
      onConfirm={() => {
        if (!asking) return;
        if (dontShow) rememberUploadEditSkip(account?.id);
        open(asking.id);
      }}
    >
      <UploadEditDontShow checked={dontShow} onCheckedChange={setDontShow} />
    </ConfirmDialog>
  );

  return { request, dialog };
}
