'use client';

import { AUTOFILL_SAVED_ANSWER_LIMITS, type AutofillSavedAnswer } from '@tailorit/shared/autofill';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { HelpTip } from '@/components/ui/HelpTip';
import { PlusIcon, TrashIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Input, Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { ApiError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { saveSavedAnswer } from '../api';
import { bodyOf, editOf, scopeLabel, takesSeveral, validateEdit, type AnswerEdit } from './answers';

const { text: TEXT_MAX, labels: LABELS_MAX, label: LABEL_MAX } = AUTOFILL_SAVED_ANSWER_LIMITS;

/**
 * Edits one saved answer: a written answer's text, the options chosen (as the form writes them), or whether the box
 * is ticked. The question, its choices and where the answer is used stay as the form had them, so the save replaces
 * this answer under the same key.
 */
export function EditAnswerDialog({
  answer,
  onClose,
  onSaved,
}: {
  answer: AutofillSavedAnswer;
  onClose: () => void;
  onSaved: (saved: AutofillSavedAnswer) => void;
}) {
  const [edit, setEdit] = useState<AnswerEdit>(() => editOf(answer));
  // Problems show once a save was tried, then follow each change.
  const [tried, setTried] = useState(false);
  const { t } = usePublicConstants();
  const tooLong = (max: number) => t('MSG_TEXT_TOO_LONG', { max });
  const problems = tried ? validateEdit(answer, edit, tooLong) : {};

  const save = useMutation({
    mutationFn: () => saveSavedAnswer(bodyOf(answer, edit)),
    onSuccess: onSaved,
  });
  const serverProblem = save.error ? userMessage(save.error) : null;
  const fields = save.error instanceof ApiError ? save.error.fields : undefined;
  const serverField = fields?.['answer.text'] ?? fields?.['answer.labels'] ?? null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(validateEdit(answer, edit, tooLong)).length === 0) save.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent
        title="Edit saved answer"
        description={answer.questionLabel}
        help="Given to forms with this question and the same choices."
        size="lg"
      >
        <form onSubmit={submit} noValidate className="mt-5 flex flex-col gap-4">
          <p className="text-[13px] leading-5 text-muted-foreground">{scopeLabel(answer)}</p>
          {edit.kind === 'text' && (
            <Field label="Your answer" error={problems.text ?? serverField ?? undefined}>
              <Textarea
                value={edit.text}
                rows={7}
                maxLength={TEXT_MAX}
                onChange={(event) => setEdit({ kind: 'text', text: event.target.value })}
              />
              {/* A count stays in sight (v32 COPY: a hint is a "?", a value is not). */}
              <p className="num text-[13px] leading-5 text-muted-foreground" data-answer-count="">
                {`${edit.text.length.toLocaleString('en-US')} of ${TEXT_MAX.toLocaleString('en-US')} characters`}
              </p>
            </Field>
          )}
          {edit.kind === 'checked' && (
            <Checkbox
              label="Tick this box on the form"
              checked={edit.checked}
              onCheckedChange={(checked) => setEdit({ kind: 'checked', checked })}
            />
          )}
          {edit.kind === 'options' && (
            <OptionsEditor
              labels={edit.labels}
              several={takesSeveral(answer)}
              error={problems.labels ?? serverField ?? undefined}
              onChange={(labels) => setEdit({ kind: 'options', labels })}
            />
          )}
          {serverProblem && !serverField && <Notice tone="error">{serverProblem}</Notice>}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save answer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The options chosen, each written exactly as the form shows it: one box, or a list for a multiple choice. */
function OptionsEditor({
  labels,
  several,
  error,
  onChange,
}: {
  labels: string[];
  several: boolean;
  error: string | undefined;
  onChange: (labels: string[]) => void;
}) {
  const hint = 'Exactly as the form shows it.';
  if (!several) {
    return (
      <Field label="The option to choose" error={error} hint={hint}>
        <Input value={labels[0] ?? ''} maxLength={LABEL_MAX} onChange={(event) => onChange([event.target.value])} />
      </Field>
    );
  }
  const rows = labels.length > 0 ? labels : [''];
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="The options to choose">
      <span className="flex items-center gap-1.5">
        <span className="text-sm leading-5 font-medium text-foreground">The options to choose</span>
        <HelpTip label="The options to choose">{hint}</HelpTip>
      </span>
      {rows.map((label, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Option ${index + 1}`}
            value={label}
            maxLength={LABEL_MAX}
            onChange={(event) => onChange(rows.map((other, at) => (at === index ? event.target.value : other)))}
          />
          <IconButton
            label={`Remove option ${index + 1}`}
            tooltip="Remove"
            icon={<TrashIcon size={16} />}
            disabled={rows.length === 1}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          />
        </div>
      ))}
      {error ? <p className="text-[13px] leading-5 text-danger">{error}</p> : null}
      <div>
        <Button
          variant="outline"
          size="sm"
          icon={<PlusIcon size={16} />}
          disabled={rows.length >= LABELS_MAX}
          onClick={() => onChange([...rows, ''])}
        >
          Add an option
        </Button>
      </div>
    </div>
  );
}
