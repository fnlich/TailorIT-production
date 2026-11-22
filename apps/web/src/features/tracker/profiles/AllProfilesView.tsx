'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  APPLICATION_STATUSES,
  STATUS,
  STATUS_INFO,
  TRACKER_LIST_PAGE_SIZE,
  hideColumn,
  showColumn,
  visibleColumns,
  type ApplicationStatus,
  type ApplicationSummary,
  type BoardResponse,
  type TrackerTab,
  type TrackerView,
} from '@tailorit/shared';
import type { ProfileChoice } from '@tailorit/shared/sharing';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { LoadError } from '@/components/ui/LoadError';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { isProfileRefusal } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import type { MarkerView } from '../../auto-apply/copy';
import type { CardHandlers } from '../board/ApplicationCard';
import { BoardView } from '../board/BoardView';
import { celebrateIfReached } from '../confetti';
import { useMoveStatus, useToggleFavorite, type ColumnLimits } from '../data';
import { DetailSheet } from '../detail/DetailSheet';
import { trackerMarker } from '../draft';
import { useArchivedColumn, useColumnPrefs, useDebouncedValue } from '../hooks';
import { ListView, type ListEmptyKind } from '../list/ListView';
import { activeFilterCount, chooseView, filterKey, DEFAULT_FILTERS, type FilterState, type TrackerUrlState } from '../state';
import { NO_ACTIONS, OptionsMenu } from '../toolbar/OptionsMenu';
import { FilterChipsRow, ManageBar, PrepareBar, SearchRow, TabsRow, ViewSwitch, type BulkKind } from '../toolbar/Toolbar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { HelpTip } from '@/components/ui/HelpTip';
import type { FanoutItem } from '@tailorit/shared/sharing';
import { prepareBlockReason } from '../draft';
import { FANOUT_COPY, namesList } from '../../sharing/fanout/copy'; // v34 FANWEB
import { manageBarFocus, ProfilesDialog } from '../../sharing/fanout/parts';
import { boxName } from '../../sharing/fanout/targets';
import { PROFILES_COPY } from '../../sharing/copy';
import { usePrepareAllProfiles } from '../../sharing/usePrepareAllProfiles';
import { BudgetNote } from '../../prepare/PrepareAllConfirmDialog';
import { HEADER_QUERY_KEY, fetchHeaderSummary } from '@/components/shell/header/api';
import { useTrackerFanout } from './fanout';
import { cardActions, moreInLane, moreRows } from './actions';
import { AllProfilesToggle } from './AllProfilesToggle';
import { useProfileBoards, useProfileCounts, useProfileLists, useProfileMarkers, type ListPages, type ProfileRead } from './data';
import { NotSharedNotice } from './NotShared';
import type { CardProfile } from './ProfileBadge';
import {
  ALL_PROFILES_COPY,
  mergeBoards,
  mergeLists,
  profilesOfCards,
  sumCounts,
  type LoadMoreItem,
  type TrackerProfile,
} from './scope';
import type { TrackerScope } from './useTrackerProfiles';

// v33 SHARE-9 (PLAN F9 "Seeing every profile at once"; SP v33 PLAN-sharing.md §8 "The Tracker's All profiles view"): the
// Job Tracker of the person's own profile and of every profile shared with them that lets them see it, at once. The
// board's lanes and the list hold every profile's cards in one order, each with its profile's badge; each profile is
// read on its own (scope.ts, data.ts) and keeps its own cursors: a lane (and the list) has a "Load more" per profile that
// has more. Only per-card actions: open, Move to stage (and drag), Archive and Restore, the heart, each sent to the
// card's profile and only where it lets the person change its Job Tracker; no selecting, bulk actions, Archive all,
// Import, Export, Build resumes or Add application, and no chart. Opening a card of another profile than the tab's
// switches the tab there (a new document at `/tracker?app=<id>&as=<key>`).

const NO_LIMITS: Readonly<Record<string, ColumnLimits>> = {};
const NO_WANTED: Readonly<Record<string, number>> = {};
/** Nothing selected yet. */
const NO_SELECTION: ReadonlySet<string> = new Set();

// v34 FANWEB (PLAN G4: "the All profiles view gains Select and bulk actions (Copy to, Move to a stage, Archive,
// Prepare & Queue) that run on each card's own profile, plus Prepare all profiles"): Select applications and Prepare &
// Queue jobs are in the view's menu again; the selection may hold cards of every profile and each action is one request
// (POST /api/profiles/applications/bulk, each card on its own profile). A card whose profile is shared to see only is
// left out of Move, Archive and Restore (and named in the result); Copy to takes any card (it only reads the job);
// Prepare & Queue takes only cards of profiles the person may prepare (the others' boxes say why). Archive and Restore
// have Undo; Prepare asks first (it uses the person's AI). Never Delete (a person who was shared a profile archives).

