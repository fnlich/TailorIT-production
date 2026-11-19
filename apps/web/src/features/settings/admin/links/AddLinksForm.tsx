'use client';

import type { QueuedLinks } from '@tailorit/shared/jobs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { reviewKeys } from '../review/api';
import { REASON_ADMIN_TEXT } from '../review/unverified';
import { addLinks } from './api';
import { LinkProgress } from './LinkProgress';
import { EMPTY_PASTE_TEXT, linksText, parseLinks, pasteProblem, queuedSummary } from './links';

// v31 ADMINWEB: an admin's Add links (D1): paste job links, one per line; TailorIT queues each for its own read (POST
// /api/admin/jobs/add) and publishes only what it reads from the link (or holds it for Review while "Approve new jobs
// by hand" is on). Nothing typed here becomes a job's words. The answer says what was queued, repeated or refused, and
// the batch's progress follows. Used by Admin › Import links (Paste links) and the Admin page's Add links dialog.

export interface AddLinksFormProps {
  /** Places the submit button: the dialog's footer (with Close), or the tab's own row. */
  actions: (submit: ReactNode) => ReactNode;
  /** The textarea's name (two forms can be on one page: the tab's and the dialog's). */
  label?: string;
  /** The actions after the answer (a dialog's footer is its last row), not right under the box (the tab). */
  actionsLast?: boolean;
}

export function AddLinksForm({ actions, label = 'Job links', actionsLast = false }: AddLinksFormProps) {
  const queryClient = useQueryClient();
  const formId = useId();
  const { get, t } = usePublicConstants();
  const max = get('ADMIN_ADD_LINKS_MAX');
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [answer, setAnswer] = useState<QueuedLinks | null>(null);
  const links = parseLinks(text);
  const problem = pasteProblem(links.length, max);
  const problemText = problem === 'too_many' ? t('MSG_JOB_ADD_TOO_MANY_LINKS', { max }) : problem === 'empty' ? EMPTY_PASTE_TEXT : null;

  const add = useMutation({
    mutationFn: (urls: string[]) => addLinks(urls),
    onSuccess: (queued) => {
      setAnswer(queued);
      setText('');
      setTouched(false);
      // A link that cannot be read lands in Review's lists; their counts are read again.
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    add.mutate(links);
  };

  const submitButton = (
    <Button type="submit" form={formId} loading={add.isPending} disabled={problem === 'too_many'} data-add-links-submit="">
      {links.length > 0 ? `Add ${linksText(links.length)}` : 'Add the links'}
    </Button>
  );

  return (
    <div className="flex flex-col gap-5" data-add-links="">
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-3">
        <Field
          label={label}
          // The limit's words are the constant's (MSG_JOB_ADD_TOO_MANY_LINKS, with ADMIN_ADD_LINKS_MAX).
          hint={`One per line; only each link is kept. ${t('MSG_JOB_ADD_TOO_MANY_LINKS', { max })}`}
          error={touched || problem === 'too_many' ? (problemText ?? undefined) : undefined}
        >
          <Textarea
            rows={6}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="One job link per line: https://..."
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <p className="text-[13px] leading-5 text-muted-foreground" aria-live="polite" data-add-links-count="">
          {links.length === 0 ? 'No links yet.' : `${linksText(links.length)} to add.`}
        </p>
        {!actionsLast && actions(submitButton)}
      </form>
      {add.isError && <Notice tone="error">{userMessage(add.error)}</Notice>}
      {answer && (
        <div className="flex flex-col gap-4" data-add-links-answer={answer.batchId}>
          <Notice tone={answer.queued > 0 ? 'success' : 'info'} title={answer.queued > 0 ? 'Links queued' : 'Nothing new to read'}>
            {queuedSummary(answer)}
          </Notice>
          {answer.refused.length > 0 && (
            <div>
              <p className="text-[13px] leading-5 font-medium text-foreground">Not added</p>
              <ul className="mt-1 flex flex-col gap-1 text-[13px] leading-5" data-add-links-refused="">
                {answer.refused.map((item) => (
                  <li key={item.url} className="break-all text-muted-foreground">
                    <span className="text-foreground">{item.url}</span>: {REASON_ADMIN_TEXT[item.reason]}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {answer.queued > 0 && <LinkProgress batchId={answer.batchId} />}
        </div>
      )}
      {actionsLast && actions(submitButton)}
    </div>
  );
}
