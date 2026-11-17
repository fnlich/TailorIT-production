'use client';

import { EDITOR_PAGE_GAP_PX } from '@tailorit/resume-templates';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { DownloadSimpleIcon, PencilSimpleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Spinner';
import { userMessage } from '@/lib/api';
import { resumeEditorHref } from '../../resume-editor/api';
import { ResumeCanvas } from '../../resume-editor/pages/ResumeCanvas';
import { viewOf } from '../../resume-editor/pages/views';
import { fetchEditorResume } from '../../resume-editor/workspace/api';
import { DownloadDialog } from '../../resume-editor/workspace/DownloadDialog';
import { FullPreviewDialog } from './FullPreviewDialog';

// v1.4 E (decision 17): a stored resume's full-page preview, drawn by the editor's own canvas in its static view (what
// prints: no placeholders, no empty fields), so it matches the editor's Preview and the PDF. Edit opens the editor at
// /resumes/<id>; Download is the editor's own Download dialog.

/** The preview's own read of a resume, never the editor's (that one starts autosave from what it read). */
export const resumePreviewKey = (id: string) => ['resumes', 'preview', id] as const;

export function ResumePreviewDialog({
  open,
  onOpenChange,
  resumeId,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resumeId: string;
  /** The resume's name in the documents list, shown while it loads. */
  label: string;
}) {
  return open ? <PreviewBody onOpenChange={onOpenChange} resumeId={resumeId} label={label} /> : null;
}

function PreviewBody({
  onOpenChange,
  resumeId,
  label,
}: {
  onOpenChange: (open: boolean) => void;
  resumeId: string;
  label: string;
}) {
  const query = useQuery({
    queryKey: resumePreviewKey(resumeId),
    queryFn: ({ signal }) => fetchEditorResume(resumeId, signal),
    staleTime: 0,
  });
  const [pages, setPages] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const document = query.data?.document ?? null;
  const design = document ? viewOf(document, 'static').design : null;
  const name = query.data?.label ?? label;

  const actions = (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={<DownloadSimpleIcon size={16} />}
        disabled={!document}
        onClick={() => setDownloading(true)}
        data-preview-download=""
      >
        <span className="max-sm:sr-only">Download</span>
      </Button>
      <Link href={resumeEditorHref(resumeId)} className={buttonClasses({ size: 'sm' })} data-preview-edit="">
        <PencilSimpleIcon size={16} />
        Edit
      </Link>
    </>
  );

  return (
    <>
      <FullPreviewDialog
        open
        onOpenChange={onOpenChange}
        title={name}
        kind="Resume preview"
        actions={actions}
        stack={design ? { width: design.pageWidthPx, pageHeight: design.pageHeightPx, gap: EDITOR_PAGE_GAP_PX, count: pages } : null}
        status={
          query.isError ? (
            <Notice tone="error" className="max-w-md">
              {userMessage(query.error, 'The resume could not be drawn. Please try again.')}
            </Notice>
          ) : !document ? (
            <Spinner size={20} label="Drawing the resume..." />
          ) : undefined
        }
      >
        {document && <ResumeCanvas document={document} mode="static" onPageCount={setPages} />}
      </FullPreviewDialog>
      {downloading && document && (
        <DownloadDialog
          open
          onClose={() => setDownloading(false)}
          document={document}
          emptyFields={0}
          onShowEmpty={() => undefined}
          flush={async () => undefined}
          resumeId={() => resumeId}
        />
      )}
    </>
  );
}
