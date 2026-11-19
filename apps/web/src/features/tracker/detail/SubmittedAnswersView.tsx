import { PaperclipIcon } from '@phosphor-icons/react/Paperclip';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/PaperPlaneTilt';
import { formatMediumDate, type SubmittedAnswer, type SubmittedAnswersResponse } from '@tailorit/shared';
// Relative, not '@/': the web tests (node, no alias) draw this view.
import { EmptyState } from '../../../components/ui/EmptyState';

// v1.3 A: "Submitted answers", the questions of the application's form as the person submitted it through the TailorIT
// extension, with their answers and the date: read-only, the person's own (GET /api/applications/:id/submitted-answers).
// The hand-edited list stays the Questions tab's. This file draws the answers read; SubmittedAnswersTab.tsx reads them.

/** A run of questions in one section of one step, in form order. */
interface AnswerGroup {
  key: string;
  step: number;
  section: string;
  items: SubmittedAnswer[];
}

/** The answers grouped as the form showed them: consecutive questions of one step and section together. */
export function groupAnswers(items: readonly SubmittedAnswer[]): AnswerGroup[] {
  const groups: AnswerGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.step === item.step && last.section === item.section) last.items.push(item);
    else groups.push({ key: `${groups.length}-${item.step}-${item.section}`, step: item.step, section: item.section, items: [item] });
  }
  return groups;
}

function AnswerText({ answer }: { answer: SubmittedAnswer['answer'] }) {
  if (answer === null) return <span className="text-muted-foreground italic">Not answered</span>;
  switch (answer.kind) {
    case 'text':
      return <span className="break-words whitespace-pre-wrap">{answer.text}</span>;
    case 'options':
      return <span>{answer.labels.join(', ')}</span>;
    case 'checked':
      return <span>{answer.checked ? 'Checked' : 'Not checked'}</span>;
    case 'file':
      return (
        <span className="inline-flex items-center gap-1.5">
          <PaperclipIcon size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <span className="break-all">Attached a file: {answer.fileName}</span>
        </span>
      );
  }
}

/** The tab's body for the answers read (no request of its own: the tab below reads them). */
export function SubmittedAnswersView({ data }: { data: SubmittedAnswersResponse }) {
  if (data.items.length === 0) {
    return (
      <div className="rounded-control border border-dashed border-border">
        <EmptyState
          size="sm"
          icon={<PaperPlaneTiltIcon size={20} />}
          title="No answers stored for this application yet."
          description="Shown once you apply with the extension."
        />
      </div>
    );
  }
  const groups = groupAnswers(data.items);
  const steps = new Set(data.items.map((item) => item.step)).size > 1;
  return (
    <section aria-labelledby="submitted-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="submitted-heading" className="text-base font-semibold text-foreground">
          Submitted answers
        </h3>
        {data.submittedAt && (
          <p className="text-sm text-muted-foreground">
            Submitted <time dateTime={data.submittedAt}>{formatMediumDate(data.submittedAt)}</time>
          </p>
        )}
      </div>
      {groups.map((group) => {
        const heading = [steps ? `Step ${group.step + 1}` : '', group.section].filter(Boolean).join(' · ');
        return (
          <section
            key={group.key}
            aria-label={heading || 'Questions'}
            className="flex flex-col gap-3 rounded-control border border-border bg-surface p-4"
          >
            {heading && <h4 className="text-sm font-semibold text-foreground">{heading}</h4>}
            <dl className="flex flex-col gap-3">
              {group.items.map((item) => (
                <div key={item.questionId} className="flex flex-col gap-0.5">
                  <dt className="text-sm font-medium text-muted-foreground">
                    {item.label}
                    {item.required && (
                      <>
                        <span aria-hidden="true" className="text-danger">
                          {' '}
                          *
                        </span>
                        <span className="sr-only"> (required)</span>
                      </>
                    )}
                  </dt>
                  <dd className="text-sm text-foreground">
                    <AnswerText answer={item.answer} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </section>
  );
}
