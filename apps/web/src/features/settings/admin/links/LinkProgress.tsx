'use client';

import type { LinkBatchProgress } from '@tailorit/shared/jobs';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { isApiError, userMessage } from '@/lib/api';
import { fetchLinkBatch, linkKeys } from './api';
import {
  LINK_ITEM_LABEL,
  LINK_ITEM_TONE,
  LINK_PROGRESS_POLL_MS,
  LINK_PROGRESS_SHOWN,
  batchRunning,
  itemReason,
  itemState,
  progressCountsText,
  progressText,
} from './links';

// v31 ADMINWEB: how far TailorIT got reading a batch of links (GET /api/admin/jobs/add/:batchId): a progress tape, the
// results counted, and the first links with what each came to. Read again every few seconds until every link is read.
// An import run's links are the batch `run:<runId>`; until the run queued them, the batch is not there yet.

type Item = LinkBatchProgress['items'][number];

/** One link: the link (a new tab) and what it came to, wrapping at a dialog's or a phone's width. */
function LinkItem({ item }: { item: Item }) {
  const state = itemState(item);
  const reason = itemReason(item);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5" data-link-state={state}>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="min-w-0 flex-1 basis-64 text-[13px] leading-5 break-all text-primary hover:underline"
      >
        {item.url}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <span className="flex max-w-full flex-col items-start gap-1 sm:items-end">
        <Badge tone={LINK_ITEM_TONE[state]}>{LINK_ITEM_LABEL[state]}</Badge>
        {reason && state !== 'published' && <span className="text-xs leading-4 text-muted-foreground sm:text-right">{reason}</span>}
      </span>
    </li>
  );
}

export function LinkProgress({ batchId, className }: { batchId: string; className?: string }) {
  const progress = useQuery({
    queryKey: linkKeys.batch(batchId),
    queryFn: ({ signal }) => fetchLinkBatch(batchId, signal),
    // A batch not queued yet (an import run still starting) answers 404: asked again, like a running one.
    retry: false,
    refetchInterval: (query) => (batchRunning(query.state.data) ? LINK_PROGRESS_POLL_MS : false),
  });
  const data = progress.data;
  if (!data) {
    if (progress.isError && !(isApiError(progress.error) && progress.error.status === 404)) {
      return (
        <Notice tone="warning" className={className} title="The progress could not be read">
          {userMessage(progress.error)}
        </Notice>
      );
    }
    return (
      <div className={clsx('flex flex-col gap-2', className)} aria-busy="true" data-link-progress={batchId}>
        <p className="text-[13px] leading-5 text-muted-foreground">{progress.isError ? 'Waiting for the links to be queued...' : 'Reading the progress...'}</p>
        <Skeleton className="h-2.5 w-full" rounded="full" />
      </div>
    );
  }
  const running = batchRunning(data);
  const shown = data.items.slice(0, LINK_PROGRESS_SHOWN);
  return (
    <section aria-label="Reading the links" className={clsx('flex flex-col gap-3', className)} data-link-progress={batchId}>
      <TapeMeter
        label="Links read"
        showLabel
        value={data.done}
        max={Math.max(1, data.total)}
        valueText={progressText(data)}
        kind="progress"
        tone={running ? 'primary' : 'success'}
      />
      <p className="text-[13px] leading-5 text-muted-foreground" aria-live="polite" data-link-counts="">
        {[progressCountsText(data.counts) || 'Nothing read yet', running ? 'TailorIT reads a few links per site at a time, so a long list takes a while' : null]
          .filter(Boolean)
          .join('. ')}
        .
      </p>
      {shown.length > 0 && (
        <ul
          aria-label="Links in this batch"
          className="max-h-96 divide-y divide-divider-soft overflow-y-auto rounded-card border border-border bg-surface"
          data-link-items=""
        >
          {shown.map((item) => (
            <LinkItem key={item.url} item={item} />
          ))}
        </ul>
      )}
      {data.total > shown.length && (
        <p className="text-xs leading-4 text-muted-foreground">
          The first {shown.length.toLocaleString('en-US')} of {data.total.toLocaleString('en-US')} links.
        </p>
      )}
    </section>
  );
}