/** The cards of a profile's read, for knowing which profile a card belongs to. */
const itemsOfBoard = (read: ProfileRead<BoardResponse>) => (read.data?.columns ?? []).flatMap((column) => column.items);
const itemsOfList = (read: ProfileRead<ListPages>) => (read.data?.pages ?? []).flatMap((page) => page.items);
/** Every profile's first read failed: nothing to draw but why. */
const everyFailed = (reads: ReadonlyArray<ProfileRead<unknown>>) => reads.length > 0 && reads.every((read) => read.isError && read.data === undefined);

/** "Load more" of `profile` (in a lane, or the list). */
function moreItem(profile: TrackerProfile, lane: string, loading: boolean, onLoad: () => void): LoadMoreItem {
  return {
    id: profile.choice,
    label: ALL_PROFILES_COPY.loadMore(profile.label, profile.own),
    ariaLabel: ALL_PROFILES_COPY.loadMoreLabel(profile.label, profile.own, lane),
    loading,
    onLoad,
  };
}

/** A profile whose read failed: why, and Try again (a read its owner no longer shares says so instead). */
function ProfileLoadFailures({ reads }: { reads: ReadonlyArray<ProfileRead<unknown>> }) {
  const failed = reads.filter((read) => read.isError && read.data === undefined);
  if (failed.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-profile-load-failures="">
      {failed.map((read) =>
        isProfileRefusal(read.error) ? (
          <NotSharedNotice key={read.profile.choice} title={ALL_PROFILES_COPY.loadFailed(read.profile.label, read.profile.own)} />
        ) : (
          <LoadError
            key={read.profile.choice}
            thing={ALL_PROFILES_COPY.loadFailed(read.profile.label, read.profile.own)}
            error={read.error}
            onRetry={read.refetch}
          />
        ),
      )}
    </div>
  );
}

