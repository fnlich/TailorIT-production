import { FileTextIcon } from '@phosphor-icons/react/FileText';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/PaperPlaneTilt';
import { SparkleIcon } from '@phosphor-icons/react/Sparkle';
import Link from 'next/link';
import { formatMediumDate, type ApplyRecord } from '@tailorit/shared';
import type { ApplicationDraftAnswer, ApplicationDraftResponse, PreparePartStatus } from '@tailorit/shared/prepare';
// Relative, not '@/': the web tests draw this view.
import { Badge } from '../../../components/ui/Badge';
import { Button, buttonClasses } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { ANSWER_STATE_TEXT, QUESTIONS_UNKNOWN, RESUME_MODE_SHORT, partLine, preparedByText } from '../../prepare/copy';
import { appliedWithText } from '../draft';

// v2.0: the Tracker's "Prepared" tab (v1.5's "Draft" tab): the application's kit, as Prepare & Queue made it and the
// queue froze it (A30): the resume it uses (Tailored, Default resume or Best-matched resume, A29), the cover letter,
// each with Preview and Edit, and every known question of the job with its answer (Ready, Not prepared: answered on
// the form, From your autofill profile). Above it, once applied, "Applied with": what each application was
// actually sent with (the apply records). This file draws what DraftTab.tsx reads.

const STATE_TONE: Record<ApplicationDraftAnswer['state'], 'success' | 'warning' | 'neutral'> = {
  ready: 'success',
  not_ready: 'warning',
  profile: 'neutral',
};

function AnswerText({ answer }: { answer: ApplicationDraftAnswer['answer'] }) {
  if (answer === null) return null;
  switch (answer.kind) {
    case 'text':
      return <span className="break-words whitespace-pre-wrap">{answer.text}</span>;
    case 'options':
      return <span>{answer.labels.join(', ')}</span>;
    case 'checked':
      return <span>{answer.checked ? 'Checked' : 'Not checked'}</span>;
    case 'file':
      return null;
  }
}

/** A document of the kit: its name with Preview and Edit when it is ready, else what became of it. */
function DocumentRow({
  kind,
  label,
  title,
  status,
  editHref,
  onPreview,
  questionsKnown,
}: {
  kind: 'resume' | 'letter';
  /** The small line above the name ("Resume · Tailored", "Cover letter"). */
  label: string;
  title: string | null;
  status: PreparePartStatus;
  editHref: string | null;
  onPreview: () => void;
  /** How many of the job's questions TailorIT knows (a letter that was not made says why). */
  questionsKnown: number;
}) {
  const what = kind === 'resume' ? 'resume' : 'cover letter';
  const ready = status === 'ready' && editHref !== null;
  return (
    <li className="flex flex-col gap-3 rounded-control border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center" data-draft-document={kind}>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-container text-primary-ink">
          <FileTextIcon size={18} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs leading-4 text-muted-foreground">{label}</span>
          <span className="block truncate text-sm leading-5 font-semibold text-foreground">
            {ready ? (title ?? (kind === 'resume' ? 'Resume' : 'Cover letter')) : partLine(kind, status, questionsKnown)}
          </span>
        </span>
      </span>
      {ready && (
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={onPreview} aria-label={`Preview the ${what}`}>
            Preview
          </Button>
          <Link href={editHref} className={buttonClasses({ variant: 'outline', size: 'sm' })} aria-label={`Edit the ${what}`}>
            Edit
          </Link>
        </span>
      )}
    </li>
  );
}

