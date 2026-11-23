'use client';

import type { UnverifiedLink, UnverifiedVersion } from '@tailorit/shared/jobs';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShowMoreButton } from '@/components/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, CheckIcon, ShieldCheckIcon, XIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { focusSoon } from '@/lib/focusLater';
import { useNow } from '@/lib/useNow';
import { ROW_ACTION, SelectBar, useRowFocus } from '../../../../components/queue';
import { adminKeys, fetchAdminConstants } from '../api';
import { ConstantSwitch, type SwitchWords } from './AutoApprove';
import { reviewKeys } from './api';
import { REVIEW_POLL_MS } from './copy';
import { UNVERIFIED_WAYS, fetchRecentImports, fromOptions, unverifiedFilterOf, unverifiedFromValue } from './from'; // v35 OPSWEB
import { AccentBar, RowActions, TOUCH } from './ReviewRows';
import {
  PAGE_READS_OFF,
  approveOutcomeText,
  approveText,
  allUnverified,
  approveUnverified,
  bulkUnverified,
  canApprove,
  capturedLine,
  fetchUnverified,
  fetchUnverifiedAllCount,
  linkName,
  rejectText,
  rejectUnverified,
  retryOutcomeText,
  retryUnverified,
  rowOriginText,
  rowReasonText,
  runUnverifiedAll,
  runUnverifiedBulk,
  unverifiedBulkConfirm,
  unverifiedEmptyText,
  unverifiedFilterFromAddress,
  unverifiedFilterQuery,
  unverifiedMetaLine,
  versionsText,
  fetchUnverifiedCount,
  type UnverifiedFilter,
  type UnverifiedOutcome,
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

// v35 OPSWEB (PLAN H3): the From filter (All, Imports, People's adds, one import: `run=` in the address opens it), row
// checkboxes (Space toggles one; Shift+click a range), Select all shown, Approve selected / Reject selected (in turns of
// UNVERIFIED_BULK_MAX), Approve all / Reject all for the filter (a confirm with its count, then IMPORT's "all" requests
// while rows are left, with progress and one result line), and each row's origin ("Import · jobs.csv, row 12").

/** A bulk action asked for: the chosen rows, or every row the filter matches. */
type BulkAsk = { scope: 'selected' | 'all'; action: 'approve' | 'reject' };

const LIST_SWITCH = 'EXT_NEW_PAGE_JOBS_REVIEW';
const LIST_WORDS: SwitchWords = { on: "Couldn't verify lists links again", off: "Couldn't verify is off" };
const PANE = '[data-review-pane]';

export function UnverifiedLane({
  onLive,
  onFilterCount,
}: {
  onLive: (text: string) => void;
  /** v35 FIX-WEB (L5): the From filter's count while one is on (the header's "2 of 7"), else null. */
  onFilterCount?: (count: number | null) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const address = useSearchParams();
  // v35 OPSWEB: `run=` in the address opens one import (no address outside the app's router: All).
  const [filter, setFilter] = useState<UnverifiedFilter>(() => unverifiedFilterFromAddress(address ?? new URLSearchParams()));
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set()); // v35 OPSWEB
  const anchor = useRef<number | null>(null);
  const [asking, setAsking] = useState<BulkAsk | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<UnverifiedOutcome | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<number, string>>(new Map());
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
    queryKey: [...reviewKeys.unverified, unverifiedFilterQuery(filter)],
    queryFn: ({ pageParam, signal }) => fetchUnverified(pageParam, signal, filter),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: busy.size > 0 || rejecting || approving || asking ? false : REVIEW_POLL_MS,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  // v35 OPSWEB: the recent imports the From filter offers; the filter's count, read when Approve all / Reject all asks.
  const imports = useQuery({ queryKey: ['admin', 'imports', 'recent'], queryFn: ({ signal }) => fetchRecentImports(signal), staleTime: 60_000 });
  // v35 FIX-WEB (S6): the count and its `upTo`, which Approve all / Reject all send back.
  const allCount = useQuery({
    queryKey: [...reviewKeys.unverifiedCount, 'all', unverifiedFilterQuery(filter)],
    queryFn: ({ signal }) => fetchUnverifiedAllCount(filter, signal),
    enabled: asking?.scope === 'all',
    staleTime: 0,
    gcTime: 0,
  });
  // v35 FIX-WEB (L5): while a From filter is on, its count (the header says "2 of 7").
  const isFiltered = filter.from !== 'all' || filter.runId !== null;
  const filterCount = useQuery({
    queryKey: [...reviewKeys.unverifiedCount, 'filter', unverifiedFilterQuery(filter)],
    queryFn: ({ signal }) => fetchUnverifiedCount(signal, filter),
    enabled: isFiltered,
    refetchInterval: REVIEW_POLL_MS,
  });
  const shownFilterCount = isFiltered ? (filterCount.data ?? null) : null;
  const reportCount = useRef(onFilterCount);
  useEffect(() => {
    reportCount.current = onFilterCount;
  });
  useEffect(() => {
    reportCount.current?.(shownFilterCount);
  }, [shownFilterCount]);
  useEffect(() => () => reportCount.current?.(null), []);
  const chosen = rows.filter((row) => selected.has(row.jobId)).map((row) => row.jobId);
  const askCount = asking?.scope === 'all' ? (allCount.data?.count ?? null) : chosen.length;
  const askWords = asking && askCount !== null ? unverifiedBulkConfirm(asking.action, askCount, asking.scope === 'all') : null;

  const changeFilter = (next: UnverifiedFilter) => {
    setFilter(next);
    setSelected(new Set());
    setOutcomes(new Map());
    anchor.current = null;
  };
  const choose = (jobId: number, on: boolean, shiftKey: boolean) => {
    const index = rows.findIndex((row) => row.jobId === jobId);
    const from = shiftKey && anchor.current !== null ? Math.min(anchor.current, index) : index;
    const to = shiftKey && anchor.current !== null ? Math.max(anchor.current, index) : index;
    setSelected((current) => {
      const next = new Set(current);
      for (const row of rows.slice(from, to + 1)) {
        if (on) next.add(row.jobId);
        else next.delete(row.jobId);
      }
      return next;
    });
    anchor.current = index;
  };
  const chooseAll = (on: boolean) => {
    anchor.current = null;
    setSelected(on ? new Set(rows.map((row) => row.jobId)) : new Set());
  };

  /** Runs the asked bulk action; the confirm stays open (busy) with its progress until it is done. */
  const runAsked = async (ask: BulkAsk) => {
    const verb = ask.action === 'approve' ? 'Approved' : 'Rejected';
    let outcome: UnverifiedOutcome;
    try {
      if (ask.scope === 'all') {
        const upTo = allCount.data?.upTo;
        outcome = await runUnverifiedAll(
          () => allUnverified(ask.action, filter, upTo),
          (sofar) => setProgress(`${verb} ${sofar.done.toLocaleString('en-US')} so far${sofar.left > 0 ? `; ${sofar.left.toLocaleString('en-US')} to go` : ''}...`),
        );
      } else {
        outcome = await runUnverifiedBulk(ask.action, chosen, (ids) => bulkUnverified(ask.action, ids), userMessage);
      }
    } catch (error) {
      setProgress(null);
      throw new Error(userMessage(error));
    }
    setProgress(null);
    setAsking(null);
    setResult(outcome);
    setOutcomes(new Map(outcome.items.filter((item) => item.outcome === 'skipped').map((item) => [item.jobId, item.message ?? 'Skipped.'] as const)));
    setSelected(new Set());
    anchor.current = null;
    onLive(outcome.message);
    refresh();
    focusSoon([`${PANE} [data-unverified-result] button`, `${PANE} [aria-label="Couldn't verify: from"]`]);
  };

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

  const empty = unverifiedEmptyText(listOn);
  const filtered = filter.from !== 'all' || filter.runId !== null;
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
    body =
      filtered && listOn !== false ? (
        <EmptyState
          icon={<ShieldCheckIcon size={22} />}
          title="No link matches"
          description="Nothing from there waits here."
          action={
            <Button variant="outline" size="sm" onClick={() => changeFilter({ from: 'all', runId: null })}>
              Show every link
            </Button>
          }
        />
      ) : (
        <EmptyState icon={<ShieldCheckIcon size={22} />} title={empty.title} description={empty.description} />
      );
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
              checked={selected.has(row.jobId)}
              onChecked={(on, shiftKey) => choose(row.jobId, on, shiftKey)}
              outcome={outcomes.get(row.jobId) ?? null}
              busy={busy.has(row.jobId)}
              onApprove={canApprove(row) ? () => setApproving(row) : undefined}
              onRetry={() => void retry(row)}
              onReject={() => setRejecting(row)}
            />
          ))}
        </ul>
        {/* v35 OPSWEB: the chosen rows' Approve and Reject, stuck to the window's foot while rows are chosen. */}
        {chosen.length > 0 && (
          <SelectBar
            aria-label="Approve or reject the chosen links"
            selected={chosen.length}
            selectable={rows.length}
            selectAllLabel="Select every link shown"
            onSelectAll={chooseAll}
          >
            {/* v35 INT-B: the three buttons wrap on a phone (Clear on its own line), never past the window's edge. */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2" data-unverified-bar-actions="">
              <Button
                size="sm"
                className="max-sm:h-11 max-sm:flex-1"
                icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />}
                aria-haspopup="dialog"
                onClick={() => setAsking({ scope: 'selected', action: 'approve' })}
              >
                Approve selected
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="max-sm:h-11 max-sm:flex-1"
                icon={<XIcon size={14} weight="bold" aria-hidden="true" />}
                aria-haspopup="dialog"
                onClick={() => setAsking({ scope: 'selected', action: 'reject' })}
              >
                Reject selected
              </Button>
              <Button size="sm" variant="ghost" className="max-sm:h-11" onClick={() => chooseAll(false)}>
                Clear
              </Button>
            </div>
          </SelectBar>
        )}
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
        {/* v35 OPSWEB (PLAN H3): where the links came from, and the filter's and the page's bulk actions. */}
        <div className="flex flex-wrap items-center gap-2" data-unverified-tools="">
          {/* v35 FIX-WEB (L6): a visible "From" beside the select (its name says "from" too). */}
          <span className="flex w-full min-w-0 items-center gap-2 sm:w-auto" data-unverified-from="">
            <span aria-hidden="true" className="shrink-0 text-[13px] leading-5 font-medium text-muted-foreground">
              From
            </span>
            <Select
              aria-label="Couldn't verify: from"
              size="sm"
              className="min-w-0 flex-1 sm:w-64 sm:flex-none max-sm:h-11"
              value={unverifiedFromValue(filter)}
              onValueChange={(value) => changeFilter(unverifiedFilterOf(value))}
              options={fromOptions(UNVERIFIED_WAYS, imports.data?.items ?? [], filter.runId)}
            />
          </span>
          {rows.length > 0 && (
            <>
              <Button variant="ghost" size="sm" className="max-sm:h-11" onClick={() => chooseAll(true)} data-unverified-select-all="">
                Select all shown
              </Button>
              <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
                <Button
                  variant="outline"
                  size="sm"
                  className="max-sm:h-11"
                  icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />}
                  aria-haspopup="dialog"
                  onClick={() => setAsking({ scope: 'all', action: 'approve' })}
                >
                  Approve all
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="max-sm:h-11"
                  icon={<XIcon size={14} weight="bold" aria-hidden="true" />}
                  aria-haspopup="dialog"
                  onClick={() => setAsking({ scope: 'all', action: 'reject' })}
                >
                  Reject all
                </Button>
                <HelpTip label="Approve all and Reject all">Every link the From filter matches, shown or not.</HelpTip>
              </span>
            </>
          )}
        </div>
      </div>
      {/* v35 OPSWEB: what the last bulk action did, in one line, until dismissed. */}
      <div aria-live="polite">
        {result && (
          <div className="mx-4 mt-3 sm:mx-5" data-unverified-result="">
            <Notice
              tone={result.left > 0 || result.skipped > 0 ? 'warning' : 'success'}
              title={result.message}
              action={
                <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                  Dismiss
                </Button>
              }
            />
          </div>
        )}
      </div>
      <div data-unverified-lane="">{body}</div>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (open || progress !== null) return;
          setAsking(null);
        }}
        tone={asking?.action === 'reject' ? 'destructive' : 'primary'}
        title={askWords?.title ?? (asking?.action === 'reject' ? 'Reject every link shown?' : 'Approve every link shown?')}
        description={
          allCount.isError && asking?.scope === 'all'
            ? `The links could not be counted. ${userMessage(allCount.error)}`
            : askWords
              ? askCount === 0
                ? 'Nothing to change: no link matches the filter now.'
                : askWords.description
              : 'Counting the links...'
        }
        confirmLabel={askWords && askCount ? askWords.confirm : asking?.action === 'reject' ? 'Reject' : 'Approve'}
        busyLabel={asking?.action === 'reject' ? 'Rejecting...' : 'Approving...'}
        confirmDisabled={!askWords || !askCount}
        // Publishing to everyone opens on Cancel, so a quick Enter never publishes (v32 INT-2, UXREQ-12).
        focusCancel
        finalFocus={() => false}
        onConfirm={async () => {
          if (asking) await runAsked(asking);
        }}
      >
        {progress && (
          <p className="text-[13px] text-muted-foreground" role="status" data-unverified-progress="">
            {progress}
          </p>
        )}
      </ConfirmDialog>
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
  checked,
  onChecked,
  outcome = null,
}: {
  row: UnverifiedLink;
  now: number;
  busy: boolean;
  onApprove?: (() => void) | undefined;
  onRetry: () => void;
  onReject: () => void;
  /** v35 OPSWEB: the row's checkbox (absent: none) and what a bulk action did to it. */
  checked?: boolean;
  onChecked?: (on: boolean, shiftKey: boolean) => void;
  outcome?: string | null;
}) {
  const name = linkName(row.url);
  const captured = capturedLine(row);
  const versions = versionsText(row);
  const reason = rowReasonText(row);
  const origin = rowOriginText(row); // v35 OPSWEB
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
      {onChecked && (
        <span className="mt-0.5 flex shrink-0 max-sm:min-h-11 max-sm:items-start">
          <Checkbox checked={Boolean(checked)} onCheckedChange={(on, details) => onChecked(on, details.shiftKey)} aria-label={`Select ${name}`} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2 @2xl/pane:flex-row @2xl/pane:items-start @2xl/pane:gap-3">
        <div className="min-w-0 flex-1" data-review-text="">
          <p className="text-sm leading-5 font-semibold break-words text-foreground">{row.host}</p>
          {origin && (
            <p className="text-[13px] leading-5 break-words text-muted-foreground" data-unverified-origin={row.from}>
              {origin}
            </p>
          )}
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
          {outcome && (
            <p className="text-[13px] leading-5 font-medium text-warning" data-row-outcome="">
              Skipped: {outcome}
            </p>
          )}
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
