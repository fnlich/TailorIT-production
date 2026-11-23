'use client';

import type { JobImportSummary, JobImportWay } from '@tailorit/shared';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { AdminTable, ShowMoreButton, TableSkeleton, type AdminColumn } from '@/components/admin';
import { Button } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { Notice } from '@/components/ui/Notice';
import { userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { importSheet, type StartedImport } from '../../../imports/api';
import { IMPORT_POLL_MS, countsLine, importRunning } from '../../../imports/results';
import { adminImportKeys, fetchRecentImports } from './api';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §2 "Recent imports"; PLAN H6): every admin import, newest first: its name
// (the file, the sheet's tab, "1 link", "24 pasted links"), who started it, when, and its counts; Open shows its results
// (?tab=import&run=<runId>), and a Google Sheet's Import again reads the same tab with the same mapping. It replaces
// Sources' old "Import the sheet again" (an import is not a source).

const WAY_LABEL: Record<JobImportWay, string> = { link: 'One link', paste: 'Many links', file: 'File', sheet: 'Google Sheet' };

export interface RecentImportsProps {
  /** Shows an import's results (its run). */
  onOpen: (runId: number) => void;
  /** An Import again started. */
  onStarted: (started: StartedImport) => void;
  /** The import whose results are shown (its Open is pressed already). */
  openRunId: number | null;
}

export function RecentImports({ onOpen, onStarted, openRunId }: RecentImportsProps) {
  const now = useNow();
  const recent = useInfiniteQuery({
    queryKey: adminImportKeys.recent,
    queryFn: ({ pageParam, signal }) => fetchRecentImports(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    // Counts move while an import's rows are read (the first page only; a long history is read again by hand).
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      return pages.length === 1 && pages[0]!.items.some((item) => importRunning(item)) ? IMPORT_POLL_MS : false;
    },
  });
  const again = useMutation({
    mutationFn: (item: JobImportSummary) =>
      importSheet('admin', {
        url: item.sheet!.url,
        gid: item.sheet!.gid,
        headerRow: item.sheet!.headerRow,
        mapping: item.mapping ?? undefined,
      }),
    onSuccess: onStarted,
  });

  const items = recent.data?.pages.flatMap((page) => page.items);
  const columns: AdminColumn<JobImportSummary>[] = [
    {
      key: 'name',
      header: 'Import',
      sticky: true,
      cell: (item) => (
        <span className="flex min-w-0 flex-col">
          <span className="max-w-72 font-medium break-words text-foreground">{item.name}</span>
          <span className="text-xs leading-4 text-muted-foreground">{WAY_LABEL[item.way]}</span>
        </span>
      ),
    },
    { key: 'by', header: 'Started by', cell: (item) => <span className="break-all">{item.startedBy ?? '-'}</span> },
    {
      key: 'when',
      header: 'When',
      className: 'whitespace-nowrap',
      cell: (item) => <time dateTime={item.createdAt}>{relativeTime(item.createdAt, now)}</time>,
    },
    {
      key: 'counts',
      header: 'Counts',
      cell: (item) => (
        <span className="text-[13px] leading-5" data-recent-counts="">
          {`${item.counts.rows.toLocaleString('en-US')} ${item.counts.rows === 1 ? 'row' : 'rows'}: ${countsLine(item.counts)}`}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'text-right whitespace-nowrap',
      cell: (item) => (
        <span className="inline-flex items-center justify-end gap-2">
          {item.runId !== null && (
            <Button
              variant={item.runId === openRunId ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onOpen(item.runId!)}
              aria-label={`Open ${item.name}`}
              aria-current={item.runId === openRunId ? 'true' : undefined}
              data-recent-open=""
            >
              Open
            </Button>
          )}
          {item.way === 'sheet' && item.sheet && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => again.mutate(item)}
              loading={again.isPending && again.variables?.id === item.id}
              disabled={again.isPending}
              aria-label={`Import again ${item.name}`}
              data-recent-again=""
            >
              Import again
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <section aria-labelledby="recent-imports-heading" className="flex flex-col gap-3" data-recent-imports="">
      <span className="flex items-center gap-1.5">
        <h3 id="recent-imports-heading" tabIndex={-1} className="text-[15px] leading-5 font-semibold text-foreground outline-none">
          Recent imports
        </h3>
        <HelpTip label="Recent imports">Each import is one run on Runs; Import again reads the same Google Sheet tab with the same columns.</HelpTip>
      </span>
      {again.isError && <Notice tone="error">{userMessage(again.error)}</Notice>}
      {recent.isError && !items ? (
        <Notice
          tone="error"
          title="Recent imports didn't load."
          action={
            <Button variant="outline" size="sm" onClick={() => void recent.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(recent.error)}
        </Notice>
      ) : !items ? (
        <TableSkeleton rows={3} />
      ) : items.length === 0 ? (
        <p className="rounded-card border border-border bg-surface px-4 py-6 text-center text-sm text-muted-foreground" data-recent-empty="">
          No imports yet. An import shows here with its counts.
        </p>
      ) : (
        <>
          <AdminTable aria-label="Recent imports" items={items} columns={columns} getKey={(item) => item.id} />
          <ShowMoreButton
            hasMore={Boolean(recent.hasNextPage)}
            loading={recent.isFetchingNextPage}
            onMore={() => void recent.fetchNextPage()}
            afterLast={['[data-recent-imports] tbody tr:last-child button']}
          >
            Show more imports
          </ShowMoreButton>
        </>
      )}
    </section>
  );
}
