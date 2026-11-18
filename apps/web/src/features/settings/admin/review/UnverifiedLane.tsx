'use client';

import type { UnverifiedLink } from '@tailorit/shared/jobs';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ShowMoreButton } from '@/components/admin';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, ShieldCheckIcon, XIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { useNow } from '@/lib/useNow';
import { ROW_ACTION, useRowFocus } from '../../../../components/queue';
import { adminKeys, fetchAdminConstants } from '../api';
import { ConstantSwitch, type SwitchWords } from './AutoApprove';
import { reviewKeys } from './api';
import { REVIEW_POLL_MS } from './copy';
import { AccentBar, RowActions, TOUCH } from './ReviewRows';
import {
  REASON_ADMIN_TEXT,
  fetchUnverified,
  linkName,
  rejectText,
  rejectUnverified,
  retryOutcomeText,
  retryUnverified,
  unverifiedEmptyText,
  unverifiedMetaLine,
} from './unverified';

// v31 ADMINWEB: Admin › Review › Couldn't verify (docs/design/v3.1/21-jobs-from-links.md §6, D2): one row per link
// TailorIT could not read that someone keeps as their own job (its host, the link, why, who and when), with Retry read
// and Reject only. Nothing here edits or publishes a job's words: a Retry read publishes only what TailorIT itself
// reads from the link. The list switch on top is EXT_NEW_PAGE_JOBS_REVIEW (the list is empty while it is off).

const LIST_SWITCH = 'EXT_NEW_PAGE_JOBS_REVIEW';
const LIST_WORDS: SwitchWords = { on: "Couldn't verify lists links again", off: "Couldn't verify is off" };
const PANE = '[data-review-pane]';

