'use client';

import type { UnverifiedLink, UnverifiedVersion } from '@tailorit/shared/jobs';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShowMoreButton } from '@/components/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, CheckIcon, ShieldCheckIcon, XIcon } from '@/components/ui/icons';
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
  PAGE_READS_OFF,
  approveOutcomeText,
  approveText,
  approveUnverified,
  canApprove,
  capturedLine,
  fetchUnverified,
  linkName,
  rejectText,
  rejectUnverified,
  retryOutcomeText,
  retryUnverified,
  rowReasonText,
  unverifiedEmptyText,
  unverifiedMetaLine,
  versionsText,
} from './unverified';
import { ApproveVersions, VersionsDisclosure } from './UnverifiedVersions';

// v31 ADMINWEB: Admin › Review › Couldn't verify (docs/design/v3.1/21-jobs-from-links.md §6, D2): one row per link
// TailorIT could not read that someone keeps as their own job (its host, the link, why, who and when), with Retry read
// and Reject only. Nothing here edits or publishes a job's words: a Retry read publishes only what TailorIT itself
// reads from the link. The list switch on top is EXT_NEW_PAGE_JOBS_REVIEW (the list is empty while it is off).
// v32 ADMINAPP (E6, the owner's "admin should be able to approve manually"): each row also shows its job as captured
// and leads with Approve (after a short confirm): the job is published as it was added, marked "Approved by an admin",
// and its adders are told. The admin still types nothing.
// v32 FIX-API (REV-SECBEH SB-1, SB-4, SB-6; REV-UXREQ UXREQ-9): "Show the job" draws what an approval publishes, every
// version in full; the confirm draws the version to publish (a pick when the adders' differ) and approves exactly it.
// A row TailorIT found opted out or closed has no Approve; a job whose approval ran out says "Approved before". "Page
// reads are off" is said once, above the list.

const LIST_SWITCH = 'EXT_NEW_PAGE_JOBS_REVIEW';
const LIST_WORDS: SwitchWords = { on: "Couldn't verify lists links again", off: "Couldn't verify is off" };
const PANE = '[data-review-pane]';

