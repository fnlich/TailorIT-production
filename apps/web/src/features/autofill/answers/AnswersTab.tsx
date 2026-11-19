'use client';

import { ChatsIcon } from '@phosphor-icons/react/Chats';
import type { AutofillSavedAnswer, AutofillSavedAnswerList } from '@tailorit/shared/autofill';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { MagnifyingGlassIcon, PencilSimpleIcon, TrashIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { autofillKeys, deleteSavedAnswer, fetchSavedAnswers } from '../api';
import { Section } from '../Section';
import { answerSummary, filterAnswers, platformName, scopeLabel } from './answers';
import { EditAnswerDialog } from './EditAnswerDialog';

const DESCRIPTION = 'Answers the extension reuses when a form asks the same question.';

/** Past this many answers the list gets a search box. */
const SEARCH_FROM = 6;

/**
 * Settings › Autofill › Saved answers: the answers the extension saved when the person fixed or filled a question it
 * flagged, which it gives again the next time a form asks the same question with the same choices. Each can be edited
 * (the answer only: its question and choices are the form's) or deleted.
 */
export function AnswersTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<AutofillSavedAnswer | null>(null);
  const [deleting, setDeleting] = useState<AutofillSavedAnswer | null>(null);

  const answers = useQuery({ queryKey: autofillKeys.answers, queryFn: ({ signal }) => fetchSavedAnswers(signal) });
  const items = answers.data?.items ?? [];
  const shown = filterAnswers(items, query);

  /** The list with one answer replaced (an edit) or taken out (a delete). */
  const update = (id: string, next: AutofillSavedAnswer | null) =>
    queryClient.setQueryData<AutofillSavedAnswerList>(autofillKeys.answers, (previous) => {
      if (!previous) return previous;
      const kept = previous.items.filter((item) => item.id !== id);
      const list = next ? [next, ...kept] : kept;
      return { ...previous, items: list, total: list.length };
    });

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Saved answers"
        description={DESCRIPTION}
        action={
          answers.data && items.length > 0 ? (
            <span className="num shrink-0 text-[13px] leading-5 text-muted-foreground">
              {items.length} of {answers.data.limit}
            </span>
          ) : undefined
        }
      >
        {answers.isError ? (
          <Notice
            tone="error"
            title="Your saved answers didn't load."
            action={
              <Button variant="outline" size="sm" onClick={() => void answers.refetch()}>
                Try again
              </Button>
            }
          >
            {userMessage(answers.error)}
          </Notice>
        ) : answers.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading your saved answers">
            <Skeleton className="h-16 w-full" rounded="control" />
            <Skeleton className="h-16 w-full" rounded="control" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ChatsIcon size={24} />}
            title="No saved answers yet"
            description="Answer a flagged question on a form to save it here."
            variant="dashed"
            size="md"
          />
        ) : (
          <div className="flex flex-col gap-4">
            {items.length >= SEARCH_FROM && (
              <Input
                type="search"
                aria-label="Search saved answers"
                placeholder="Search saved answers"
                leading={<MagnifyingGlassIcon size={16} />}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            )}
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No saved answer matches “{query.trim()}”.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border" aria-label="Saved answers">
                {shown.map((item) => (
                  <AnswerRow
                    key={item.id}
                    item={item}
                    now={now}
                    onEdit={() => setEditing(item)}
                    onDelete={() => setDeleting(item)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>

      {editing && (
        <EditAnswerDialog
          answer={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            update(editing.id, saved);
            setEditing(null);
            toast.success('Answer saved');
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this saved answer?"
        description="The extension will leave this question for you."
        confirmLabel="Delete"
        busyLabel="Deleting..."
        onConfirm={async () => {
          if (!deleting) return;
          const { id } = deleting;
          try {
            await deleteSavedAnswer(id);
          } catch (error) {
            // Already gone (deleted in another tab): the list just catches up.
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
          update(id, null);
          toast.success('Saved answer deleted');
        }}
      />
    </div>
  );
}

function AnswerRow({
  item,
  now,
  onEdit,
  onDelete,
}: {
  item: AutofillSavedAnswer;
  now: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5 font-semibold break-words text-foreground">{item.questionLabel}</p>
        <p className="mt-1 text-sm leading-5 break-words text-foreground">{answerSummary(item.answer)}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-muted-foreground">
          <Badge tone={item.scope ? 'tint' : 'outline'}>{scopeLabel(item)}</Badge>
          <span>
            {item.platform ? `Saved on ${platformName(item.platform)} · ` : ''}Updated{' '}
            {relativeTime(item.updatedAt, now)}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label={`Edit your answer to ${item.questionLabel}`}
          tooltip="Edit"
          icon={<PencilSimpleIcon size={16} />}
          onClick={onEdit}
        />
        <IconButton
          label={`Delete your answer to ${item.questionLabel}`}
          tooltip="Delete"
          icon={<TrashIcon size={16} />}
          onClick={onDelete}
        />
      </div>
    </li>
  );
}
