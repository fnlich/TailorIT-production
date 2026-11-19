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
import { fetchMcpSettings, MCP_SETTINGS_KEY, saveMcpSettings } from './api';

// v2.0: Integrations › AI assistants › "How your AI works with TailorIT" › Custom instructions
// (docs/design/v2.0/08-ui.md, "Settings › Integrations"; 07-mcp.md): one plain text field the person's own AI gets with
// TailorIT's default instructions. The platform's rules still hold: the server applies the person's filters and limits
// whatever these say. No other MCP UI.

export const CUSTOM_INSTRUCTIONS_COPY = {
  label: 'Custom instructions',
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
  // Read again after a save, so the box starts from what is stored.
  return <CustomInstructionsForm key={settings.dataUpdatedAt} saved={settings.data?.customInstructions ?? ''} disabled={settings.isError} />;
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
