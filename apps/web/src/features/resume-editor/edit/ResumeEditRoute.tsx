'use client';

import { ArrowSquareOutIcon } from '@phosphor-icons/react/ArrowSquareOut';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { EditorBar } from '@/components/shell/EditorBar';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Button, buttonClasses } from '@/components/ui/Button';
import { SparkleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Spinner';
import { useAiTask } from '@/lib/useAiTask';
import { RESUMES_TAB_HREF, fetchEditTarget, readImportResult, resumeEditorHref, resumeFileHref, resumeKeys } from '../api';
import { editRoutePhase, type EditRoutePhase } from './editRoute';

/** Edited resumes, where a copy made here is kept (Documents › Resumes, v1.5 W). */
const EDITED_FOLDER_HREF = '/documents?tab=resumes&folder=edited';

/**
 * v1.5 W (decision 3): /resumes/<id>/edit, the one address for "Edit" on any resume (TailorIT's Documents and the
 * extension open it after their confirm). A built resume opens in the editor; an upload opens its editable copy; an
 * upload with none shows this page while TailorIT's AI makes the copy, then opens the editor on it. The address is
 * replaced by the editor's, so Back from the editor returns where the person came from.
 */
export function ResumeEditRoute({ resumeId }: { resumeId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  // One ask per visit and per Try again (the API follows a copy already being made, so a second ask starts nothing).
  const target = useQuery({
    queryKey: ['resumes', 'edit-target', resumeId, attempt],
    queryFn: () => fetchEditTarget(resumeId),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const taskId = target.data?.taskId ?? null;
  const task = useAiTask(taskId, { kind: 'resume_import' });
  const copyId = taskId && task.isSucceeded ? readImportResult(task.task?.result) : null;
  const phase = editRoutePhase({ target: target.data, error: target.error, task, copyId });

  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (phase.kind !== 'opening' || opened.current === phase.resumeId) return;
    opened.current = phase.resumeId;
    if (copyId) void queryClient.invalidateQueries({ queryKey: resumeKeys.all });
    router.replace(resumeEditorHref(phase.resumeId));
  }, [phase, copyId, queryClient, router]);

  const label = target.data?.label || 'Resume';
  return (
    <>
      <EditorBar name={label} documentsHref={RESUMES_TAB_HREF} />
      <EditRouteView
        phase={phase}
        label={target.data?.label ?? null}
        fileHref={target.data?.kind === 'uploaded' ? resumeFileHref(resumeId, true) : null}
        onRetry={() => setAttempt((current) => current + 1)}
      />
    </>
  );
}

/** The page's body for each phase (drawn statically in the tests). */
export function EditRouteView({
  phase,
  label,
  fileHref,
  onRetry,
}: {
  phase: EditRoutePhase;
  label: string | null;
  /** An upload's own file (to open instead); null for a built resume. */
  fileHref: string | null;
  onRetry: () => void;
}) {
  const back = (
    <Link href={RESUMES_TAB_HREF} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
      Back to Documents
    </Link>
  );
  let body;
  if (phase.kind === 'missing') {
    body = (
      <Notice tone="warning" title="That resume was not found" action={back}>
        It may have been deleted.
      </Notice>
    );
  } else if (phase.kind === 'failed') {
    body = (
      <Notice
        tone="error"
        title="The editable copy could not be made"
        action={
          <div className="flex flex-wrap gap-2">
            {phase.retry && (
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            )}
            {fileHref && (
              <a href={fileHref} target="_blank" rel="noopener" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                <ArrowSquareOutIcon size={14} aria-hidden="true" />
                Open the file
              </a>
            )}
            {back}
          </div>
        }
      >
        {phase.message}
      </Notice>
    );
  } else {
    const making = phase.kind === 'making';
    const title = phase.kind === 'starting' ? 'Opening your resume' : making ? 'Making an editable copy' : 'Opening the editor';
    const line =
      phase.kind === 'starting'
        ? 'Checking whether this resume can be edited as it is...'
        : making
          ? (phase.message ?? 'Reading your resume...')
          : 'Your resume is ready. Opening it in the editor...';
    body = (
      <section
        aria-labelledby="edit-route-title"
        aria-busy="true"
        className="rounded-card border border-border bg-surface p-6 text-center shadow-card sm:p-10"
        data-edit-route={phase.kind}
      >
        <span aria-hidden="true" className="mx-auto flex size-14 items-center justify-center rounded-card bg-primary-soft text-primary">
          {making ? <SparkleIcon size={26} weight="fill" /> : <Spinner size={24} />}
        </span>
        <h1 id="edit-route-title" className="mt-5 font-display text-xl leading-7 font-semibold text-foreground">
          {title}
        </h1>
        {making && (
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            {label ? (
              <>
                TailorIT&apos;s AI is reading <span className="font-medium text-foreground [overflow-wrap:anywhere]">{label}</span> into a
                resume you can edit. The uploaded file stays as it is.
              </>
            ) : (
              "TailorIT's AI is reading your file into a resume you can edit. The uploaded file stays as it is."
            )}{' '}
            This can take a little while; the editor opens by itself when the copy is ready.
          </p>
        )}
        <div
          role="progressbar"
          aria-label={making ? 'Making the editable copy' : 'Opening the resume'}
          aria-valuetext={line}
          className="mx-auto mt-6 h-2 w-full max-w-sm overflow-hidden rounded-[3px] bg-surface-muted ring-1 ring-border ring-inset"
        >
          <div className="h-full w-full rounded-[3px] bg-[linear-gradient(90deg,transparent_0%,var(--color-primary)_40%,var(--color-primary)_60%,transparent_100%)] bg-[length:200%_100%] motion-safe:animate-shimmer motion-reduce:bg-primary" />
        </div>
        <p className="mt-3 text-[13px] leading-5 text-muted-foreground" aria-live="polite">
          {line}
        </p>
        {making && (
          <p className="mt-6 text-[13px] leading-5 text-muted-foreground">
            You can leave this page: the copy keeps being made, and it appears in{' '}
            <Link href={EDITED_FOLDER_HREF} className="font-medium text-primary-ink underline underline-offset-2">
              Edited resumes
            </Link>
            .
          </p>
        )}
      </section>
    );
  }
  return <main className={clsx('mx-auto w-full max-w-xl pt-12 pb-16 sm:pt-16', PAGE_GUTTER)}>{body}</main>;
}
