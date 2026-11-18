'use client';

import {
  type AdminFlag,
  type AdminReviewCounts,
  type AdminReviewRow,
  type JobReviewKind,
  type ReviewDecision,
  type ReviewStateFilter,
} from '@tailorit/shared/reviews';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { CheckIcon, ShieldCheckIcon, XIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { SearchPill } from '@/components/ui/SearchPill';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ShowMoreButton } from '@/components/admin';
import { userMessage } from '@/lib/api';
import { focusLater, focusSoon } from '@/lib/focusLater';
import { useNow } from '@/lib/useNow';
import { Pane, SelectBar } from '../../../../components/queue';
import { bulkFlags, bulkReviews, decideFlag, decideReview, fetchFlags, fetchReviewCounts, fetchReviews, reviewKeys, type ReviewListQuery } from './api';
import { AutoApproveStrip } from './AutoApprove';
import { BulkDialog, type BulkAction } from './BulkDialog';
import {
  bulkSummary,
  chunkIds,
  decidedText,
  emptyText,
  groupFlagRows,
  groupReviewRows,
  laneCount,
  laneFromAddress,
  laneLabel,
  mergeBulkAnswers,
  REVIEW_POLL_MS,
  REVIEW_SEARCH_DEBOUNCE_MS,
  rowName,
  rowOutcomeText,
  stateFilterLabel,
  stateFiltersOf,
  stateForLane,
  type BulkAnswer,
  type BulkRowResult,
  type RowGroup,
} from './copy';
import { FlagRowView, ReviewRowView, type FlagChange } from './ReviewRows';
import { ReviewSheet } from './ReviewSheet';
import { UnverifiedLane } from './UnverifiedLane'; // v31 ADMINWEB
import { ADMIN_REVIEW_LANE_LABEL, ADMIN_REVIEW_LANES, fetchUnverifiedCount, isQueueLane, type AdminReviewLane } from './unverified'; // v31 ADMINWEB

// v30 X1-WEB: Admin › Review's queue (docs/design/part2/14-extension-reports.md §6.2), on components/queue like the
// Auto-apply page's Queue pane: the lane tabs (a select at phone width) with their counts, the state filter, a search,
// the auto-approve strip, the rows in their groups, a select mode with its action bar (one request per 100 rows, each
// row saying what happened), the evidence sheet, one polite live region, and a read every 30 s while the tab is
// visible, paused while an action is in flight.
// v31 ADMINWEB: a fourth lane, "Couldn't verify" (UnverifiedLane: LINK's links TailorIT could not read, Retry read and
// Reject only); its count comes from GET /api/admin/jobs/unverified/count, and the other lanes' counts from the counts
// route while it is open.

