'use client';

import { MCP_REVISE_ROUNDS, type McpSettings } from '@tailorit/shared/mcp';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { fetchMcpSettings, MCP_SETTINGS_KEY, saveMcpSettings } from './api';
import { REVISE_ROUNDS_HINT, reviseRoundOptions } from './mcp';

const OPTIONS = reviseRoundOptions(MCP_REVISE_ROUNDS.min, MCP_REVISE_ROUNDS.max, MCP_REVISE_ROUNDS.default);

/**
 * v1.5 Q1: Settings › Integrations › "Your own AI (MCP)" › Revision rounds: how many revision rounds the person's own AI
 * is asked for after each tailored resume (0 to 5, 2 by default), saved as it is chosen.
 */
export function ReviseRoundsSetting() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: MCP_SETTINGS_KEY, queryFn: ({ signal }) => fetchMcpSettings(signal) });
  const save = useMutation({
    mutationFn: (reviseRounds: number) => saveMcpSettings({ reviseRounds }),
    onSuccess: (saved) => {
      queryClient.setQueryData<McpSettings>(MCP_SETTINGS_KEY, saved);
      toast.success(`Revision rounds: ${saved.reviseRounds}`);
    },
    onError: (error) => toast.error('The revision rounds could not be saved', userMessage(error)),
  });

  if (settings.isPending) return <Skeleton className="h-16 w-full" rounded="control" />;
  const value = save.isPending ? String(save.variables) : String(settings.data?.reviseRounds ?? MCP_REVISE_ROUNDS.default);
  return (
    <Field label="Revision rounds" hint={REVISE_ROUNDS_HINT}>
      <Select
        options={OPTIONS}
        value={value}
        disabled={save.isPending || settings.isError}
        className="w-44"
        onValueChange={(next) => {
          const rounds = Number(next);
          if (rounds !== settings.data?.reviseRounds) save.mutate(rounds);
        }}
      />
    </Field>
  );
}