export function UnverifiedLane({ onLive }: { onLive: (text: string) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [rejecting, setRejecting] = useState<UnverifiedLink | null>(null);
  const constants = useQuery({ queryKey: adminKeys.constants, queryFn: ({ signal }) => fetchAdminConstants(signal) });
  const listSwitch = constants.data?.items.find((item) => item.key === LIST_SWITCH);
  const listOn = listSwitch ? listSwitch.value === true : null;

  const list = useInfiniteQuery({
    queryKey: reviewKeys.unverified,
    queryFn: ({ pageParam, signal }) => fetchUnverified(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: busy.size > 0 || rejecting ? false : REVIEW_POLL_MS,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  // Focus stays in the list when a row leaves it (read and published, or rejected): the row now in its place, else
  // the lane's tab. It waits while a dialog is open or focus is still in the row; once focus is elsewhere it lets go.
  const focusAt = useRef<{ jobId: number; index: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const want = focusAt.current;
    if (want === null || busy.size > 0 || rejecting) return;
    const active = document.activeElement;
    if (active?.closest('[role="dialog"], [role="alertdialog"]')) return;
    if (active && active !== document.body) {
      if (!active.closest(`[data-unverified-row="${want.jobId}"]`)) focusAt.current = null;
      return;
    }
    if (rows.some((row) => row.jobId === want.jobId)) return; // still listed: its own buttons keep focus
    focusAt.current = null;
    const items = listRef.current?.querySelectorAll<HTMLElement>('li[data-unverified-row]') ?? [];
    const row = items.length > 0 ? items[Math.min(want.index, items.length - 1)] : null;
    const target = row?.querySelector<HTMLElement>('[data-row-action]') ?? document.querySelector<HTMLElement>(`${PANE} [role="tab"][aria-selected="true"]`);
    target?.focus();
  }, [rows, busy, rejecting]);

  const markBusy = (jobId: number, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  const holdFocus = (row: UnverifiedLink) => {
    focusAt.current = { jobId: row.jobId, index: Math.max(0, rows.findIndex((item) => item.jobId === row.jobId)) };
  };
  const refresh = () => void queryClient.invalidateQueries({ queryKey: reviewKeys.all });

  const retry = async (row: UnverifiedLink) => {
    if (busy.has(row.jobId)) return;
    markBusy(row.jobId, true);
    holdFocus(row);
    try {
      const result = await retryUnverified(row.jobId);
      const words = retryOutcomeText(result);
      onLive(`${words.title}: ${linkName(row.url)}`);
      if (words.tone === 'success') toast.success(words.title, words.body);
      else toast.info(words.title, words.body);
    } catch (error) {
      focusAt.current = null;
      toast.error('TailorIT could not read the link again', userMessage(error));
    } finally {
      markBusy(row.jobId, false);
      refresh();
    }
  };

  const reject = async (row: UnverifiedLink) => {
    holdFocus(row);
    await rejectUnverified(row.jobId);
    onLive(`Rejected: ${linkName(row.url)}`);
    toast.success('Link rejected', 'TailorIT will never publish a job from it.');
    refresh();
  };

  let body;
  if (list.isError && !list.data) {
    body = (
      <div className="p-4 sm:p-5">
        <Notice
          tone="error"
          title="The links TailorIT couldn't verify could not be loaded"
          action={
            <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(list.error)}
        </Notice>
      </div>
    );
  } else if (!list.data) {
    body = (
      <ul aria-busy="true" aria-label="Loading the links TailorIT couldn't verify" className="divide-y divide-divider-soft">
        {Array.from({ length: 4 }, (_unused, index) => (
          <li key={index} aria-hidden="true" className="flex min-h-20 items-start gap-3 px-5 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-2/5" />
            </div>
            <Skeleton className="h-8 w-40" rounded="control" />
          </li>
        ))}
      </ul>
    );
  } else if (rows.length === 0) {
    const empty = unverifiedEmptyText(listOn);
    body = <EmptyState icon={<ShieldCheckIcon size={22} />} title={empty.title} description={empty.description} />;
  } else {
    body = (
      <>
        {list.isError && (
          <Notice tone="warning" className="mx-4 mt-3 sm:mx-5" title="The list could not be refreshed">
            What is shown may be out of date.
          </Notice>
        )}
        <ul ref={listRef} className="divide-y divide-divider-soft" aria-label="Links TailorIT couldn't verify">
          {rows.map((row) => (
            <UnverifiedRow
              key={row.jobId}
              row={row}
              now={now}
              busy={busy.has(row.jobId)}
              onRetry={() => void retry(row)}
              onReject={() => setRejecting(row)}
            />
          ))}
        </ul>
        <ShowMoreButton
          hasMore={list.hasNextPage}
          loading={list.isFetchingNextPage}
          onMore={() => void list.fetchNextPage()}
          afterLast={[`${PANE} li[data-unverified-row]:last-of-type [data-row-action]`]}
          variant="ghost"
          size="sm"
          className="flex justify-center p-3"
        >
          Load more
        </ShowMoreButton>
      </>
    );
  }

  return (
    <>
      <div
        role="group"
        aria-label="Couldn't verify list"
        className="flex flex-col gap-3 border-b border-border bg-surface-low px-4 py-3 sm:px-5"
        data-unverified-switch=""
      >
        {listSwitch ? (
          <ConstantSwitch row={listSwitch} rule={listSwitch.help} words={LIST_WORDS} />
        ) : constants.isError ? (
          <p className="text-[13px] text-muted-foreground">The list switch could not be loaded. {userMessage(constants.error)}</p>
        ) : (
          <Skeleton className="h-9 w-72" />
        )}
      </div>
      <div data-unverified-lane="">{body}</div>
      <ConfirmDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title="Reject this link?"
        description={rejecting ? rejectText(rejecting) : undefined}
        confirmLabel="Reject link"
        busyLabel="Rejecting..."
        // Focus goes to the row in its place once the list is read again (the effect above), not back to a row that left.
        finalFocus={() => false}
        onConfirm={async () => {
          if (rejecting) await reject(rejecting);
        }}
      >
        {rejecting && <p className="text-[13px] leading-5 break-all text-muted-foreground">{rejecting.url}</p>}
      </ConfirmDialog>
    </>
  );
}

/** One link: its host, the link (opens the posting in a new tab), why, who and when; Retry read and Reject. */
export function UnverifiedRow({ row, now, busy, onRetry, onReject }: { row: UnverifiedLink; now: number; busy: boolean; onRetry: () => void; onReject: () => void }) {
  const name = linkName(row.url);
  const [rowRef, rowFocus] = useRowFocus<HTMLLIElement>(`${row.jobId}:${row.attempts}`);
  return (
    <li
      ref={rowRef}
      {...rowFocus}
      data-unverified-row={row.jobId}
      data-reason={row.reason}
      className="relative flex items-start gap-3 py-3 pr-4 pl-5 @lg/pane:pr-5 @lg/pane:pl-6"
    >
      <AccentBar tone="decide" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 @2xl/pane:flex-row @2xl/pane:items-start @2xl/pane:gap-3">
        <div className="min-w-0 flex-1" data-review-text="">
          <p className="text-sm leading-5 font-semibold break-words text-foreground">{row.host}</p>
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex max-w-full items-start gap-1 text-[13px] leading-5 break-all text-primary hover:underline"
            data-unverified-link=""
          >
            <span>{row.url}</span>
            <ArrowSquareOutIcon size={13} className="mt-1 shrink-0" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <p className="text-[13px] leading-5 text-foreground" data-unverified-reason="">
            {REASON_ADMIN_TEXT[row.reason]}
          </p>
          <p className="text-[13px] leading-5 text-muted-foreground">{unverifiedMetaLine(row, now)}</p>
        </div>
        {/* v31 FIX-WEB (REV-UX UX-10): no primary in a row (one primary per area, design 20 §9): Retry read is an
            outline button, Reject a quiet one, so a list of links does not read as a column of calls to action. */}
        <RowActions>
          <Button
            size="sm"
            variant="outline"
            className={TOUCH}
            icon={<ArrowsClockwiseIcon size={14} weight="bold" aria-hidden="true" />}
            loading={busy}
            focusableWhenDisabled
            aria-label={`Retry read: ${name}`}
            onClick={onRetry}
            {...ROW_ACTION}
          >
            Retry read
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={TOUCH}
            icon={<XIcon size={14} weight="bold" aria-hidden="true" />}
            disabled={busy}
            focusableWhenDisabled
            aria-label={`Reject: ${name}`}
            aria-haspopup="dialog"
            onClick={onReject}
          >
            Reject
          </Button>
        </RowActions>
      </div>
    </li>
  );
}
