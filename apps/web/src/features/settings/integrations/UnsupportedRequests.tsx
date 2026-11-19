'use client';

import { QuestionIcon } from '@phosphor-icons/react/Question';
import type { McpUnsupportedItem, McpUnsupportedList } from '@tailorit/shared/mcp';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { TrashIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { IntegrationSection } from './IntegrationSection';
import { reportLine, UNSUPPORTED_EMPTY, UNSUPPORTED_INTRO, UNSUPPORTED_TITLE } from './unsupported';
import { clearUnsupported, deleteUnsupported, fetchUnsupported, MCP_UNSUPPORTED_KEY } from './unsupported-api';

/**
 * Integrations › AI assistants › "Requests your AI could not do" (v1.5 Q2; a card of its own since v3.1 INTEG): what the
 * person asked their AI that no TailorIT tool or filter can do (the MCP tool report_unsupported), newest first, each with
 * Delete, and Delete all behind a confirm. The reports are the AI's words, shown as plain text.
 */
export function UnsupportedRequests() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const reports = useQuery({ queryKey: MCP_UNSUPPORTED_KEY, queryFn: ({ signal }) => fetchUnsupported(signal) });

  const remove = async (item: McpUnsupportedItem) => {
    setDeleting(item.id);
    try {
      await deleteUnsupported(item.id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        toast.error('The report could not be deleted', userMessage(error));
        setDeleting(null);
        return;
      }
    }
    queryClient.setQueryData<McpUnsupportedList>(MCP_UNSUPPORTED_KEY, (previous) =>
      previous ? { items: previous.items.filter((entry) => entry.id !== item.id) } : previous,
    );
    setDeleting(null);
    toast.success('Report deleted');
  };

  const items = reports.data?.items ?? [];
  return (
    <IntegrationSection
      title={UNSUPPORTED_TITLE}
      description={UNSUPPORTED_INTRO}
      action={
        items.length > 1 ? (
          <Button variant="outline" size="sm" onClick={() => setClearing(true)}>
            Delete all
          </Button>
        ) : undefined
      }
    >
      {reports.isError ? (
        <Notice
          tone="error"
          title="Your AI's reports didn't load"
          action={
            <Button variant="outline" size="sm" onClick={() => void reports.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(reports.error)}
        </Notice>
      ) : reports.isPending ? (
        <div aria-busy="true" aria-label="Loading your AI's reports">
          <Skeleton className="h-12 w-full" rounded="control" />
        </div>
      ) : (
        <ReportList items={items} now={now} deleting={deleting} onDelete={(item) => void remove(item)} />
      )}
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Delete every report?"
        description="Your AI keeps working as before."
        confirmLabel="Delete all"
        busyLabel="Deleting..."
        onConfirm={async () => {
          const { removed } = await clearUnsupported();
          queryClient.setQueryData<McpUnsupportedList>(MCP_UNSUPPORTED_KEY, { items: [] });
          toast.success(`${removed} report${removed === 1 ? '' : 's'} deleted`);
        }}
      />
    </IntegrationSection>
  );
}

/** The reports, each with what it lacked, its line and Delete; an empty state without any. */
export function ReportList({
  items,
  now,
  deleting,
  onDelete,
}: {
  items: readonly McpUnsupportedItem[];
  now: number;
  deleting: string | null;
  onDelete: (item: McpUnsupportedItem) => void;
}) {
  if (items.length === 0) {
    return <EmptyState icon={<QuestionIcon size={24} />} title="No reports" description={UNSUPPORTED_EMPTY} variant="dashed" size="sm" />;
  }
  return (
    <ul className="flex flex-col divide-y divide-divider-soft" aria-label={UNSUPPORTED_TITLE}>
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-sm font-semibold break-words text-foreground">{item.request}</p>
            <p className="mt-0.5 text-[13px] leading-5 break-words text-foreground">
              <span className="text-muted-foreground">Missing: </span>
              {item.missing}
            </p>
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{reportLine(item, (value) => relativeTime(value, now))}</p>
          </div>
          <Button
            variant="destructive-outline"
            size="sm"
            loading={deleting === item.id}
            onClick={() => onDelete(item)}
            aria-label={`Delete the report "${item.request.slice(0, 60)}"`}
          >
            <TrashIcon size={14} aria-hidden />
            Delete
          </Button>
        </li>
      ))}
    </ul>
  );
}
