'use client';

import { cleanCustomInstructions, type McpSettings } from '@tailorit/shared/mcp';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../../components/ui/Button';
import { Field } from '../../../components/ui/Field';
import { Textarea } from '../../../components/ui/Input';
import { Skeleton } from '../../../components/ui/Skeleton';
import { useToast } from '../../../components/ui/Toast';
import { ApiError, userMessage } from '../../../lib/api';
import { usePublicConstants } from '../../../lib/constants';
import { CharacterCount } from '../parts';
import { decidePendingInstructions, fetchMcpSettings, MCP_SETTINGS_KEY, saveMcpSettings } from './api';
import { Notice } from '../../../components/ui/Notice'; // v34 MCPDIR

// v2.0: Integrations › AI assistants › "How your AI works with TailorIT" › Custom instructions
// (docs/design/v2.0/08-ui.md, "Settings › Integrations"; 07-mcp.md): one plain text field the person's own AI gets with
// TailorIT's default instructions. The platform's rules still hold: the server applies the person's filters and limits
// whatever these say. No other MCP UI.

export const CUSTOM_INSTRUCTIONS_COPY = {
  label: 'Custom instructions',
  // v34 MCPDIR: what the person's AI asked for, waiting for their OK.
  pendingTitle: 'Your AI asked to change your custom instructions',
  pendingHint: 'Nothing changes until you approve. Your AI keeps using the instructions below until then.',
  pendingEmpty: '(clear them)',
  approve: 'Approve',
  discard: 'Discard',
  approved: 'Custom instructions updated',
  discarded: 'Request discarded',
  decideFailed: "Your choice wasn't saved",
  hint: "Added to TailorIT's instructions for your AI; your filters and limits always apply.",
  placeholder: 'For example: keep my resume to one page, and write cover letters in a warm, plain tone.',
  save: 'Save',
  saving: 'Saving...',
  saved: 'Custom instructions saved',
  saveFailed: "The custom instructions weren't saved",
} as const;

/** The text as it is saved (the server cleans it the same way): plain text, line ends as "\n", no trailing space. */
export function customInstructionsOf(text: string): string {
  return cleanCustomInstructions(text).replace(/\s+$/, '');
}

export function CustomInstructionsSetting() {
  const settings = useQuery({ queryKey: MCP_SETTINGS_KEY, queryFn: ({ signal }) => fetchMcpSettings(signal) });
  if (settings.isPending) return <Skeleton className="h-48 w-full" rounded="control" />;
  const pending = settings.data?.pendingCustomInstructions;
  // Read again after a save, so the box starts from what is stored.
  return (
    <div className="flex flex-col gap-4">
      {/* v34 MCPDIR: the person's AI asked for new custom instructions; they take effect only once approved. */}
      {pending !== undefined && <PendingInstructions text={pending} />}
      <CustomInstructionsForm key={settings.dataUpdatedAt} saved={settings.data?.customInstructions ?? ''} disabled={settings.isError} />
    </div>
  );
}

/** v34 MCPDIR: the custom instructions the person's AI asked for, with Approve and Discard. */
function PendingInstructions({ text }: { text: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'discard') => decidePendingInstructions(decision),
    onSuccess: (answer, decision) => {
      queryClient.setQueryData<McpSettings>(MCP_SETTINGS_KEY, answer);
      toast.success(decision === 'approve' ? CUSTOM_INSTRUCTIONS_COPY.approved : CUSTOM_INSTRUCTIONS_COPY.discarded);
    },
    onError: (failure) => toast.error(CUSTOM_INSTRUCTIONS_COPY.decideFailed, userMessage(failure)),
  });
  return (
    <div data-pending-instructions="">
      <Notice
        tone="warning"
        title={CUSTOM_INSTRUCTIONS_COPY.pendingTitle}
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              {CUSTOM_INSTRUCTIONS_COPY.approve}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={decide.isPending && decide.variables === 'discard'}
              disabled={decide.isPending}
              onClick={() => decide.mutate('discard')}
            >
              {CUSTOM_INSTRUCTIONS_COPY.discard}
            </Button>
          </div>
        }
      >
        <p>{CUSTOM_INSTRUCTIONS_COPY.pendingHint}</p>
        <p className="mt-2 whitespace-pre-wrap break-words rounded-control border border-border bg-surface px-3 py-2 text-foreground">
          {text || CUSTOM_INSTRUCTIONS_COPY.pendingEmpty}
        </p>
      </Notice>
    </div>
  );
}

function CustomInstructionsForm({ saved, disabled }: { saved: string; disabled: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { get, t } = usePublicConstants();
  const max = get('MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS');
  const [text, setText] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const value = customInstructionsOf(text);
  const tooLong = value.length > max;
  const changed = value !== customInstructionsOf(saved);

  const save = useMutation({
    mutationFn: (customInstructions: string) => saveMcpSettings({ customInstructions }),
    onSuccess: (answer) => {
      queryClient.setQueryData<McpSettings>(MCP_SETTINGS_KEY, answer);
      toast.success(CUSTOM_INSTRUCTIONS_COPY.saved);
    },
    onError: (failure) => {
      const field = failure instanceof ApiError ? failure.fields?.customInstructions : undefined;
      if (field) setError(field);
      else toast.error(CUSTOM_INSTRUCTIONS_COPY.saveFailed, userMessage(failure));
    },
  });

  return (
    <div className="flex flex-col gap-3" data-custom-instructions="">
      <Field
        label={CUSTOM_INSTRUCTIONS_COPY.label}
        hint={CUSTOM_INSTRUCTIONS_COPY.hint}
        // v2.0 fix (REQ-3): the constant's words (MSG_TEXT_TOO_LONG).
        error={error ?? (tooLong ? t('MSG_TEXT_TOO_LONG', { max }) : undefined)}
      >
        <Textarea
          rows={8}
          value={text}
          disabled={disabled}
          placeholder={CUSTOM_INSTRUCTIONS_COPY.placeholder}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
        />
      </Field>
      {/* A count is a value: it stays visible beside Save. */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] leading-5 text-muted-foreground">
          <CharacterCount length={value.length} max={max} />
        </span>
        <Button
          size="sm"
          loading={save.isPending}
          disabled={disabled || !changed || tooLong}
          onClick={() => save.mutate(value)}
        >
          {save.isPending ? CUSTOM_INSTRUCTIONS_COPY.saving : CUSTOM_INSTRUCTIONS_COPY.save}
        </Button>
      </div>
    </div>
  );
}