export function UnverifiedLane({ onLive }: { onLive: (text: string) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [rejecting, setRejecting] = useState<UnverifiedLink | null>(null);
  const [approving, setApproving] = useState<UnverifiedLink | null>(null); // v32 ADMINAPP (E6)
  // v32 FIX-API (SB-1): the version the confirm shows, the one an approval publishes.
  const [version, setVersion] = useState<UnverifiedVersion | null>(null);
  const onPick = useCallback((picked: UnverifiedVersion | null) => setVersion(picked), []);
  const constants = useQuery({ queryKey: adminKeys.constants, queryFn: ({ signal }) => fetchAdminConstants(signal) });
  const listSwitch = constants.data?.items.find((item) => item.key === LIST_SWITCH);
  const listOn = listSwitch ? listSwitch.value === true : null;

  const list = useInfiniteQuery({
    queryKey: reviewKeys.unverified,
    queryFn: ({ pageParam, signal }) => fetchUnverified(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: busy.size > 0 || rejecting || approving ? false : REVIEW_POLL_MS,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  // Focus stays in the list when a row leaves it (read and published, or rejected): the row now in its place, else
  // the lane's tab. It waits while a dialog is open or focus is still in the row; once focus is elsewhere it lets go.
  const focusAt = useRef<{ jobId: number; index: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const want = focusAt.current;
    if (want === null || busy.size > 0 || rejecting || approving) return;
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
  }, [rows, busy, rejecting, approving]);

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

  // v32 ADMINAPP (E6): an error keeps the confirm open with its sentence (a refused site or company, the hour's limit).
  // v32 FIX-API (SB-1): the version drawn in the confirm, by its content hash (409 when it changed since: read it again).
  const approve = async (row: UnverifiedLink) => {
    if (!version) throw new Error('Wait until the job is shown, then approve it.');
    holdFocus(row);
    markBusy(row.jobId, true);
    try {
      const result = await approveUnverified(version.jobId, version.version);
      const words = approveOutcomeText(result);
      onLive(`${words.title}: ${linkName(row.url)}`);
      toast.success(words.title, words.body);
    } catch (error) {
      focusAt.current = null;
      throw error;
    } finally {
      markBusy(row.jobId, false);
      refresh();
    }
  };
  const pageReadsOff = rows.some((row) => row.reason === 'not_set_up');

  let body;
  if (list.isError && !list.data) {
    body = (
      <div className="p-4 sm:p-5">
        <Notice
          tone="error"
          title="The unverified links didn't load."
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
        {/* v32 FIX-API (UXREQ-9): a server setting, said once for the lane (its rows leave the sentence out). */}
        {pageReadsOff && (
          <p className="flex items-center gap-1 px-4 pt-3 sm:px-5" data-unverified-page-reads-off="">
            <Badge tone="warning">{PAGE_READS_OFF.label}</Badge>
            <HelpTip label={PAGE_READS_OFF.label}>{PAGE_READS_OFF.tip}</HelpTip>
          </p>
        )}
        <ul ref={listRef} className="divide-y divide-divider-soft" aria-label="Links TailorIT couldn't verify">
          {rows.map((row) => (
            <UnverifiedRow
              key={row.jobId}
              row={row}
              now={now}
              busy={busy.has(row.jobId)}
              onApprove={canApprove(row) ? () => setApproving(row) : undefined}
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
          <p className="text-[13px] text-muted-foreground">The list switch didn&apos;t load. {userMessage(constants.error)}</p>
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
      <ConfirmDialog
        open={approving !== null}
        onOpenChange={(open) => {
          if (open) return;
          setApproving(null);
          setVersion(null);
        }}
        tone="primary"
        title={approving ? approveText(approving).title : ''}
        description={
          approving ? (
            <>
              {approveText(approving).description} <HelpTip label="Who is told">{approveText(approving).tip}</HelpTip>
            </>
          ) : undefined
        }
        confirmLabel={approving ? approveText(approving).confirm : 'Approve'}
        busyLabel="Publishing..."
        // v32 INT-2 (UXREQ-12): publishing to everyone opens on Cancel, so a quick Enter never publishes.
        focusCancel
        // v32 INT-2: off until a version the admin may approve is shown (never their own job).
        confirmDisabled={version === null}
        // Focus goes to the row in its place once the list is read again (the effect above).
        finalFocus={() => false}
        onConfirm={async () => {
          if (approving) await approve(approving);
        }}
      >
        {/* v32 FIX-API (SB-1): what is published, in full (and which version, when the adders' differ). */}
        {approving && <ApproveVersions row={approving} onPick={onPick} />}
      </ConfirmDialog>
    </>
  );
}

/**
 * One link: its host, its job as captured (v32), the link (opens the posting in a new tab), why, who and when; Approve
 * (v32 ADMINAPP, E6: the row's one primary), Retry read and Reject. v32 FIX-API: how many versions, "Approved before",
 * "Show the job" (every version in full); no Approve (`onApprove` absent) for a link that is never published.
 */
export function UnverifiedRow({
  row,
  now,
  busy,
  onApprove,
  onRetry,
  onReject,
}: {
  row: UnverifiedLink;
  now: number;
  busy: boolean;
  onApprove?: (() => void) | undefined;
  onRetry: () => void;
  onReject: () => void;
}) {
  const name = linkName(row.url);
  const captured = capturedLine(row);
  const versions = versionsText(row);
  const reason = rowReasonText(row);
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
          {captured && (
            <p className="text-[13px] leading-5 break-words text-foreground" data-unverified-captured="">
              {captured}
            </p>
          )}
          {(versions || row.approvedBefore) && (
            <p className="flex flex-wrap gap-1.5 py-0.5">
              {versions && (
                <Badge tone="tint" data-unverified-versions={row.versions}>
                  {versions}
                </Badge>
              )}
              {row.approvedBefore && (
                <Badge tone="sky" data-unverified-approved-before="">
                  Approved before
                </Badge>
              )}
            </p>
          )}
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
          {reason && (
            <p className="text-[13px] leading-5 text-foreground" data-unverified-reason="">
              {reason}
            </p>
          )}
          <p className="text-[13px] leading-5 text-muted-foreground">{unverifiedMetaLine(row, now)}</p>
          <VersionsDisclosure row={row} name={name} />
        </div>
        {/* v31 FIX-WEB (REV-UX UX-10): Retry read is an outline button, Reject a quiet one. v32 ADMINAPP (E6): Approve
            leads the row, as New jobs' Approve does: the row's one primary. */}
        <RowActions>
          {onApprove && (
            <Button
              size="sm"
              className={TOUCH}
              icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />}
              disabled={busy}
              focusableWhenDisabled
              aria-label={`Approve: ${name}`}
              aria-haspopup="dialog"
              onClick={onApprove}
              {...ROW_ACTION}
            >
              Approve
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className={TOUCH}
            icon={<ArrowsClockwiseIcon size={14} weight="bold" aria-hidden="true" />}
            loading={busy}
            focusableWhenDisabled
            aria-label={`Retry read: ${name}`}
            onClick={onRetry}
            // v32 FIX-API: without Approve, Retry read leads the row (the focus lands on it when a row leaves).
            {...(onApprove ? {} : ROW_ACTION)}
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
