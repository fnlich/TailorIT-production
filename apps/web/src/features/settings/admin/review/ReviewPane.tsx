'use client';

import {
  REVIEW_STATE_DEFAULT,
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
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'; // v32 ADMINAPP (E6)
import { EmptyState } from '@/components/ui/EmptyState';
import { CheckIcon, ShieldCheckIcon, XIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { SearchPill } from '@/components/ui/SearchPill';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { focusLater, focusSoon } from '@/lib/focusLater';
import { useNow } from '@/lib/useNow';
import { ListEnd, Pane, SelectBar, useConfirmReturn, useLoadOnScroll } from '../../../../components/queue'; // v37 FIX-REV: useConfirmReturn
import {
  bulkFlags,
  bulkReviews,
  decideFlag,
  decideReview,
  fetchFlags,
  fetchReviewCounts,
  fetchReviews,
  retryReviewRead,
  reviewKeys,
  type ReviewListQuery,
} from './api';
import { LOADED_ROWS_NOTE, allLine, allProgressText, allScopeOf, fetchAllCount, runAllTurns, selectAllTip, selectAllWords, sendAll, type AllLane } from './all'; // v37 REVIEW; v37 FIX-REV: LOADED_ROWS_NOTE
import { AllDialog, type AllAsk } from './AllDialog'; // v37 REVIEW
import { AutoApproveStrip } from './AutoApprove';
import { BulkDialog, type BulkAction } from './BulkDialog';
import {
  CAPTURED_APPROVE_COPY,
  approvesCaptured,
  retriesRead,
  reviewRetryText,
  bulkSummary,
  chunkIds,
  decidedText,
  emptyText,
  laneFromAddress,
  laneHeadCount,
  laneLabel,
  mergeBulkAnswers,
  openingLane,
  REVIEW_POLL_MS,
  REVIEW_SEARCH_DEBOUNCE_MS,
  rowName,
  rowOutcomeText,
  stateFilterLabel,
  stateFiltersOf,
  stateForLane,
  viewNarrowed,
  type BulkAnswer,
  type BulkRowResult,
} from './copy';
import { FlagRowView, ReviewRowView, type FlagChange } from './ReviewRows';
import { ReviewSheet } from './ReviewSheet';
import { UnverifiedLane } from './UnverifiedLane'; // v31 ADMINWEB
import { ADMIN_REVIEW_LANE_LABEL, ADMIN_REVIEW_LANES, fetchUnverifiedCount, filteredHeadCount, isQueueLane, type AdminReviewLane } from './unverified'; // v31 ADMINWEB
import { NEW_JOB_WAYS, fetchRecentImports, fromOptions, newJobFilterFromAddress, newJobFilterOf, newJobFilterQuery, newJobFromValue, type NewJobFilter } from './from'; // v35 OPSWEB

// v30 X1-WEB: Admin › Review's queue (docs/design/part2/14-extension-reports.md §6.2), on components/queue like the
// Auto-apply page's Queue pane: the lane tabs (a select at phone width) with their counts, the state filter, a search,
// the auto-approve strip, the rows, a select mode with its action bar (one request per 100 rows, each row saying what
// happened), the evidence sheet, one polite live region, and a read every 30 s while the tab is visible, paused while
// an action is in flight.
// v31 ADMINWEB: a fourth lane, "Couldn't verify" (UnverifiedLane: LINK's links TailorIT could not read, Retry read and
// Reject only); its count comes from GET /api/admin/jobs/unverified/count, and the other lanes' counts from the counts
// route.
// v32 ADMINAPP (E6, the owner's "admin should be able to approve manually"): Couldn't verify's rows lead with Approve;
// a v3.0 page review's Approve asks first, then approves it as captured when TailorIT still cannot read its page
// (`captured`: the job is published as the reporters' browsers captured it, marked "Approved by an admin").
// v37 REVIEW (SP v37 PLAN.md R1-R4, the owner's "admin currently can't see the whole jobs for review"):
//   - R1: every lane loads as you scroll, 100 rows a page (components/queue ListEnd: "Loading more...", an error with
//     Try again, "All 340 shown"); no Load more button. The rows are one list in the server's order.
//   - R2: a lane opens on Waiting (needs review and checking, a "Checking" tag on the rows TailorIT is checking), which
//     is what its count counts; the header says the list's total, "12 of 340" while a search, the From filter or Needs
//     review / Checking narrows it.
//   - R3: the select bar's "Select all 340" takes every item the filter matches, loaded or not; its Approve / Reject
//     (Resolve / Dismiss on Flags) then run on the server for all of them (all.ts, AllDialog: the count, the progress,
//     one result line). New jobs' own Approve all / Reject all buttons went: "Select all N" does it on every lane.
//   - R4: with no lane in the address, Review opens on the first lane with items (as the admins' bell links).
// v37 FIX-REV (SP v37 FIXES-361.md, REVIEW361-ux): the "all" confirm gives focus back to the bar's action on Cancel (M1)
// and can be stopped after a turn (L6); unticking a row under "Select all N" says the selection is the rows loaded so
// far (L5); Try again at the list's end keeps focus (L2); the phone selects are 44 px (L1); New jobs' Select sits on
// the From line (L7).

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
/** v37 REVIEW (R1): a lane's rows, as the list's keyboard look-ahead finds them. */
const ROWS = 'li[data-review-row], li[data-flag-row]';

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

  // v37 REVIEW (R4): the address's lane, else (null) the first lane with items once the counts are read.
  const [pickedLane, setPickedLane] = useState<AdminReviewLane | null>(() => laneFromAddress(searchParams.get('tab'), searchParams.get('lane')));
  const [state, setState] = useState<ReviewStateFilter>(REVIEW_STATE_DEFAULT);
  const [search, setSearch] = useState('');
  const q = useSettled(search.trim(), REVIEW_SEARCH_DEBOUNCE_MS);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  // v37 REVIEW (R3): "Select all N": every item the filter matches, loaded or not (a decision then runs on the server).
  const [allMode, setAllMode] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<number, BulkRowResult>>(new Map());
  const [sheetRow, setSheetRow] = useState<AdminReviewRow | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [capturing, setCapturing] = useState<{ row: AdminReviewRow; note: string } | null>(null); // v32 ADMINAPP (E6)
  const [live, setLive] = useState('');
  // v35 OPSWEB (PLAN H3): New jobs' From filter (`run=` in the address: one import).
  const [newJobFilter, setNewJobFilter] = useState<NewJobFilter>(() => newJobFilterFromAddress(searchParams));
  const [allAsk, setAllAsk] = useState<AllAsk | null>(null);
  const [allProgress, setAllProgress] = useState<string | null>(null);
  // v37 FIX-REV (REVIEW361-ux M1, L5, L6): where the "all" confirm gives focus back; whether a row was unticked under
  // "Select all N" (the selection is the loaded rows now); Stop pressed while "all" works.
  const allReturn = useConfirmReturn();
  const [loadedOnly, setLoadedOnly] = useState(false);
  const stopAll = useRef(false);
  const [stopping, setStopping] = useState(false);
  // v35 FIX-WEB (L5): Couldn't verify's From filter's count, while one is on (the header reads "2 of 7").
  const [unverifiedFiltered, setUnverifiedFiltered] = useState<number | null>(null);
  const inFlight = busy.size > 0 || bulkBusy || allAsk !== null;

  // v31 ADMINWEB: the counts route (the admin nav's, so one cache) and Couldn't verify's count. v37 REVIEW (R4): read on
  // every lane: they choose the lane Review opens on.
  const countsRoute = useQuery({ queryKey: reviewKeys.counts, queryFn: ({ signal }) => fetchReviewCounts(signal), refetchInterval: REVIEW_POLL_MS });
  const unverifiedCount = useQuery({ queryKey: reviewKeys.unverifiedCount, queryFn: ({ signal }) => fetchUnverifiedCount(signal), refetchInterval: REVIEW_POLL_MS });
  const unverified = unverifiedCount.data ?? null;
  const opening = openingLane(pickedLane, countsRoute.data, unverified, countsRoute.isError || unverifiedCount.isError);
  useEffect(() => {
    if (pickedLane === null && opening !== null) setPickedLane(opening);
  }, [pickedLane, opening]);
  const lane: AdminReviewLane = opening ?? 'closed';
  const laneKnown = opening !== null;

  const newJobs = lane === 'new_job';
  const fromKey = newJobs ? newJobFromValue(newJobFilter) : 'all';
  const fromFiltered = newJobs && fromKey !== 'all';
  const list: ReviewListQuery = { state, q, ...(newJobs ? newJobFilterQuery(newJobFilter) : {}) };
  const poll = inFlight ? false : REVIEW_POLL_MS;
  const reviewLane: JobReviewKind = lane === 'new_job' ? 'new_job' : 'closed';
  const reviewing = lane === 'closed' || lane === 'new_job';
  const unverifiedLane = lane === 'unverified';
  const reviews = useInfiniteQuery({
    queryKey: reviewKeys.lane(reviewLane, state, q, fromKey),
    queryFn: ({ pageParam, signal }) => fetchReviews(reviewLane, { ...list, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: laneKnown && reviewing,
    refetchInterval: poll,
  });
  const flags = useInfiniteQuery({
    queryKey: reviewKeys.lane('flags', state, q),
    queryFn: ({ pageParam, signal }) => fetchFlags({ ...list, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: laneKnown && lane === 'flags',
    refetchInterval: poll,
  });
  // v35 OPSWEB: the recent imports New jobs' From filter offers.
  const imports = useQuery({ queryKey: ['admin', 'imports', 'recent'], queryFn: ({ signal }) => fetchRecentImports(signal), enabled: newJobs, staleTime: 60_000 });
  // v37 REVIEW (R3): what "Select all N" decides, and its count (read when the confirm opens; its `upTo` goes back).
  const allLane: AllLane = lane === 'flags' ? 'flags' : reviewLane;
  const scope = allScopeOf(allLane, state, q, newJobFilter);
  const allCount = useQuery({
    queryKey: ['admin', 'review', 'all-count', scope],
    queryFn: ({ signal }) => fetchAllCount(scope, signal),
    enabled: allAsk !== null,
    staleTime: 0,
    gcTime: 0,
  });
  const active = lane === 'flags' ? flags : reviews;
  const counts = active.data?.pages[0]?.counts ?? countsRoute.data ?? (lane === 'flags' ? reviews : flags).data?.pages[0]?.counts;
  useEffect(() => onCounts(counts, unverified), [counts, unverified, onCounts]);

  const reviewRows = useMemo(() => (lane === 'flags' ? [] : (reviews.data?.pages.flatMap((page) => page.items) ?? [])), [lane, reviews.data]);
  const flagRows = useMemo(() => (lane === 'flags' ? (flags.data?.pages.flatMap((page) => page.items) ?? []) : []), [lane, flags.data]);
  const loaded = active.data !== undefined;
  const firstPage = active.data?.pages[0];
  const pages = active.data?.pages.length ?? 0;
  const rowCount = lane === 'flags' ? flagRows.length : reviewRows.length;
  const decidable = lane === 'flags' ? flagRows.filter((flag) => flag.status === 'open').map((flag) => flag.id) : reviewRows.filter((row) => row.state === 'pending').map((row) => row.id);
  // v37 REVIEW (R3): every item the filter matches that a decision can take, loaded or not.
  const decidableTotal = firstPage?.decidable ?? decidable.length;
  const chosen = allMode ? decidable : decidable.filter((id) => selected.has(id));
  const chosenCount = allMode ? decidableTotal : chosen.length;
  const decidableIds = new Set(decidable);
  const isChosen = (id: number) => (allMode ? decidableIds.has(id) : selected.has(id));

  const loader = useLoadOnScroll(
    {
      hasNextPage: Boolean(active.hasNextPage),
      isFetchingNextPage: active.isFetchingNextPage,
      isFetchNextPageError: active.isFetchNextPageError,
      fetchNextPage: active.fetchNextPage,
    },
    ROWS,
  );

  // Focus stays in the list when a decided row leaves it (the Waiting view drops it): it goes to the row now in its
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
    const rows = pane?.querySelectorAll<HTMLElement>(ROWS) ?? [];
    const row = rows.length > 0 ? rows[Math.min(want.index, rows.length - 1)] : null;
    const target = row
      ? (row.querySelector<HTMLElement>('[data-row-action]') ?? row.querySelector<HTMLElement>('button'))
      : (pane?.querySelector<HTMLElement>('[data-pane-body] button') ?? pane?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'));
    target?.focus();
  }, [reviewRows, flagRows, inFlight, sheetOpen]);

  const focusAfter = (id: number) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(ROWS) ?? [])];
    const index = Math.max(0, rows.findIndex((row) => row.dataset.reviewRow === String(id) || row.dataset.flagRow === String(id)));
    focusAt.current = { id, index };
  };

  /** v37 REVIEW (R3): the selection goes (a lane, filter or search changed; the select mode ended). */
  const clearSelection = () => {
    setSelected(new Set());
    setAllMode(false);
    setLoadedOnly(false);
  };

  const changeLane = (next: AdminReviewLane) => {
    if (next === lane) return;
    setPickedLane(next);
    setState((current) => stateForLane(next, current));
    setSelectMode(false);
    clearSelection();
    setOutcomes(new Map());
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'review');
    params.set('lane', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const changeState = (next: ReviewStateFilter) => {
    setState(next);
    clearSelection();
    setOutcomes(new Map());
  };

  useEffect(() => {
    // v37 REVIEW (R3): a new search takes another set of items: "Select all N" never carries over to it.
    setAllMode(false);
    setSelected(new Set());
    setLoadedOnly(false);
  }, [q]);

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

  const decide = async (row: AdminReviewRow, decision: ReviewDecision, note = '', captured = false) => {
    if (busy.has(row.id)) return;
    // v32 ADMINAPP (E6): a v3.0 page review's approval may publish what browsers captured: asked first.
    if (decision === 'approve' && !captured && approvesCaptured(row)) {
      setCapturing({ row, note });
      return;
    }
    markBusy(row.id, true);
    forget(row.id);
    focusAfter(row.id);
    try {
      await decideReview(row.id, { decision, ...(note ? { note } : {}), ...(captured ? { captured: true } : {}) });
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

  // v32 ADMINAPP (E6): Retry read of a waiting new job: TailorIT reads its link again; the row stays for the decision.
  const retry = async (row: AdminReviewRow) => {
    if (busy.has(row.id)) return;
    markBusy(row.id, true);
    try {
      const words = reviewRetryText(await retryReviewRead(row.id));
      setLive(`${words.title}: ${rowName(row.job)}`);
      if (words.tone === 'success') toast.success(words.title, words.body);
      else toast.info(words.title, words.body);
    } catch (error) {
      toast.error("TailorIT couldn't read the job again", userMessage(error));
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

  const endSelectMode = () => {
    setSelectMode(false);
    clearSelection();
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
    endSelectMode();
    setBulkBusy(false);
    refresh();
    // v30 FIX-WEB (UX-4): the bar went with the select mode: focus back to Select (or the first row still to decide),
    // once the page has re-rendered after the requests.
    focusSoon(AFTER_SELECT_MODE);
  };

  // v37 REVIEW (R3): a decision on every item "Select all N" took: requests continued with `after` until done (the
  // count's `upTo` with each), the progress in the confirm, then one result line.
  const runAll = async (ask: AllAsk, note: string) => {
    try {
      const upTo = allCount.data?.upTo;
      const outcome = await runAllTurns(
        ask.action,
        (after) => sendAll(scope, ask.action, { ...(after !== undefined ? { after } : {}), ...(upTo ? { upTo } : {}), ...(note ? { note } : {}) }),
        (sofar) => setAllProgress(allProgressText(sofar)),
        undefined,
        () => stopAll.current, // v37 FIX-REV (L6)
      );
      const line = allLine(ask.lane, outcome);
      setLive(line);
      if ((outcome.counts.failed ?? 0) > 0) toast.error(line, outcome.failures[0]?.message);
      else if (outcome.stopped) toast.info(line);
      else toast.success(line);
      allReturn.finished(); // v37 FIX-REV (M1): the bar goes; focus goes to Select (below)
      setAllAsk(null);
      endSelectMode();
      setOutcomes(new Map());
      focusSoon(AFTER_SELECT_MODE);
    } catch (error) {
      throw new Error(userMessage(error));
    } finally {
      setAllProgress(null);
      setStopping(false);
      refresh();
    }
  };

  /** The bar's decision: on every item the filter matches ("Select all N"), else on the chosen rows. */
  const ask = (action: BulkAction) => {
    if (allMode) {
      allReturn.remember(); // v37 FIX-REV (M1): Cancel gives focus back to this action
      stopAll.current = false;
      setAllAsk({ lane: allLane, action });
    } else setBulkAction(action);
  };

  const toggle = (id: number, on: boolean) => {
    if (allMode) {
      // v37 REVIEW (R3): unticking one row of "all" keeps the other rows shown. v37 FIX-REV (REVIEW361-ux L5): the bar
      // says so: the selection is the rows loaded so far now, not every row the filter matches.
      setAllMode(false);
      setLoadedOnly(true);
      setSelected(new Set(decidable.filter((other) => other !== id || on)));
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const filters = stateFiltersOf(lane);
  const selectButton = !selectMode ? (
    <Button
      variant="ghost"
      size="sm"
      className="max-sm:h-11"
      disabled={decidableTotal === 0}
      data-review-select=""
      onClick={() => {
        setSelectMode(true);
        // v30 FIX-WEB (UX-4): the bar replaces the button: focus goes to its first control (v37: Select all N).
        focusLater(`${SELECT_BAR(lane !== 'flags')} [data-select-all]`, `${SELECT_BAR(lane !== 'flags')} button`);
      }}
    >
      Select
    </Button>
  ) : null;
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
        className="w-full sm:hidden max-sm:h-11"
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
            className="max-sm:hidden"
            value={state}
            onValueChange={changeState}
            items={filters.map((value) => ({ value, label: stateFilterLabel(value) }))}
          />
          {/* v37 REVIEW (R2): five filters do not fit a phone's width as tabs: a select there, as the lanes. */}
          <Select
            aria-label="Show reviews"
            className="w-full sm:hidden max-sm:h-11"
            size="lg"
            value={state}
            onValueChange={changeState}
            options={filters.map((value) => ({ value, label: stateFilterLabel(value) }))}
          />
          <SearchPill
            value={search}
            onValueChange={setSearch}
            label="Search by job title or company"
            placeholder="Search title or company"
            className="w-full sm:ml-auto sm:w-64 max-sm:h-11"
          />
          {/* v35 OPSWEB (PLAN H3): New jobs' From filter. */}
          {newJobs && (
            <div className="flex w-full flex-wrap items-center gap-2" data-new-jobs-tools="">
              {/* v35 FIX-WEB (L6): a visible "From" beside the select (two "All"s read apart). */}
              <span className="flex w-full min-w-0 items-center gap-2 sm:w-auto" data-new-jobs-from="">
                <span aria-hidden="true" className="shrink-0 text-[13px] leading-5 font-medium text-muted-foreground">
                  From
                </span>
                <Select
                  aria-label="New jobs: from"
                  size="sm"
                  className="min-w-0 flex-1 sm:w-64 sm:flex-none max-sm:h-11"
                  value={newJobFromValue(newJobFilter)}
                  onValueChange={(value) => {
                    setNewJobFilter(newJobFilterOf(value));
                    clearSelection();
                    setOutcomes(new Map());
                  }}
                  options={fromOptions(NEW_JOB_WAYS, imports.data?.items ?? [], newJobFilter.runId)}
                />
              </span>
              {/* v37 FIX-REV (REVIEW361-ux L7): Select on the From line (it dropped to a line of its own under From). */}
              {selectButton}
            </div>
          )}
          {!newJobs && selectButton}
        </div>
      )}
    </div>
  );

  // v37 REVIEW (R2): the header's count: what the list can show; "12 of 340" while the view is narrowed. v35 FIX-WEB
  // (L5): "2 of 7" while Couldn't verify's From filter is on.
  const head = unverifiedLane
    ? (() => {
        const text = filteredHeadCount(unverifiedFiltered, unverified);
        return { count: text === null ? unverified : null, text };
      })()
    : laneHeadCount(firstPage, viewNarrowed(state, q, fromFiltered));

  const footer =
    selectMode && !unverifiedLane ? (
      <SelectBar
        aria-label={reviewing ? 'Approve or reject the selected reviews' : 'Resolve or dismiss the selected flags'}
        selected={chosenCount}
        selectable={decidableTotal}
        selectAllLabel={selectAllTip(allLane)}
        onSelectAll={(on) => {
          setSelected(new Set());
          setAllMode(on);
          setLoadedOnly(false);
        }}
        selectAllAs="button"
        allSelected={allMode || (decidableTotal > 0 && chosen.length === decidableTotal)}
        selectAllWords={selectAllWords(decidableTotal)}
        note={loadedOnly ? LOADED_ROWS_NOTE : null}
      >
        <Button
          size="sm"
          className="max-sm:h-11 max-sm:flex-1"
          icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />}
          disabled={chosenCount === 0}
          loading={bulkBusy}
          aria-haspopup="dialog"
          onClick={() => ask(reviewing ? 'approve' : 'resolved')}
        >
          {reviewing ? 'Approve' : 'Resolve'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="max-sm:h-11 max-sm:flex-1"
          icon={<XIcon size={14} weight="bold" aria-hidden="true" />}
          disabled={chosenCount === 0 || bulkBusy}
          aria-haspopup="dialog"
          onClick={() => ask(reviewing ? 'reject' : 'dismissed')}
        >
          {reviewing ? 'Reject' : 'Dismiss'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="max-sm:h-11"
          disabled={bulkBusy}
          onClick={() => {
            endSelectMode();
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
          title="The review queue didn't load."
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
    const things = lane === 'flags' ? 'flags' : lane === 'new_job' ? 'new jobs' : 'closed links';
    body = (
      <>
        {active.isRefetchError && (
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
        {/* v37 REVIEW (R1): one list in the server's order, the next page read as its end comes near (or focus nears it). */}
        <div onFocusCapture={loader.onFocusCapture} data-review-list="">
          <ul className="divide-y divide-divider-soft" aria-label={ADMIN_REVIEW_LANE_LABEL[lane]}>
            {lane === 'flags'
              ? flagRows.map((flag) => (
                  <FlagRowView
                    key={flag.id}
                    flag={flag}
                    now={now}
                    selectMode={selectMode}
                    checked={isChosen(flag.id)}
                    onChecked={(on) => toggle(flag.id, on)}
                    busy={busy.has(flag.id) || (bulkBusy && selected.has(flag.id))}
                    outcome={rowOutcomeText(outcomes.get(flag.id))}
                    onChange={(change) => void changeFlag(flag, change)}
                  />
                ))
              : reviewRows.map((row) => (
                  <ReviewRowView
                    key={row.id}
                    row={row}
                    now={now}
                    selectMode={selectMode}
                    checked={isChosen(row.id)}
                    onChecked={(on) => toggle(row.id, on)}
                    busy={busy.has(row.id) || (bulkBusy && selected.has(row.id))}
                    outcome={rowOutcomeText(outcomes.get(row.id))}
                    onDecide={(decision) => void decide(row, decision)}
                    {...(retriesRead(row) ? { onRetry: () => void retry(row) } : {})}
                    onOpen={() => {
                      setSheetRow(row);
                      setSheetOpen(true);
                    }}
                  />
                ))}
          </ul>
          <ListEnd
            sentinel={loader.sentinel}
            list={{
              hasNextPage: Boolean(active.hasNextPage),
              isFetchingNextPage: active.isFetchingNextPage,
              isFetchNextPageError: active.isFetchNextPageError,
              fetchNextPage: active.fetchNextPage,
            }}
            things={things}
            shown={rowCount}
            pages={pages}
            error={userMessage(active.error, `More ${things} didn't load.`)}
            rows={ROWS}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <div ref={listRef} data-review-pane="" data-review-lane={laneKnown ? lane : undefined}>
        <Pane
          id={PANE_TITLE_ID}
          title={ADMIN_REVIEW_LANE_LABEL[lane]}
          count={!laneKnown ? null : head.count}
          status={
            laneKnown && head.text !== null ? (
              <span className="num text-sm text-muted-foreground" data-pane-count="" data-pane-count-filtered="">
                {head.text}
              </span>
            ) : undefined
          }
          controls={controls}
          scroll={false}
          footer={footer}
        >
          {!laneKnown ? (
            <ul aria-busy="true" aria-label="Loading the review queue" className="divide-y divide-divider-soft">
              {Array.from({ length: 3 }, (_unused, index) => (
                <li key={index} aria-hidden="true" className="flex min-h-20 items-start gap-3 px-5 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </li>
              ))}
            </ul>
          ) : isQueueLane(lane) ? (
            <>
              <AutoApproveStrip lane={lane} />
              {body}
            </>
          ) : (
            <UnverifiedLane onLive={setLive} onFilterCount={setUnverifiedFiltered} />
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
      <ConfirmDialog
        open={capturing !== null}
        onOpenChange={(open) => !open && setCapturing(null)}
        tone="primary"
        title={CAPTURED_APPROVE_COPY.title}
        description={CAPTURED_APPROVE_COPY.description}
        confirmLabel={CAPTURED_APPROVE_COPY.confirm}
        // v32 INT-2 (UXREQ-12): publishing to everyone opens on Cancel.
        focusCancel
        onConfirm={() => {
          const asked = capturing;
          setCapturing(null);
          if (asked) void decide(asked.row, 'approve', asked.note, true);
        }}
      />
      {/* v37 REVIEW (R3): "Approve 340 jobs?" with the server's count; the requests' progress while it works. */}
      <AllDialog
        ask={allAsk}
        count={allCount.data?.pending}
        countError={allCount.isError ? allCount.error : null}
        progress={allProgress}
        onCancel={() => setAllAsk(null)}
        onConfirm={async (note) => {
          if (allAsk) await runAll(allAsk, note);
        }}
        finalFocus={allReturn.finalFocus}
        onStop={() => {
          stopAll.current = true;
          setStopping(true);
        }}
        stopping={stopping}
      />
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
