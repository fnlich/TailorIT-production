'use client';

import {
  JOB_SOURCE_PURGE_REASON_LABEL,
  JOB_SOURCE_PURGE_STATES,
  type JobSourcePurgeState,
} from '@tailorit/shared/sourcing';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { TrashIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { fetchPurges, sourceKeys } from './api';
import { PURGE_STATE_LABEL, PURGE_STATE_TONE, hasOpenPurge, purgeCounts, purgeTarget, requestedByText } from './purges';

// v30 S1-WEB: the purges by source, newest first (job_source_purges: what each was asked to do, by whom, and its counts
// so far), followed while one is queued or running.

type StateFilter = 'all' | JobSourcePurgeState;
const STATE_OPTIONS: ReadonlyArray<{ value: StateFilter; label: string }> = [
  { value: 'all', label: 'Every state' },
  ...JOB_SOURCE_PURGE_STATES.map((value) => ({ value, label: PURGE_STATE_LABEL[value] })),
];
const FOLLOW_MS = 3000;

export function PurgesSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const now = useNow();
  const [state, setState] = useState<StateFilter>('all');
  const states: JobSourcePurgeState[] = state === 'all' ? [] : [state];
  const purges = useInfiniteQuery({
    queryKey: sourceKeys.purges(states),
    queryFn: ({ pageParam, signal }) => fetchPurges(states, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
    refetchInterval: (query) => (query.state.data?.pages.some((page) => hasOpenPurge(page.items)) ? FOLLOW_MS : false),
  });
  const items = purges.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="Purges"
        description="Sources purged when a contract ended, an employer opted out or the terms changed. Each purge runs in batches."
        icon={<TrashIcon size={20} />}
      >
        <div className="flex flex-col gap-4">
          <Select aria-label="Purge state" options={STATE_OPTIONS} value={state} onValueChange={setState} className="w-48" />
          {purges.error ? (
            <Notice tone="error" title="The purges could not be loaded">
              {userMessage(purges.error)}
            </Notice>
          ) : !purges.data ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState size="sm" title="No purges" description="Purge a source from its menu on the Sources tab." />
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-surface border border-border" aria-label="Purges">
              {items.map((purge) => (
                <li key={purge.id} className="flex flex-col gap-1 px-4 py-3" data-purge={purge.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{purgeTarget(purge)}</span>
                    <Badge tone={PURGE_STATE_TONE[purge.state]}>{PURGE_STATE_LABEL[purge.state]}</Badge>
                  </div>
                  <p className="text-[13px] text-muted-foreground">
                    {JOB_SOURCE_PURGE_REASON_LABEL[purge.reason]}
                    {purge.deleteTexts ? (purge.deleteAppliedTexts ? ' · texts deleted, applied ones too' : ' · texts deleted') : ' · texts kept'}
                    {' · '}
                    {requestedByText(purge)}
                    {' · '}
                    <Tooltip content={new Date(purge.createdAt).toLocaleString('en-US')}>
                      <span>{relativeTime(purge.createdAt, now)}</span>
                    </Tooltip>
                  </p>
                  <p className="text-sm">{purgeCounts(purge)}</p>
                </li>
              ))}
            </ul>
          )}
          {purges.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" loading={purges.isFetchingNextPage} onClick={() => void purges.fetchNextPage()}>
                Show more purges
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