export function AllProfilesView({
  url,
  setUrl,
  scope,
}: {
  url: TrackerUrlState;
  setUrl: (next: TrackerUrlState) => void;
  scope: TrackerScope;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const { t } = usePublicConstants();
  const { profiles } = scope;
  // No chart here: a chart asked for shows the board; Archived is a list.
  const view: TrackerView = url.tab === 'archived' ? 'list' : url.view === 'chart' ? 'board' : url.view;

  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 500);
  const key = filterKey(filters, q);
  // Each profile's "Load more" (per lane on the board, per list), forgotten when the search or filters change.
  const [boardMore, setBoardMore] = useState<{
    key: string;
    limits: Readonly<Record<string, ColumnLimits>>;
    loading: { profile: string; status: ApplicationStatus } | null;
  }>({ key, limits: NO_LIMITS, loading: null });
  const limits = boardMore.key === key ? boardMore.limits : NO_LIMITS;
  const [listMore, setListMore] = useState<{ key: string; wanted: Readonly<Record<string, number>>; loading: string | null }>({
    key,
    wanted: NO_WANTED,
    loading: null,
  });
  const listKey = `${url.tab}:${key}`;
  const wanted = listMore.key === listKey ? listMore.wanted : NO_WANTED;
  const [archivedMore, setArchivedMore] = useState<{ key: string; wanted: Readonly<Record<string, number>>; loading: string | null }>({
    key,
    wanted: NO_WANTED,
    loading: null,
  });
  const archivedWanted = archivedMore.key === key ? archivedMore.wanted : NO_WANTED;
  const [prefs, setPrefs] = useColumnPrefs();
  const [archivedShown, setArchivedShown] = useArchivedColumn();

  // v34 FANWEB: the selection (cards of every profile), what it is for, and the actions on several profiles.
  const [selectMode, setSelectMode] = useState(false);
  const [selectPurpose, setSelectPurpose] = useState<'manage' | 'prepare'>('manage');
  const prepareMode = selectMode && selectPurpose === 'prepare';
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>(() => ({ key: `${url.tab}:${key}`, ids: NO_SELECTION }));
  const selected = selection.key === `${url.tab}:${key}` ? selection.ids : NO_SELECTION;
  const setSelected = (ids: ReadonlySet<string>) => setSelection({ key: `${url.tab}:${key}`, ids });
  const fanout = useTrackerFanout();
  const copyProfiles = useMemo(() => fanout.profiles.map((profile) => ({ ...profile, current: false })), [fanout.profiles]);
  const [copying, setCopying] = useState<FanoutItem[] | null>(null);
  const [preparing, setPreparing] = useState<FanoutItem[] | null>(null);
  const prepareAllButton = useRef<HTMLButtonElement>(null);
  const prepareAll = usePrepareAllProfiles(prepareAllButton);
  // v34 FANWEB fix (spec L8): the header's read of today's AI use (the shell keeps it; nothing is asked here).
  const header = useQuery({ queryKey: HEADER_QUERY_KEY, queryFn: ({ signal }) => fetchHeaderSummary(signal), enabled: false });

  const counts = useProfileCounts(profiles, true);
  const boards = useProfileBoards(profiles, filters, q, limits, view === 'board');
  const lists = useProfileLists(profiles, url.tab, filters, q, wanted, view === 'list');
  const archivedLists = useProfileLists(profiles, 'archived', filters, q, archivedWanted, view === 'board' && archivedShown);
  const markers = useProfileMarkers(profiles, url.tab === 'active');
  const move = useMoveStatus({ onMoved: (result, previous) => celebrateIfReached(result.currentStatus, previous) });
  const favorite = useToggleFavorite();

  const board = useMemo(
    () => mergeBoards(boards.map((read) => ({ profile: read.profile, board: read.data })), filters.sort, filters.order),
    [boards, filters.sort, filters.order],
  );
  const list = useMemo(
    () => mergeLists(lists.map((read) => ({ profile: read.profile, pages: read.data?.pages })), filters.sort, filters.order),
    [lists, filters.sort, filters.order],
  );
  const archived = useMemo(
    () => mergeLists(archivedLists.map((read) => ({ profile: read.profile, pages: read.data?.pages })), filters.sort, filters.order),
    [archivedLists, filters.sort, filters.order],
  );
  const owners = useMemo(
    () =>
      profilesOfCards([
        ...boards.map((read) => ({ profile: read.profile, items: itemsOfBoard(read) })),
        ...lists.map((read) => ({ profile: read.profile, items: itemsOfList(read) })),
        ...archivedLists.map((read) => ({ profile: read.profile, items: itemsOfList(read) })),
      ]),
    [boards, lists, archivedLists],
  );
  const totals = useMemo(
    () => Object.fromEntries((board.columns ?? []).map((column) => [column.status, column.total])) as Record<string, number>,
    [board.columns],
  );
  const lanesChosen = visibleColumns(prefs, totals);
  const visible: ApplicationStatus[] = lanesChosen.length > 0 || archivedShown ? lanesChosen : [STATUS.saved];
  const tabCounts = sumCounts(counts.map((read) => read.data));

  // ------------------------------------------------------------------------------------------------- actions

  const ownerOf = (application: ApplicationSummary): TrackerProfile | null => owners.get(application.id) ?? null;
  // Each sent to the card's own profile, only where it lets the person change its Job Tracker (profiles/actions.ts).
  const actions = cardActions({
    client,
    toast,
    ownerOf,
    tab: scope.tab,
    // v33 SHARE-9 fix (review): what is shown (a chart asked for shows the board), so another profile's card opens there
    // on the board, never on its chart.
    shown: { view, tab: url.tab },
    openHere: (id) => setUrl({ ...url, app: id, edit: false }),
    switchTo: scope.view.switchTo,
    move: move.mutate,
    favorite: favorite.mutate,
    showLane: (status) => {
      if (view === 'board' && !visible.includes(status)) setPrefs(showColumn(prefs, status));
    },
  });

  const markerOf = (application: ApplicationSummary): MarkerView | null => trackerMarker(application, markers.get(application.id), t);

  // v34 FANWEB: what the selection holds now (only what is on screen), each card with its profile.
  const loadedApplications: ApplicationSummary[] =
    view === 'board'
      ? [
          ...(board.columns ?? []).filter((column) => visible.includes(column.status)).flatMap((column) => column.items),
          ...(archivedShown ? (archived.items ?? []) : []),
        ]
      : (list.items ?? []);
  /** Why a card cannot be chosen for Prepare & Queue: its profile's box, or the card itself (not Saved, queued already). */
  const prepareBlocked = (application: ApplicationSummary): string | null => {
    const owner = ownerOf(application);
    if (!owner) return null;
    if (!owner.canPrepare) return FANOUT_COPY.prepareBlocked(boxName('prepare:run', fanout.label));
    return prepareBlockReason(application);
  };
  const loadedIds = loadedApplications.map((item) => item.id);
  const prepareIds = loadedApplications.filter((item) => prepareBlocked(item) === null).map((item) => item.id);
  const itemsOf = (ids: Iterable<string>): FanoutItem[] => {
    const out: FanoutItem[] = [];
    for (const id of ids) {
      const owner = owners.get(id);
      if (owner) out.push({ profile: owner.choice, applicationId: id });
    }
    return out;
  };
  const onScreenSelected = () => {
    const onScreen = new Set(loadedIds);
    return [...selected].filter((id) => onScreen.has(id));
  };
  const startSelecting = (purpose: 'manage' | 'prepare') => {
    if (purpose !== selectPurpose) setSelected(NO_SELECTION);
    setSelectPurpose(purpose);
    setSelectMode(true);
  };
  const endSelecting = () => {
    setSelectMode(false);
    setSelected(NO_SELECTION);
  };
  /** v34 FANWEB fix (spec M6): the chosen cards Move, Archive and Restore change, and the see-only profiles left alone. */
  const chosenNow = onScreenSelected();
  const editableChosen = chosenNow.filter((id) => owners.get(id)?.canEdit);
  const seeOnlyChosen = [...new Set(chosenNow.filter((id) => !owners.get(id)?.canEdit).map((id) => owners.get(id)?.label ?? ''))].filter(Boolean);
  const changeable = {
    count: editableChosen.length,
    note: seeOnlyChosen.length > 0 ? FANOUT_COPY.seeOnlyChosen(namesList(seeOnlyChosen), editableChosen.length === 0) : null,
  };
  /** A bulk action of the bar: the editable profiles' cards in one request; the others left out and named. */
  const bulk = async (kind: BulkKind) => {
    // The bar offers Move, Archive and Restore only with a card they change (a see-only profile's cards are left alone).
    if (editableChosen.length === 0) return;
    await fanout.bulk(kind, itemsOf(editableChosen), seeOnlyChosen);
    setSelected(NO_SELECTION);
  };

  const handlers: CardHandlers = {
    onOpen: actions.open,
    onMove: actions.move,
    onArchive: (application) => void actions.setArchived(application, true),
    onRestore: (application) => void actions.setArchived(application, false),
    onToggleFavorite: actions.toggleFavorite,
    onToggleSelected: (application, on) => {
      const next = new Set(selected);
      if (on) next.add(application.id);
      else next.delete(application.id);
      setSelected(next);
    },
    selectBlocked: prepareMode ? prepareBlocked : undefined,
    markerOf,
    canEdit: (application) => ownerOf(application)?.canEdit ?? false,
    profileOf: (application): CardProfile | null => {
      const owner = ownerOf(application);
      return owner ? { choice: owner.choice, label: owner.label, own: owner.own } : null;
    },
  };

  const loadMoreLane = useCallback(
    (profile: ProfileChoice, status: ApplicationStatus) =>
      setBoardMore((current) => ({
        key,
        limits: moreInLane(current.key === key ? current.limits : NO_LIMITS, profile, status),
        loading: { profile, status },
      })),
    [key],
  );
  const loadMoreList = (profile: ProfileChoice) =>
    setListMore((current) => ({
      key: listKey,
      wanted: moreRows(current.key === listKey ? current.wanted : NO_WANTED, profile, TRACKER_LIST_PAGE_SIZE),
      loading: profile,
    }));
  const loadMoreArchived = (profile: ProfileChoice) =>
    setArchivedMore((current) => ({
      key,
      wanted: moreRows(current.key === key ? current.wanted : NO_WANTED, profile, TRACKER_LIST_PAGE_SIZE),
      loading: profile,
    }));

  const readOf = <T,>(reads: ReadonlyArray<ProfileRead<T>>, profile: TrackerProfile) => reads.find((read) => read.profile.choice === profile.choice);
  const laneMore = (status: ApplicationStatus): LoadMoreItem[] | null => {
    const more = board.more.get(status);
    if (!more) return null;
    return more.map((profile) =>
      moreItem(
        profile,
        STATUS_INFO[status].label,
        Boolean(readOf(boards, profile)?.isPlaceholderData && boardMore.loading?.profile === profile.choice && boardMore.loading.status === status),
        () => loadMoreLane(profile.choice, status),
      ),
    );
  };
  const listMoreItems = list.more.map((profile) =>
    moreItem(profile, url.tab === 'archived' ? 'Archived' : 'Active', Boolean(readOf(lists, profile)?.isFetching && listMore.loading === profile.choice), () =>
      loadMoreList(profile.choice),
    ),
  );
  const archivedMoreItems = archived.more.map((profile) =>
    moreItem(profile, 'Archived', Boolean(readOf(archivedLists, profile)?.isFetching && archivedMore.loading === profile.choice), () =>
      loadMoreArchived(profile.choice),
    ),
  );

  const changeView = (next: TrackerView) => setUrl(chooseView(url, next));
  const changeTab = (tab: TrackerTab) => setUrl({ ...url, tab });
  const leave = () => setUrl({ ...url, all: false, app: null, edit: false });

  const filtered = q.trim() !== '' || activeFilterCount(filters) > 0;
  const emptyKind: ListEmptyKind = filtered ? 'no-match' : url.tab === 'archived' ? 'archived' : 'first';
  const failedReads = view === 'board' ? boards : lists;
  const nothingRead = everyFailed(failedReads);

  return (
    <div
      className={clsx(
        'mx-auto flex w-full max-w-[1600px] flex-col',
        view === 'board' ? 'h-[calc(100dvh_-_var(--spacing-topbar))] min-h-[560px]' : 'min-h-full',
      )}
      data-tracker-all-profiles=""
    >
      <div className={clsx(PAGE_GUTTER, 'flex shrink-0 flex-col gap-3 pt-4 sm:pt-6', view === 'board' ? 'pb-3 sm:pb-5' : 'pb-6')}>
        {/* The page's own eyebrow (a tab on a shared profile shows that profile's name there otherwise). */}
        <PageHeader
          title="Job Tracker"
          eyebrow={ALL_PROFILES_COPY.eyebrow}
          description={t('MSG_TRACKER_PAGE_DESCRIPTION')}
          actions={
            <>
              <ViewSwitch view={view} onViewChange={changeView} className="sm:hidden" chart={false} />
              <AllProfilesToggle on onChange={(on) => (on ? undefined : leave())} />
              {/* v34 FANWEB: every profile's saved jobs prepared in one go (as on the Profiles page). */}
              <span className="inline-flex items-center gap-1">
                <Button
                  ref={prepareAllButton}
                  variant="outline"
                  onClick={prepareAll.start}
                  loading={prepareAll.reading}
                  disabled={!prepareAll.ready}
                  className="max-sm:h-11"
                  data-prepare-all-profiles=""
                >
                  {prepareAll.reading ? PROFILES_COPY.reading : PROFILES_COPY.prepareAll}
                </Button>
                <HelpTip label={PROFILES_COPY.prepareAll}>{PROFILES_COPY.prepareAllTip}</HelpTip>
              </span>
            </>
          }
          className="max-sm:items-center sm:mb-3"
        />
        <SearchRow
          view={view}
          search={search}
          onSearchChange={setSearch}
          onViewChange={changeView}
          chart={false}
          tabs={<TabsRow tab={url.tab} counts={tabCounts} onTabChange={changeTab} />}
          options={
            <OptionsMenu
              view={view}
              filters={filters}
              onFiltersChange={setFilters}
              onListView={() => setUrl({ ...url, view: 'list' })}
              columns={APPLICATION_STATUSES.map((status) => ({ status, count: totals[status] ?? 0, visible: visible.includes(status) }))}
              onColumnToggle={(status, on) => setPrefs(on ? showColumn(prefs, status) : hideColumn(prefs, status))}
              archivedColumn={{ count: tabCounts?.archived ?? 0, visible: archivedShown }}
              onArchivedToggle={setArchivedShown}
              onManage={() => startSelecting('manage')}
              onPrepare={() => startSelecting('prepare')}
              onImport={() => undefined}
              onExport={() => undefined}
              onBuildResumes={() => undefined}
              buildingResumes={false}
              onArchiveAll={() => undefined}
              actions={{ ...NO_ACTIONS, select: true, prepare: url.tab === 'active' }}
            />
          }
        />
        {prepareMode && (
          <PrepareBar
            count={prepareIds.filter((id) => selected.has(id)).length}
            total={prepareIds.length}
            allSelected={prepareIds.length > 0 && prepareIds.every((id) => selected.has(id))}
            onSelectAll={(on) => setSelected(on ? new Set(prepareIds) : NO_SELECTION)}
            onPrepare={() => setPreparing(itemsOf(prepareIds.filter((id) => selected.has(id))))}
            pending={preparing !== null}
            onDone={endSelecting}
          />
        )}
        {selectMode && !prepareMode && (
          <ManageBar
            tab={url.tab}
            count={selected.size}
            total={loadedIds.length}
            allSelected={loadedIds.length > 0 && loadedIds.every((id) => selected.has(id))}
            onSelectAll={(on) => setSelected(on ? new Set(loadedIds) : NO_SELECTION)}
            onBulk={bulk}
            buildingResumes={false}
            deletable={false}
            onCopy={() => setCopying(itemsOf(onScreenSelected()))}
            changeable={changeable}
            onDone={endSelecting}
          />
        )}
        <FilterChipsRow filters={filters} onChange={setFilters} />
        <ProfileLoadFailures reads={failedReads} />
      </div>

      {view === 'board' && !nothingRead && (
        <div className="min-h-0 flex-1">
          <BoardView
            columns={board.columns}
            visible={visible}
            prefs={prefs}
            onPrefsChange={setPrefs}
            handlers={handlers}
            openId={url.app}
            selectMode={selectMode}
            selected={selected}
            onLoadMore={() => undefined}
            loadingMore={null}
            laneMore={laneMore}
            onDrop={actions.move}
            archived={
              archivedShown
                ? {
                    items: archived.items,
                    total: archived.items === null ? (tabCounts?.archived ?? 0) : archived.total,
                    hasMore: false,
                    loadingMore: false,
                    onLoadMore: () => undefined,
                    more: archivedMoreItems,
                    onHide: () => setArchivedShown(false),
                  }
                : null
            }
            onArchiveDrop={(application) => void actions.setArchived(application, true)}
            onRestoreDrop={(application, status) => void actions.restoreInto(application, status)}
            refreshing={boards.some((read) => read.isFetching)}
            filtered={filtered}
          />
        </div>
      )}
      {view === 'list' && !nothingRead && (
        <div className={clsx(PAGE_GUTTER, 'pb-12')}>
          <ListView
            items={list.items}
            loading={list.items === null && lists.some((read) => read.isFetching)}
            empty={emptyKind}
            handlers={handlers}
            openId={url.app}
            selectMode={selectMode}
            selected={selected}
            hasMore={false}
            loadingMore={false}
            failed={false}
            onLoadMore={() => undefined}
            onAdd={null}
            more={listMoreItems}
          />
        </div>
      )}

      {/* A card of the tab's own profile opens here; another profile's opens on its profile (a new document). */}
      <DetailSheet
        id={url.app}
        open={url.app !== null}
        initialEdit={false}
        onEditConsumed={() => undefined}
        onClose={() => setUrl({ ...url, app: null, edit: false })}
      />
      {/* v34 FANWEB: Copy to profiles…, Prepare & Queue's confirm, Prepare all profiles, the results. */}
      <ProfilesDialog
        open={copying !== null}
        onOpenChange={(open) => !open && setCopying(null)}
        title={FANOUT_COPY.copyToTitle(copying?.length ?? 0)}
        help={FANOUT_COPY.copyToHelp}
        // v34 FANWEB fix (spec L5): over every profile, no profile is "this profile".
        profiles={copyProfiles}
        label={fanout.label}
        confirmLabel={FANOUT_COPY.copyConfirm}
        finalFocus={manageBarFocus}
        onConfirm={async (targets) => {
          if (!copying) return;
          await fanout.copy(copying, targets);
          setSelected(NO_SELECTION);
        }}
      />
      <ConfirmDialog
        open={preparing !== null}
        onOpenChange={(open) => !open && setPreparing(null)}
        tone="primary"
        title={FANOUT_COPY.prepareConfirmTitle(preparing?.length ?? 0, new Set((preparing ?? []).map((item) => item.profile)).size)}
        description={FANOUT_COPY.prepareConfirmLine}
        confirmLabel={FANOUT_COPY.prepareConfirmLabel}
        busyLabel={FANOUT_COPY.prepareBusy}
        // It spends the person's AI: it opens on Cancel.
        focusCancel
        onConfirm={async () => {
          if (!preparing) return;
          await fanout.prepare(preparing);
          setSelected(NO_SELECTION);
        }}
      >
        {/* v34 FANWEB fix (spec L8): today's AI use, as Prepare all profiles shows it (the header's read). */}
        {header.data && <BudgetNote ai={{ ...header.data.ai, creditMicros: header.data.extraCredit.balanceMicros }} />}
      </ConfirmDialog>
      {prepareAll.elements}
      {fanout.element}
    </div>
  );
}