/** "Applied with": each application's record, newest first. */
export function AppliedWith({ records }: { records: readonly ApplyRecord[] }) {
  if (records.length === 0) return null;
  return (
    <section aria-labelledby="applied-with-heading" className="flex flex-col gap-2 rounded-control border border-border bg-surface p-4" data-applied-with="">
      <h3 id="applied-with-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <PaperPlaneTiltIcon size={16} aria-hidden="true" />
        Applied with
      </h3>
      <ul className="flex flex-col gap-1.5">
        {records.map((record) => (
          <li key={record.id} className="text-sm leading-5 text-foreground">
            {appliedWithText(record)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface DraftViewProps {
  data: ApplicationDraftResponse;
  /** The apply records (null while they load or when there are none to show). */
  records?: readonly ApplyRecord[] | null;
  /** v20 A30: the entry is a Draft (in the auto-apply queue with this kit). */
  draft?: boolean;
  /** Draft's words (the constant STATUS_DRAFT_LABEL). */
  draftLabel?: string;
  onPreview: (kind: 'resume' | 'letter') => void;
}

export function DraftView({ data, records = null, draft: isDraft = false, draftLabel = 'Draft', onPreview }: DraftViewProps) {
  const kit = data.draft;
  const appliedWith = records && records.length > 0 ? <AppliedWith records={records} /> : null;
  if (!kit) {
    return (
      <div className="flex flex-col gap-4">
        {appliedWith}
        <div className="rounded-control border border-dashed border-border">
          <EmptyState
            size="sm"
            icon={<SparkleIcon size={20} />}
            title="Nothing prepared for this application yet."
            description="Prepare & Queue this job on the Auto-apply page."
            action={
              <Link href="/auto-apply" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                Open Auto-apply
              </Link>
            }
          />
        </div>
      </div>
    );
  }
  const resumeHref = kit.resume.resumeId ? `/resumes/${encodeURIComponent(kit.resume.resumeId)}` : null;
  const letterHref = kit.letter.coverLetterId ? `/cover-letter/${encodeURIComponent(kit.letter.coverLetterId)}` : null;
  const when = kit.builtAt ?? kit.updatedAt;
  const resumeLabel = kit.resume.resumeMode ? `Resume · ${RESUME_MODE_SHORT[kit.resume.resumeMode]}` : 'Resume';
  return (
    <div className="flex flex-col gap-4">
      {appliedWith}
      <section aria-labelledby="draft-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 id="draft-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
            Prepared
            {isDraft && (
              <Badge tone="success" data-draft-status="">
                {draftLabel}
              </Badge>
            )}
          </h3>
          <p className="text-sm text-muted-foreground">
            {preparedByText(kit)} on{' '}
            <time dateTime={when}>{formatMediumDate(when)}</time>
          </p>
        </div>
        {isDraft && (
          <p className="text-sm leading-5 text-muted-foreground">
            In your auto-apply queue with this kit. It is used as it is when the job is applied to.
          </p>
        )}
        {kit.error && <p className="text-sm leading-5 text-[#c62a29]">{kit.error}</p>}
        <ul className="flex flex-col gap-2" aria-label="Prepared documents">
          <DocumentRow
            kind="resume"
            label={resumeLabel}
            title={data.resumeTitle}
            status={kit.resume.status}
            editHref={resumeHref}
            onPreview={() => onPreview('resume')}
            questionsKnown={kit.answers.questionsKnown}
          />
          <DocumentRow
            kind="letter"
            label="Cover letter"
            title={data.coverLetterTitle}
            status={kit.letter.status}
            editHref={letterHref}
            onPreview={() => onPreview('letter')}
            questionsKnown={kit.answers.questionsKnown}
          />
        </ul>
        <section aria-labelledby="draft-answers-heading" className="flex flex-col gap-3 rounded-control border border-border bg-surface p-4">
          <h4 id="draft-answers-heading" className="text-sm font-semibold text-foreground">
            Answers
          </h4>
          {data.answers.length === 0 ? (
            // v2.0 fix (UX-4): no "made during the application": a job applied to by hand has no automated run.
            <p className="text-sm text-muted-foreground" data-draft-answers="unknown">
              {QUESTIONS_UNKNOWN}, so no answers were prepared. TailorIT learns a job&apos;s questions when someone
              applies to it. When the extension fills the form it can answer them then; otherwise, answer them on the
              form.
            </p>
          ) : (
            <dl className="flex flex-col gap-3">
              {data.answers.map((item) => (
                <div key={item.questionId} className="flex flex-col gap-1">
                  <dt className="flex flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground">
                    <span>
                      {item.label}
                      {item.required && (
                        <>
                          <span aria-hidden="true" className="text-destructive">
                            {' '}
                            *
                          </span>
                          <span className="sr-only"> (required)</span>
                        </>
                      )}
                    </span>
                    <Badge tone={STATE_TONE[item.state]}>{ANSWER_STATE_TEXT[item.state]}</Badge>
                  </dt>
                  {item.state === 'ready' && (
                    <dd className="text-sm text-foreground">
                      <AnswerText answer={item.answer} />
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          )}
        </section>
      </section>
    </div>
  );
}