/** `value`, once it has stayed the same for `delay` ms. */
function useSettled(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

const PANE_TITLE_ID = 'review-pane-title';

// v30 FIX-WEB (REV-UX UX-4): where focus goes when the control that had it goes (WCAG 2.4.3), scoped to the pane.
const PANE = '[data-review-pane]';
const SELECT_BAR = (reviewing: boolean) =>
  `${PANE} [role="toolbar"][aria-label="${reviewing ? 'Approve or reject the selected reviews' : 'Resolve or dismiss the selected flags'}"]`;
/** After the select mode ends: Select again, else the first row's action, else the lane's tab. */
const AFTER_SELECT_MODE = [
  `${PANE} [data-review-select]:not([disabled])`,
  `${PANE} li [data-row-action]`,
  `${PANE} [role="tab"][aria-selected="true"]`,
];
/** After the empty state's button went: the search box, else the first row's action. */
const AFTER_EMPTY = [`${PANE} input[type="search"]`, `${PANE} li [data-row-action]`];

export function ReviewPane({
  onCounts,
}: {
  /** The lanes' counts (v31 ADMINWEB: and "Couldn't verify"'s, null while it loads). */
  onCounts: (counts: AdminReviewCounts | undefined, unverified: number | null) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();

  const [lane, setLane] = useState<AdminReviewLane>(() => laneFromAddress(searchParams.get('tab'), searchParams.get('lane')));
  const [state, setState] = useState<ReviewStateFilter>('needs_review');
  const [search, setSearch] = useState('');
  const q = useSettled(search.trim(), REVIEW_SEARCH_DEBOUNCE_MS);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<number, BulkRowResult>>(new Map());
  const [sheetRow, setSheetRow] = useState<AdminReviewRow | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [live, setLive] = useState('');
  const inFlight = busy.size > 0 || bulkBusy;

  const list: ReviewListQuery = { state, q };
  const poll = inFlight ? false : REVIEW_POLL_MS;
  const reviewLane: JobReviewKind = lane === 'new_job' ? 'new_job' : 'closed';
  const reviewing = lane === 'closed' || lane === 'new_job';
  const unverifiedLane = lane === 'unverified';
  const reviews = useInfiniteQuery({
    queryKey: reviewKeys.lane(reviewLane, state, q),
    queryFn: ({ pageParam, signal }) => fetchReviews(reviewLane, { ...list, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: reviewing,
    refetchInterval: poll,
  });
  const flags = useInfiniteQuery({
    queryKey: reviewKeys.lane('flags', state, q),
    queryFn: ({ pageParam, signal }) => fetchFlags({ ...list, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: lane === 'flags',
    refetchInterval: poll,
  });
  // v31 ADMINWEB: the counts route (the admin nav's, so one cache) while "Couldn't verify" is open; its own count beside.
  const countsRoute = useQuery({ queryKey: reviewKeys.counts, queryFn: ({ signal }) => fetchReviewCounts(signal), enabled: unverifiedLane, refetchInterval: REVIEW_POLL_MS });
  const unverifiedCount = useQuery({ queryKey: reviewKeys.unverifiedCount, queryFn: ({ signal }) => fetchUnverifiedCount(signal), refetchInterval: REVIEW_POLL_MS });
  const unverified = unverifiedCount.data ?? null;
  const active = lane === 'flags' ? flags : reviews;
  const counts = unverifiedLane
    ? (countsRoute.data ?? reviews.data?.pages[0]?.counts ?? flags.data?.pages[0]?.counts)
    : (active.data?.pages[0]?.counts ?? (lane === 'flags' ? reviews : flags).data?.pages[0]?.counts);
  useEffect(() => onCounts(counts, unverified), [counts, unverified, onCounts]);

  const reviewRows = useMemo(() => (lane === 'flags' ? [] : (reviews.data?.pages.flatMap((page) => page.items) ?? [])), [lane, reviews.data]);
  const flagRows = useMemo(() => (lane === 'flags' ? (flags.data?.pages.flatMap((page) => page.items) ?? []) : []), [lane, flags.data]);
  const loaded = active.data !== undefined;
  const rowCount = lane === 'flags' ? flagRows.length : reviewRows.length;
  const decidable = lane === 'flags' ? flagRows.filter((flag) => flag.status === 'open').map((flag) => flag.id) : reviewRows.filter((row) => row.state === 'pending').map((row) => row.id);
  const chosen = decidable.filter((id) => selected.has(id));

  // Focus stays in the list when a decided row leaves it (the Needs review view drops it): it goes to the row now in its
  // place, else to the pane's first control. While focus is still on that row (its new action, or the sheet's
  // trigger given back), it waits; once the person moved focus elsewhere, it lets go.
  const focusAt = useRef<{ id: number; index: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const want = focusAt.current;
    if (want === null || inFlight) return;
    const activeElement = document.activeElement;
    if (activeElement?.closest('[role="dialog"], [role="alertdialog"]')) return;
    if (activeElement && activeElement !== document.body) {
      if (!activeElement.closest(`[data-review-row="${want.id}"], [data-flag-row="${want.id}"]`)) focusAt.current = null;
      return;
    }
    focusAt.current = null;
    const pane = listRef.current;
    const rows = pane?.querySelectorAll<HTMLElement>('li[data-review-row], li[data-flag-row]') ?? [];
    const row = rows.length > 0 ? rows[Math.min(want.index, rows.length - 1)] : null;
    const target = row
      ? (row.querySelector<HTMLElement>('[data-row-action]') ?? row.querySelector<HTMLElement>('button'))
      : (pane?.querySelector<HTMLElement>('[data-pane-body] button') ?? pane?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'));
    target?.focus();
  }, [reviewRows, flagRows, inFlight, sheetOpen]);

  const focusAfter = (id: number) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('li[data-review-row], li[data-flag-row]') ?? [])];
    const index = Math.max(0, rows.findIndex((row) => row.dataset.reviewRow === String(id) || row.dataset.flagRow === String(id)));
    focusAt.current = { id, index };
  };

  const changeLane = (next: AdminReviewLane) => {
    if (next === lane) return;
    setLane(next);
    setState((current) => stateForLane(next, current));
    setSelectMode(false);
    setSelected(new Set());
    setOutcomes(new Map());
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'review');
    params.set('lane', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const changeState = (next: ReviewStateFilter) => {
    setState(next);
    setSelected(new Set());
    setOutcomes(new Map());
  };

  const refresh = () => void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
  const markBusy = (id: number, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const forget = (id: number) =>
    setOutcomes((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });

  const decide = async (row: AdminReviewRow, decision: ReviewDecision, note = '') => {
    if (busy.has(row.id)) return;
    markBusy(row.id, true);
    forget(row.id);
    focusAfter(row.id);
    try {
      await decideReview(row.id, note ? { decision, note } : { decision });
      setLive(`${decidedText(decision)}: ${rowName(row.job)}`);
      setSheetOpen(false);
    } catch (error) {
      focusAt.current = null;
      toast.error('The review was not changed', userMessage(error));
    } finally {
      markBusy(row.id, false);
      refresh();
    }
  };

  const changeFlag = async (flag: AdminFlag, change: FlagChange) => {
    if (busy.has(flag.id)) return;
    markBusy(flag.id, true);
    forget(flag.id);
    focusAfter(flag.id);
    try {
      await decideFlag(flag.id, change);
      const words = change.status === 'open' ? 'Reopened' : change.closeJob ? 'Resolved and the job closed' : change.status === 'resolved' ? 'Resolved' : 'Dismissed';
      setLive(`${words}: ${rowName(flag.job)}`);
    } catch (error) {
      focusAt.current = null;
      toast.error('The flag was not changed', userMessage(error));
    } finally {
      markBusy(flag.id, false);
      refresh();
    }
  };

  const runBulk = async (action: BulkAction, note: string) => {
    const ids = chosen;
    setBulkAction(null);
    if (ids.length === 0) return;
    setBulkBusy(true);
    const answers: BulkAnswer[] = [];
    // One request per ADMIN_BULK_MAX rows (14 §6.2); a request that fails marks its rows failed and the next goes on.
    for (const chunk of chunkIds(ids)) {
      try {
        if (action === 'approve' || action === 'reject') {
          answers.push(await bulkReviews(note ? { ids: chunk, decision: action, note } : { ids: chunk, decision: action }));
        } else {
          answers.push(await bulkFlags({ ids: chunk, status: action }));
        }
      } catch (error) {
        answers.push({ results: chunk.map((id) => ({ id, outcome: 'failed', message: userMessage(error) })), counts: { failed: chunk.length } });
      }
    }
    const merged = mergeBulkAnswers(answers);
    const summary = bulkSummary(merged.counts);
    setOutcomes(new Map(merged.results.map((result) => [Number(result.id), result] as const)));
    setLive(summary);
    if ((merged.counts.failed ?? 0) > 0) toast.error(summary, 'The rows that failed say why.');
    else toast.success(summary);
    setSelectMode(false);
    setSelected(new Set());
    setBulkBusy(false);
    refresh();
    // v30 FIX-WEB (UX-4): the bar went with the select mode: focus back to Select (or the first row still to decide),
    // once the page has re-rendered after the requests.
    focusSoon(AFTER_SELECT_MODE);
  };

  const toggle = (id: number, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const filters = stateFiltersOf(lane);
  const controls = (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        aria-label="Review lanes"
        className="max-sm:hidden"
        value={lane}
        onValueChange={changeLane}
        items={ADMIN_REVIEW_LANES.map((value) => ({ value, label: laneLabel(value, counts, unverified) }))}
      />
      <Select
        aria-label="Review lane"
        className="w-full sm:hidden"
        size="lg"
        value={lane}
        onValueChange={changeLane}
        options={ADMIN_REVIEW_LANES.map((value) => ({ value, label: laneLabel(value, counts, unverified) }))}
      />
      {/* v31 ADMINWEB: "Couldn't verify" has no state filter, search or select mode. */}
      {!unverifiedLane && (
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            aria-label="Show reviews"
            size="sm"
            listClassName="max-sm:h-11"
            value={state}
            onValueChange={changeState}
            items={filters.map((value) => ({ value, label: stateFilterLabel(value) }))}
          />
          <SearchPill
            value={search}
            onValueChange={setSearch}
            label="Search by job title or company"
            placeholder="Search title or company"
            className="w-full sm:ml-auto sm:w-64 max-sm:h-11"
          />
          {!selectMode && (
            <Button
              variant="ghost"
              size="sm"
              className="max-sm:h-11"
              disabled={decidable.length === 0}
              data-review-select=""
              onClick={() => {
                setSelectMode(true);
                // v30 FIX-WEB (UX-4): the bar replaces the button: focus goes to its first control.
                focusLater(`${SELECT_BAR(lane !== 'flags')} [role="checkbox"]`, `${SELECT_BAR(lane !== 'flags')} button`);
              }}
            >
              Select
            </Button>
          )}
        </div>
      )}
    </div>
  );

  const footer = selectMode && !unverifiedLane ? (
    <SelectBar
      aria-label={reviewing ? 'Approve or reject the selected reviews' : 'Resolve or dismiss the selected flags'}
      selected={chosen.length}
      selectable={decidable.length}
      selectAllLabel={reviewing ? 'Select every review shown that needs a decision' : 'Select every open flag shown'}
      onSelectAll={(on) => setSelected(on ? new Set(decidable) : new Set())}
    >
      <Button
        size="sm"
        className="max-sm:h-11 max-sm:flex-1"
        icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />}
        disabled={chosen.length === 0}
        loading={bulkBusy}
        onClick={() => setBulkAction(reviewing ? 'approve' : 'resolved')}
      >
        {reviewing ? 'Approve' : 'Resolve'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="max-sm:h-11 max-sm:flex-1"
        icon={<XIcon size={14} weight="bold" aria-hidden="true" />}
        disabled={chosen.length === 0 || bulkBusy}
        onClick={() => setBulkAction(reviewing ? 'reject' : 'dismissed')}
      >
        {reviewing ? 'Reject' : 'Dismiss'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="max-sm:h-11"
        disabled={bulkBusy}
        onClick={() => {
          setSelectMode(false);
          setSelected(new Set());
          focusLater(...AFTER_SELECT_MODE); // v30 FIX-WEB (UX-4)
        }}
      >
        Cancel
      </Button>
    </SelectBar>
  ) : undefined;

  let body: ReactNode;
  if (active.isError && !loaded) {
    body = (
      <div className="p-4 sm:p-5">
        <Notice
          tone="error"
          title="The review queue could not be loaded"
          action={
            <Button variant="outline" size="sm" onClick={() => void active.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(active.error)}
        </Notice>
      </div>
    );
  } else if (!loaded) {
    body = (
      <ul aria-busy="true" aria-label="Loading the review queue" className="divide-y divide-divider-soft">
        {Array.from({ length: 5 }, (_unused, index) => (
          <li key={index} aria-hidden="true" className="flex min-h-20 items-start gap-3 px-5 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-2/5" />
            </div>
            <Skeleton className="h-8 w-40" rounded="control" />
          </li>
        ))}
      </ul>
    );
  } else if (rowCount === 0 && isQueueLane(lane)) {
    const empty = emptyText(lane, state, q !== '');
    body = (
      <EmptyState
        icon={<ShieldCheckIcon size={22} />}
        title={empty.title}
        description={empty.description}
        action={
          q !== '' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch('');
                focusLater(...AFTER_EMPTY); // v30 FIX-WEB (UX-4): the search box, emptied
              }}
            >
              Clear the search
            </Button>
          ) : state !== 'all' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                changeState('all');
                focusLater(`${PANE} li [data-row-action]`, `${PANE} [aria-label="Show reviews"] [role="tab"][aria-selected="true"]`, ...AFTER_EMPTY); // v30 FIX-WEB (UX-4)
              }}
            >
              Show everything in this lane
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    const groups: RowGroup<AdminReviewRow | AdminFlag>[] = lane === 'flags' ? groupFlagRows(flagRows, now) : groupReviewRows(reviewRows);
    body = (
      <>
        {active.isError && (
          <Notice
            tone="warning"
            className="mx-4 mt-3 sm:mx-5"
            title="The review queue could not be refreshed"
            action={
              <Button variant="outline" size="sm" onClick={() => void active.refetch()}>
                Try again
              </Button>
            }
          >
            What is shown may be out of date.
          </Notice>
        )}
        {groups.map(({ group, title, rows }) => (
          <section key={group} aria-labelledby={`review-group-${group}`} data-review-group={group}>
            <h3
              id={`review-group-${group}`}
              className="flex items-center gap-2 border-y border-border bg-surface-low px-4 py-1.5 text-xs leading-5 font-semibold text-muted-foreground sm:px-5"
            >
              <span>{title}</span>
              <span className="tabular-nums">{rows.length}</span>
            </h3>
            <ul className="divide-y divide-divider-soft" aria-labelledby={`review-group-${group}`}>
              {lane === 'flags'
                ? (rows as AdminFlag[]).map((flag) => (
                    <FlagRowView
                      key={flag.id}
                      flag={flag}
                      now={now}
                      selectMode={selectMode}
                      checked={selected.has(flag.id)}
                      onChecked={(on) => toggle(flag.id, on)}
                      busy={busy.has(flag.id) || (bulkBusy && selected.has(flag.id))}
                      outcome={rowOutcomeText(outcomes.get(flag.id))}
                      onChange={(change) => void changeFlag(flag, change)}
                    />
                  ))
                : (rows as AdminReviewRow[]).map((row) => (
                    <ReviewRowView
                      key={row.id}
                      row={row}
                      now={now}
                      selectMode={selectMode}
                      checked={selected.has(row.id)}
                      onChecked={(on) => toggle(row.id, on)}
                      busy={busy.has(row.id) || (bulkBusy && selected.has(row.id))}
                      outcome={rowOutcomeText(outcomes.get(row.id))}
                      onDecide={(decision) => void decide(row, decision)}
                      onOpen={() => {
                        setSheetRow(row);
                        setSheetOpen(true);
                      }}
                    />
                  ))}
            </ul>
          </section>
        ))}
        {/* v30 FIX-WEB (UX-4): focus stays on Load more while the next page loads; after the last, on the last row. */}
        <ShowMoreButton
          hasMore={active.hasNextPage}
          loading={active.isFetchingNextPage}
          onMore={() => void active.fetchNextPage()}
          afterLast={[`${PANE} li[data-review-row]:last-of-type [data-row-action]`, `${PANE} li[data-flag-row]:last-of-type [data-row-action]`]}
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
      <div ref={listRef} data-review-pane="">
        <Pane
          id={PANE_TITLE_ID}
          title={ADMIN_REVIEW_LANE_LABEL[lane]}
          count={unverifiedLane ? unverified : loaded ? laneCount(counts, lane) : null}
          controls={controls}
          scroll={false}
          footer={footer}
        >
          {isQueueLane(lane) ? (
            <>
              <AutoApproveStrip lane={lane} />
              {body}
            </>
          ) : (
            <UnverifiedLane onLive={setLive} />
          )}
          <p className="sr-only" role="status" aria-live="polite" data-review-live="">
            {live}
          </p>
        </Pane>
      </div>
      {reviewing && (
        <ReviewSheet
          row={sheetRow}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          busy={sheetRow !== null && busy.has(sheetRow.id)}
          onDecide={(row, decision, note) => void decide(row, decision, note)}
        />
      )}
      <BulkDialog
        action={bulkAction}
        count={chosen.length}
        thing={reviewing ? 'review' : 'flag'}
        onCancel={() => setBulkAction(null)}
        onConfirm={(action, note) => void runBulk(action, note)}
      />
    </>
  );
}
