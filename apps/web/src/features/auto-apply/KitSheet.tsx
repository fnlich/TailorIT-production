'use client';

import type { QueuePaneItem } from '@tailorit/shared/prepare';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ArrowSquareOutIcon, CopyIcon, DownloadSimpleIcon, PencilSimpleIcon } from '@/components/ui/icons';
import { userMessage } from '@/lib/api';
import { DetailStep, RowDetailSheet } from '../../components/queue';
import { fetchApplicationDraft, prepareKeys } from '../prepare/api';
import { RESUME_MODE_SHORT, noAnswersText, noLetterText } from '../prepare/copy';
import { autoApplyKeys, fetchKit } from './api';
import { postingHref } from './copy';

// v2.0: the manual flow's kit sheet (docs/design/v2.0/08-ui.md, "The manual flow: the kit sheet"): numbered steps to
// open the job page, take the prepared resume (and which one it is, v20 A29), copy or download the letter, copy each
// prepared answer, then Mark as applied. Opened by View kit, a kit line, or Open job page on a manual row (the
// posting opens in a new tab and the sheet beside it). The kit is frozen when the job was queued (A30).

/** Copies `text`; when the clipboard is refused, selects the text in `fallback` so the person can copy it by hand. */
export async function copyText(text: string, fallback: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallback) {
      if (fallback instanceof HTMLTextAreaElement) {
        fallback.focus();
        fallback.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(fallback);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    return false;
  }
}

/** Whether a row's kit offers Mark as applied: a manual row, or a run that failed or needs the person. */
export const offersMarkApplied = (item: Pick<QueuePaneItem, 'display'>) =>
  item.display === 'manual' || item.display === 'failed' || item.display === 'needs_you';

export interface KitSheetProps {
  /** The row whose kit is shown (kept while the sheet slides out). */
  item: QueuePaneItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMarkApplied: (item: QueuePaneItem) => void;
}

/** v30 ST5: on components/queue's RowDetailSheet (its title wraps on a phone, v2.0 fix UX-16) and its DetailStep. */
export function KitSheet({ item, open, onOpenChange, onMarkApplied }: KitSheetProps) {
  return (
    <RowDetailSheet
      item={item}
      open={open}
      onOpenChange={onOpenChange}
      title={(row) => `${row.title} at ${row.company}`}
      description="Ready to copy."
      className="sm:max-w-120!"
    >
      {(row) => <KitBody item={row} onMarkApplied={onMarkApplied} />}
    </RowDetailSheet>
  );
}

/**
 * How many of the job's questions TailorIT knows, from the application's kit (GET /api/applications/:id/draft, the
 * Tracker's Prepared tab's read): null while it is read, when it could not be, and for a row with no application.
 */
function useQuestionsKnown(applicationId: string | null): number | null {
  const draft = useQuery({
    queryKey: prepareKeys.draft(applicationId ?? ''),
    queryFn: ({ signal }) => fetchApplicationDraft(applicationId ?? '', signal),
    enabled: applicationId !== null,
    retry: false,
  });
  if (!draft.data) return null;
  return draft.data.draft?.answers.questionsKnown ?? draft.data.answers.length;
}

