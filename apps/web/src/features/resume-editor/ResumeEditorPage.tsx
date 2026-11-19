'use client';

import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { EditorBar } from '@/components/shell/EditorBar';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { buttonClasses } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { PageSpinner } from '@/components/ui/Spinner';
import { ApiError, userMessage } from '@/lib/api';
import { RESUMES_TAB_HREF, fetchResume, resumeKeys } from './api';
import { UploadedResumeView } from './UploadedResumeView';
import { NewResumeWorkspacePage, ResumeWorkspacePage } from './workspace/ResumeWorkspacePage';

/**
 * The resume pages (Enhancv's editor): /resumes/new is a new resume (the template chooser, then a blank page on the
 * template picked), /resumes/[id] a stored one. An uploaded file gets its own page: it is kept as uploaded, not a
 * document the editor writes. Every built resume opens in the editor, one made by the retired form editor too: the
 * server upgrades it as it is read, and it is stored in the editor's format only once it is changed.
 */
export function ResumeEditorPage({ resumeId }: { resumeId: string | null }) {
  return resumeId ? <StoredResume id={resumeId} /> : <NewResumeWorkspacePage />;
}

function StoredResume({ id }: { id: string }) {
  // Read afresh every time the page opens (gcTime 0): an upload's page and its reading are never from before a change.
  const query = useQuery({
    queryKey: resumeKeys.detail(id),
    queryFn: ({ signal }) => fetchResume(id, signal),
    gcTime: 0,
    staleTime: Infinity,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
  });

  if (query.isPending) {
    return (
      <>
        <EditorBar name="Resume" documentsHref={RESUMES_TAB_HREF} />
        <PageSpinner label="Loading the resume..." />
      </>
    );
  }
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <>
        <EditorBar name="Resume" documentsHref={RESUMES_TAB_HREF} />
        <main className={clsx('mx-auto w-full max-w-xl pt-16', PAGE_GUTTER)}>
          <Notice
            tone={missing ? 'warning' : 'error'}
            title={missing ? 'That resume was not found' : "This resume didn't load."}
            action={
              <Link href={RESUMES_TAB_HREF} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                Back to Documents
              </Link>
            }
          >
            {missing ? 'It may have been deleted.' : userMessage(query.error, 'Please try again in a moment.')}
          </Notice>
        </main>
      </>
    );
  }
  const resume = query.data;
  if (resume.kind === 'uploaded') return <UploadedResumeView resume={resume} />;
  // A resume the editor stored is opened from this read as it is; only an older one is read again, upgraded.
  const opened =
    resume.onPageEditor && resume.document && resume.documentRevision !== null
      ? { id: resume.id, label: resume.label, title: resume.title, documentRevision: resume.documentRevision, document: resume.document }
      : undefined;
  return <ResumeWorkspacePage key={resume.id} resumeId={resume.id} opened={opened} />;
}