export function KitBody({ item, onMarkApplied }: { item: QueuePaneItem; onMarkApplied: (item: QueuePaneItem) => void }) {
  const toast = useToast();
  const kit = useQuery({ queryKey: autoApplyKeys.kit(item.queueId), queryFn: ({ signal }) => fetchKit(item.queueId, signal) });
  // v2.0 fix (UX-4): "No cover letter needed" only when TailorIT knew the job's questions.
  const questionsKnown = useQuestionsKnown(item.applicationId);
  const letterRef = useRef<HTMLTextAreaElement>(null);
  const answerRefs = useRef(new Map<number, HTMLElement>());

  const copy = async (text: string, fallback: HTMLElement | null) => {
    if (await copyText(text, fallback)) toast.success('Copied');
    else toast.info('Copy it by hand', 'Your browser kept the clipboard closed. The text is selected: press Ctrl+C (⌘C on a Mac).');
  };

  if (kit.isError) {
    return (
      <Notice
        tone="error"
        title="This kit didn't load."
        action={
          <Button variant="outline" size="sm" onClick={() => void kit.refetch()}>
            Try again
          </Button>
        }
      >
        {userMessage(kit.error)}
      </Notice>
    );
  }
  if (!kit.data) {
    return (
      <div aria-busy="true" aria-label="Loading the kit" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-48" rounded="control" />
        <Skeleton className="h-16 w-full" rounded="control" />
        <Skeleton className="h-40 w-full" rounded="control" />
        <Skeleton className="h-24 w-full" rounded="control" />
      </div>
    );
  }
  const { resume, letter, answers } = kit.data;
  const href = postingHref(kit.data.postingUrl) ?? postingHref(item.url);
  return (
    <ol className="flex flex-col gap-6" aria-label="Apply by hand, step by step" data-kit-sheet={item.queueId}>
      <DetailStep number={1} title="Open the job page">
        {href ? (
          <>
            <a href={href} target="_blank" rel="noopener" className={buttonClasses({ variant: 'primary', className: 'self-start' })}>
              Open the job page
              <ArrowSquareOutIcon size={14} aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <p className="text-[13px] leading-5 break-all text-muted-foreground">{href}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">This job has no web address to open.</p>
        )}
      </DetailStep>

      <DetailStep number={2} title="Resume">
        {resume ? (
          <div className="flex flex-col gap-2 rounded-control border border-border p-3" data-kit-resume="">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              <span className="min-w-0 break-words">{resume.title}</span>
              {resume.resumeMode && <Badge tone="tint">{RESUME_MODE_SHORT[resume.resumeMode]}</Badge>}
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href={resume.downloadUrl}
                download
                className={buttonClasses({ variant: 'outline', size: 'sm' })}
                aria-label={`Download ${resume.title} as a PDF`}
              >
                <DownloadSimpleIcon size={14} aria-hidden="true" />
                Download PDF
              </a>
              <Link
                href={`/resumes/${encodeURIComponent(resume.id)}`}
                className={buttonClasses({ variant: 'outline', size: 'sm' })}
                aria-label={`Open ${resume.title} in the editor`}
              >
                <PencilSimpleIcon size={14} aria-hidden="true" />
                Open in editor
              </Link>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">The prepared resume was deleted. Prepare &amp; Queue it again.</p>
        )}
      </DetailStep>

      <DetailStep number={3} title="Cover letter">
        {letter ? (
          <div className="flex flex-col gap-2" data-kit-letter="">
            <label htmlFor={`letter-${item.queueId}`} className="sr-only">
              Cover letter text
            </label>
            <textarea
              id={`letter-${item.queueId}`}
              ref={letterRef}
              readOnly
              value={letter.text}
              rows={8}
              className="w-full resize-y rounded-control border border-border bg-surface-low px-3 py-2 text-sm leading-5 text-foreground"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                icon={<CopyIcon size={14} />}
                onClick={() => void copy(letter.text, letterRef.current)}
                aria-label="Copy the cover letter"
              >
                Copy
              </Button>
              <a href={letter.downloadUrl} download className={buttonClasses({ variant: 'outline', size: 'sm' })} aria-label="Download the cover letter">
                <DownloadSimpleIcon size={14} aria-hidden="true" />
                Download
              </a>
            </div>
          </div>
        ) : (
          <p className="text-sm text-foreground" data-kit-letter="none">
            {noLetterText(questionsKnown)}{' '}
            {item.applicationId && (
              <Link
                href={`/cover-letter/new?applicationId=${encodeURIComponent(item.applicationId)}`}
                className="font-semibold text-primary-ink underline-offset-2 hover:underline"
              >
                Write one now
              </Link>
            )}
          </p>
        )}
      </DetailStep>

      <DetailStep number={4} title="Answers">
        {answers.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-kit-answers="none">
            {noAnswersText(questionsKnown)}
          </p>
        ) : (
          <dl className="flex flex-col gap-3" data-kit-answers="">
            {answers.map((answer, index) => (
              <div key={`${index}-${answer.label}`} className="flex flex-col gap-1.5 rounded-control border border-border p-3">
                <dt className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  <span className="min-w-0 break-words">{answer.label}</span>
                  {answer.required && <Badge tone="neutral">Required</Badge>}
                </dt>
                <dd className="flex flex-col gap-2">
                  {answer.answerText ? (
                    <>
                      <p
                        ref={(node) => {
                          if (node) answerRefs.current.set(index, node);
                          else answerRefs.current.delete(index);
                        }}
                        className="text-sm leading-5 break-words whitespace-pre-wrap text-foreground"
                      >
                        {answer.answerText}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        icon={<CopyIcon size={14} />}
                        aria-label={`Copy answer to: ${answer.label}`}
                        onClick={() => void copy(answer.answerText, answerRefs.current.get(index) ?? null)}
                      >
                        Copy
                      </Button>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Not prepared: answer this one on the form.</p>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="text-[13px] leading-5 text-muted-foreground">Questions about you come from your autofill profile.</p>
      </DetailStep>

      {offersMarkApplied(item) && (
        <DetailStep number={5} title="Mark as applied">
          <span className="flex items-center gap-1.5 self-start">
            <Button onClick={() => onMarkApplied(item)}>Mark as applied</Button>
            <HelpTip label="Mark as applied">Once you have sent it on the employer&apos;s site.</HelpTip>
          </span>
        </DetailStep>
      )}
    </ol>
  );
}
