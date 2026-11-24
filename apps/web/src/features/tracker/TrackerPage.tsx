'use client';

import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  APPLICATION_STATUSES,
  RESUME_ZIP_MAX_APPLICATIONS,
  STATUS,
  hideColumn,
  showColumn,
  visibleColumns,
  type ApplicationDetail,
  type ApplicationStatus,
  type ApplicationSummary,
  type TrackerTab,
  type TrackerView,
} from '@tailorit/shared';
import { LockedFeatureDialog, useLimitDialog } from '@/components/limits';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Button } from '@/components/ui/Button';
import { LoadError } from '@/components/ui/LoadError';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageSpinner } from '@/components/ui/Spinner';
import { PlusIcon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/Toast';
import { isFeatureLocked, useAccount } from '@/lib/account';
import { isProfileRefusal, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import type { MarkerView } from '../auto-apply/copy';
import { usePrepareAndQueue } from '../prepare/usePrepareAndQueue';
import { useRetryRead } from '../jobs/verification/useRetryRead'; // v31 JOBSWEB
import type { CardHandlers } from './board/ApplicationCard';
import { BoardView } from './board/BoardView';
import { ChartView } from './chart/ChartView';
import { celebrateIfReached } from './confetti';
import { ImportCsvDialog } from './csv/ImportCsvDialog';
import { downloadExport } from './csv/exportCsv';
import {
  invalidateApplications,
  localToday,
  trackerApi,
  useApplicationList,
  useBoard,
  useCounts,
  useInsights,
  useMoveStatus,
  useSankey,
  useSavedMarkers,
  useToggleFavorite,
  type ColumnLimits,
} from './data';
import { DetailSheet } from './detail/DetailSheet';
import { toastFailure } from './failure';
import { isDraft, prepareBlockReason, trackerMarker } from './draft';
import { useArchivedColumn, useColumnPrefs, useDebouncedValue, useTrackerUrl } from './hooks';
import { ListView, type ListEmptyKind } from './list/ListView';
import { AllProfilesToggle } from './profiles/AllProfilesToggle';
import { AllProfilesView } from './profiles/AllProfilesView';
import { useTrackerScope, type TrackerScope } from './profiles/useTrackerProfiles';
import { useTrackerFanout } from './profiles/fanout'; // v34 FANWEB
import {
  FANOUT_COPY,
  QUEUE_COPY,
  addQueueCounts,
  archiveOneOutcome,
  inQueueNote,
  queueSentences,
  type QueueCounts,
} from '../sharing/fanout/copy';
import { manageBarFocus, ProfilesDialog } from '../sharing/fanout/parts';
import { useQueueWords } from '../sharing/fanout/useQueueWords'; // v36 FIX-WEB (D1)
import { AddApplicationSheet } from './sheets/AddApplicationSheet';
import {
  activeFilterCount,
  chooseView,
  effectiveView,
  filterKey,
  DEFAULT_FILTERS,
  type FilterState,
  type TrackerUrlState,
} from './state';
import { FilterChipsRow, ManageBar, PrepareBar, SearchRow, TabsRow, ViewSwitch, type BulkKind } from './toolbar/Toolbar';
import { OptionsMenu, type TrackerActions } from './toolbar/OptionsMenu';
import { buildingProgress, buildingTitle, buildResumeZip, resumeZipRun, zipOutcomeText } from './zip/resumeZip';

const EMPTY_LIMITS: ColumnLimits = {};
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
/** The API takes at most 500 ids per bulk request. */
const BULK_CHUNK = 500;
const PAGE_STEP = 25;

/**
 * Whether this tab is building a resume zip, and its last status. It lives outside the page: a build keeps going when
 * the tracker is left, and the tracker shows it again when it is opened anew.
 */
function useResumeZipRun() {
  return useSyncExternalStore(resumeZipRun.subscribe, resumeZipRun.get, resumeZipRun.get);
}

/** The waiting toast's line, kept current as the build reports progress. */
function ZipProgressLine() {
  return <>{buildingProgress(useResumeZipRun().build)}</>;
}

/**
 * The Job Tracker: Active / Archived, Board | List | Chart, search, Filter and sort, the tracker's actions (⋯), Add
 * application and the application detail, with the state in the URL: ?view=board|list|chart&tab=active|archived&app=<id>.
 * v31 FIX-DOCS (REV-UX UX-1): the page header, then one toolbar row; the board's cards and the list's table are
 * TailorIT's own (CardFace, StageMeter); the words are the constants'.
 *
 * v33 SHARE-9 (PLAN F9; SP v33 PLAN-sharing.md §8): `?profiles=all` shows the All profiles view (profiles/AllProfilesView)
 * once a profile shared with the person lets them see its Job Tracker ("All profiles" in the header switches). On a
 * shared profile the page offers only what its owner lets the person do (`can`): Change for adding, moving, archiving,
 * selecting and importing; Prepare's Change for Prepare jobs; Exports for the CSV and the zip.
 */
function Tracker() {
  const [url, setUrl] = useTrackerUrl();
  const scope = useTrackerScope();
  // Until the person's profiles are read, a link to the All profiles view shows it (their own Job Tracker first).
  if (url.all && (scope.available || !scope.settled)) return <AllProfilesView url={url} setUrl={setUrl} scope={scope} />;
  return <SingleProfileTracker url={url} setUrl={setUrl} scope={scope} />;
}

/** The tab's own profile's Job Tracker (the person's own, or the shared profile the tab works on). */
function SingleProfileTracker({
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
  const view = effectiveView(url);
  // v33 SHARE-9: what the tab's profile lets the person do (everything on their own).
  const { can } = scope.view;
  const canEdit = can('tracker:edit');
  const actions: TrackerActions = {
    select: canEdit,
    prepare: can('prepare:run'),
    import: canEdit,
    export: can('exports'),
    buildResumes: can('exports'),
    archiveAll: canEdit,
  };
  /** A shared profile's refusal is the shell's to say (one alert); anything else is said here. */
  const failed = (error: unknown, fallback: string) => toastFailure(toast, error, fallback);

  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 500);
  const key = filterKey(filters, q);
  // "Load more" per column (and which column asked last), forgotten when the search or filters change.
  const [limitState, setLimitState] = useState<{ key: string; limits: ColumnLimits; loading: ApplicationStatus | null }>({
    key,
    limits: EMPTY_LIMITS,
    loading: null,
  });
  const limits = limitState.key === key ? limitState.limits : EMPTY_LIMITS;
  const loadingColumn = limitState.key === key ? limitState.loading : null;
  const [prefs, setPrefs] = useColumnPrefs();
  const [archivedShown, setArchivedShown] = useArchivedColumn();
  const { t } = usePublicConstants();
  // v36 FIX-WEB (D1): an archive of a Saved entry says what it did to the auto-apply queue.
  const queueWords = useQueueWords();
  const addButton = useRef<HTMLButtonElement>(null);
  const prepare = usePrepareAndQueue();
  // v34 FANWEB (PLAN G2): Select › Copy to profiles… saves the selected entries' jobs on other profiles (as Saved).
  const fanout = useTrackerFanout();
  const [copying, setCopying] = useState<string[] | null>(null);
  // v31 JOBSWEB: Retry read of an entry's job only the person sees (the card and row menu).
  const retryRead = useRetryRead();

  const [selectMode, setSelectMode] = useState(false);
  /** What the selection is for: Select applications' bulk actions, or Prepare jobs (v2.0). */
  const [selectPurpose, setSelectPurpose] = useState<'manage' | 'prepare'>('manage');
  const prepareMode = selectMode && selectPurpose === 'prepare';
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>(() => ({ key, ids: new Set() }));
  // A new search or filter starts a new selection (rows that left the screen are never acted on).
  const selected = selection.key === key ? selection.ids : EMPTY_SELECTION;
  const setSelected = (update: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) =>
    setSelection((current) => {
      const base = current.key === key ? current.ids : EMPTY_SELECTION;
      return { key, ids: typeof update === 'function' ? update(base) : update };
    });
  const [addOpen, setAddOpen] = useState(false);
  // v31 FIX-DOCS (REV-UX UX-3): what opened Add application gets focus back when it closes without adding.
  const addOpener = useRef<HTMLElement | null>(null);
  const openAdd = () => {
    addOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAddOpen(true);
  };
  const [importOpen, setImportOpen] = useState(false);
  const [archiveAllOpen, setArchiveAllOpen] = useState(false);
  const [lastApp, setLastApp] = useState<string | null>(url.app);

  const counts = useCounts();
  const board = useBoard(filters, q, limits, view === 'board');
  const list = useApplicationList(url.tab, filters, q, view === 'list');
  const archivedList = useApplicationList('archived', filters, q, view === 'board' && archivedShown);
  const sankey = useSankey(view === 'chart');
  const insights = useInsights(view === 'chart');
  const move = useMoveStatus({ onMoved: (result, previous) => celebrateIfReached(result.currentStatus, previous) });
  const favorite = useToggleFavorite();
  // v2.0: the Saved entries' auto-apply markers (Preparing, Filtered: …), as the Auto-apply page's Saved pane shows them.
  const markers = useSavedMarkers(url.tab === 'active' && view !== 'chart');

  const columns = board.data?.columns ?? null;
  const totals = useMemo(
    () => Object.fromEntries((columns ?? []).map((column) => [column.status, column.total])) as Record<string, number>,
    [columns],
  );
  // v33 TRACKER (F1): the stored statuses' lanes only (no Draft lane: a queued Saved entry is a Saved card with a Draft
  // badge). v32 LAYOUT (E11): the board always keeps a lane (Saved, when every one was hidden before Lanes shown and the
  // eyes kept the last one).
  const lanesChosen = visibleColumns(prefs, totals);
  const visible: ApplicationStatus[] = lanesChosen.length > 0 || archivedShown ? lanesChosen : [STATUS.saved];
  const listItems = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? null, [list.data]);
  const archivedItems = useMemo(() => archivedList.data?.pages.flatMap((page) => page.items) ?? null, [archivedList.data]);
  // "Select all" takes what is on screen: the shown columns' cards (and the Archived column's), or the list's rows.
  const loadedApplications =
    view === 'board'
      ? [
          ...(columns ?? []).filter((column) => visible.includes(column.status)).flatMap((column) => column.items),
          ...(archivedShown ? (archivedItems ?? []) : []),
        ]
      : view === 'list'
        ? (listItems ?? [])
        : [];
  const loadedIds = loadedApplications.map((item) => item.id);
  // Prepare jobs: only Saved entries with a job, not in the queue already, are chosen.
  const choosable = (item: ApplicationSummary) => prepareBlockReason(item) === null;
  const prepareIds = loadedApplications.filter(choosable).map((item) => item.id);
  const preparing = prepareIds.some((id) => prepare.pending.has(id));
  const namesOf = (items: readonly ApplicationSummary[]) =>
    new Map(items.map((item) => [item.id, { title: item.title, company: item.companyName }] as const));

  /** A Saved entry's marker: Draft when it is in the queue (A30, v33 F1), else the Saved pane's (trackerMarker). */
  const markerOf = (application: ApplicationSummary): MarkerView | null =>
    trackerMarker(application, markers.data?.get(application.id), t);

  // ------------------------------------------------------------------------------------------------- actions

  const openApplication = useCallback(
    (id: string, edit = false) => {
      setLastApp(id);
      setUrl({ ...url, app: id, edit });
    },
    [setUrl, url],
  );

  const changeTab = (tab: TrackerTab) => {
    setSelected(new Set());
    setUrl({ ...url, tab });
  };

  /** Select applications or Prepare jobs: the cards and rows get their boxes; the chart has none, so the list shows. */
  const startSelecting = (purpose: 'manage' | 'prepare') => {
    if (view === 'chart') setUrl({ ...url, view: 'list' });
    if (purpose !== selectPurpose) setSelected(new Set());
    setSelectPurpose(purpose);
    setSelectMode(true);
  };

  const changeView = (next: TrackerView) => {
    setUrl(chooseView(url, next));
  };

  const moveApplication = (application: ApplicationSummary, status: ApplicationStatus) => {
    if (status === application.currentStatus) return;
    // Moving a card into a hidden column on the board shows that column from now on.
    if (view === 'board' && !visible.includes(status)) setPrefs(showColumn(prefs, status));
    move.mutate(
      { id: application.id, status, from: application.currentStatus },
      { onError: (error) => failed(error, "We couldn't move the application. Please try again.") },
    );
  };

  const setArchived = async (application: ApplicationSummary, archived: boolean) => {
    try {
      // v36 FIX-WEB (D1): what the archive did to the auto-apply queue; a Saved entry it left as it was says why.
      let outcome: ReturnType<typeof archiveOneOutcome> | null = null;
      if (archived) outcome = archiveOneOutcome(await trackerApi.archive(application.id), queueWords.box, queueWords.name);
      else await trackerApi.restore(application.id);
      void invalidateApplications(client);
      if (outcome?.left) {
        toast.toast({ type: 'info', title: QUEUE_COPY.notArchived, description: outcome.notes.join(' ') });
        return;
      }
      toast.toast({
        type: 'success',
        title: archived ? 'Application archived' : 'Application restored',
        description: outcome && outcome.notes.length > 0 ? outcome.notes.join(' ') : undefined,
        action: {
          label: 'Undo',
          onClick: () => void setArchived(application, !archived),
        },
      });
    } catch (error) {
      failed(error, "We couldn't update the application. Please try again.");
    }
  };

  /** An archived card dropped on a status column: restored, and moved when the column is another status. */
  const restoreInto = async (application: ApplicationSummary, status: ApplicationStatus) => {
    try {
      await trackerApi.restore(application.id);
      if (status !== application.currentStatus) {
        if (!visible.includes(status)) setPrefs(showColumn(prefs, status));
        const result = await trackerApi.status(application.id, status);
        celebrateIfReached(result.currentStatus, application.currentStatus);
      }
      toast.success('Application restored');
    } catch (error) {
      failed(error, "We couldn't restore the application. Please try again.");
    } finally {
      void invalidateApplications(client);
    }
  };

  const handlers: CardHandlers = {
    onOpen: (application) => openApplication(application.id),
    onMove: moveApplication,
    onArchive: (application) => void setArchived(application, true),
    onRestore: (application) => void setArchived(application, false),
    onToggleFavorite: (application) => favorite.mutate({ id: application.id, favorite: !application.favorite }),
    selectBlocked: prepareMode ? prepareBlockReason : undefined,
    markerOf,
    // v33 SHARE-9: a shared profile without the Job Tracker's Change box: no drag, no Move to, no Archive, no heart.
    canEdit: canEdit ? undefined : () => false,
    // The card menu's Prepare (Saved entries with a job).
    onPrepare: actions.prepare
      ? (application) => prepare.prepare({ applicationIds: [application.id], names: namesOf([application]) })
      : undefined,
    onRetryRead: (application) => {
      if (application.jobId !== null) retryRead.retry(application.jobId);
    },
    onToggleSelected: (application, on) =>
      setSelected((current) => {
        const next = new Set(current);
        if (on) next.add(application.id);
        else next.delete(application.id);
        return next;
      }),
  };

  const loadMoreColumn = useCallback(
    (status: ApplicationStatus) => {
      setLimitState((current) => {
        const base = current.key === key ? current.limits : EMPTY_LIMITS;
        return { key, limits: { ...base, [status]: (base[status] ?? PAGE_STEP) + PAGE_STEP }, loading: status };
      });
    },
    [key],
  );

  const bulk = async (kind: BulkKind) => {
    const onScreen = new Set(loadedIds);
    const ids = [...selected].filter((id) => onScreen.has(id));
    const action = typeof kind === 'object' ? 'status' : kind;
    let affected = 0;
    // v36 FIX-WEB (D1): an archive's queue counts, over every chunk.
    let queue: QueueCounts = {};
    try {
      for (let start = 0; start < ids.length; start += BULK_CHUNK) {
        const answer = await trackerApi.bulk({
          ids: ids.slice(start, start + BULK_CHUNK),
          action,
          ...(typeof kind === 'object' ? { status: kind.status, occurredOn: localToday() } : {}),
        });
        affected += answer.affected;
        queue = addQueueCounts(queue, answer);
      }
    } finally {
      void invalidateApplications(client);
    }
    setSelected(new Set());
    const word = { archive: 'archived', unarchive: 'restored', delete: 'deleted', status: 'updated' }[action];
    const notes = queueSentences(queue, queueWords.box, queueWords.name);
    toast.success(`${affected} ${affected === 1 ? 'application' : 'applications'} ${word}`, notes.length > 0 ? notes.join(' ') : undefined);
  };

  const exportCsv = async () => {
    const id = toast.info('Exporting CSV…');
    try {
      const name = await downloadExport(url.tab, filters, q);
      toast.dismiss(id);
      toast.success('Export ready', name);
    } catch (error) {
      toast.dismiss(id);
      failed(error, "We couldn't export your applications. Please try again.");
    }
  };

  const buildingResumes = useResumeZipRun().running;
  // v2.0 fix (SEC-6, coordinator decision): any ZIP of several resumes is the Paid feature `batch_download` (A28), here
  // as in Documents: a Free account sees the lock, and pressing opens the locked feature's dialog; a refusal the server
  // still sends (the account changed meanwhile) opens the limit dialog.
  const account = useAccount().data;
  const resumesLocked = isFeatureLocked(account, 'batch_download');
  const [resumesLockOpen, setResumesLockOpen] = useState(false);
  const zipLimits = useLimitDialog();

  /**
   * "Build resumes": a zip of each application's resume. `ids`: the Select applications selection (only what is on screen, as
   * the bulk actions do); null: every active Saved application. The waiting toast stays until the zip is saved.
   */
  const buildResumes = async (ids: string[] | null) => {
    if (resumeZipRun.get().running) return;
    if (resumesLocked) {
      setResumesLockOpen(true);
      return;
    }
    if (ids === null && counts.data && (counts.data.byStatus['1'] ?? 0) === 0) {
      toast.info('No Saved applications', 'Save jobs from the Jobs page, or choose applications with Select applications.');
      return;
    }
    if (ids !== null && ids.length === 0) return;
    if (ids !== null && ids.length > RESUME_ZIP_MAX_APPLICATIONS) {
      toast.error(
        `Select at most ${RESUME_ZIP_MAX_APPLICATIONS} applications`,
        `One zip holds up to ${RESUME_ZIP_MAX_APPLICATIONS} resumes. Select fewer and build again.`,
      );
      return;
    }
    resumeZipRun.set({ running: true, build: null });
    const waiting = toast.toast({
      type: 'info',
      title: buildingTitle(ids?.length ?? null),
      description: <ZipProgressLine />,
      timeout: 0,
    });
    try {
      const ready = await buildResumeZip({ ids, onProgress: (build) => resumeZipRun.set({ running: true, build }) });
      toast.dismiss(waiting);
      toast.toast({ type: 'success', title: 'Resumes ready', description: zipOutcomeText(ready), timeout: 10_000 });
    } catch (error) {
      toast.dismiss(waiting);
      // v33 SHARE-9 fix (review): a shared profile's refusal is the shell's alert, not a second toast.
      if (!isProfileRefusal(error) && !zipLimits.show(error)) toast.error("We couldn't build your resumes", userMessage(error, 'Please try again.'));
    } finally {
      resumeZipRun.set({ running: false, build: resumeZipRun.get().build });
      // Building first makes the selection's pending resume choices, which the detail sheets show.
      void invalidateApplications(client);
    }
  };

  /** "Prepare": the selection's Saved entries (only what is on screen); the selection clears once answered. */
  const prepareSelected = () => {
    const chosen = loadedApplications.filter((item) => choosable(item) && selected.has(item.id));
    prepare.prepare({
      applicationIds: chosen.map((item) => item.id),
      names: namesOf(chosen),
      onDone: () => setSelected(new Set()),
    });
  };

  const buildSelectedResumes = () => {
    const onScreen = new Set(loadedIds);
    void buildResumes([...selected].filter((id) => onScreen.has(id)));
  };

  const filtered = q.trim() !== '' || activeFilterCount(filters) > 0;
  const emptyKind: ListEmptyKind = filtered ? 'no-match' : url.tab === 'archived' ? 'archived' : 'first';

  return (
    // v32 FIX-UX (UXREQ-13): a wide page, as Jobs and Auto-apply (up to 1600 px).
    <div
      className={clsx(
        'mx-auto flex w-full max-w-[1600px] flex-col',
        view === 'board' ? 'h-[calc(100dvh_-_var(--spacing-topbar))] min-h-[560px]' : 'min-h-full',
      )}
    >
      <div className={clsx(PAGE_GUTTER, 'flex shrink-0 flex-col gap-3 pt-4 sm:pt-6', view === 'board' ? 'pb-3 sm:pb-5' : 'pb-6')}>
        {/* v31 JOBSWEB: the page header (the visual identity's page pattern), "Add application" its main action. v32 FIX-UX
            (UXREQ-5): on a phone Add application is its "+" alone and Board | List | Chart sits by the title, so one
            toolbar row is left above the board. */}
        <PageHeader
          title="Job Tracker"
          description={t('MSG_TRACKER_PAGE_DESCRIPTION')}
          actions={
            <>
              <ViewSwitch view={view} onViewChange={changeView} className="sm:hidden" />
              {/* v33 SHARE-9: the All profiles view, once a shared profile's Job Tracker can be seen. */}
              {scope.available && <AllProfilesToggle on={false} onChange={() => setUrl({ ...url, all: true, app: null, edit: false })} />}
              {canEdit && (
                <Button
                  ref={addButton}
                  icon={<PlusIcon size={16} weight="bold" />}
                  onClick={openAdd}
                  aria-label="Add application"
                  className="max-sm:size-11 max-sm:px-0"
                  data-add-application=""
                >
                  <span className="max-sm:sr-only">Add application</span>
                </Button>
              )}
            </>
          }
          className="max-sm:items-center sm:mb-3"
        />
        <SearchRow
          view={view}
          search={search}
          onSearchChange={setSearch}
          onViewChange={changeView}
          tabs={<TabsRow tab={url.tab} counts={counts.data} onTabChange={changeTab} />}
          options={
            <OptionsMenu
              view={view}
              filters={filters}
              onFiltersChange={setFilters}
              onListView={() => setUrl({ ...url, view: 'list' })}
              columns={APPLICATION_STATUSES.map((status) => ({
                status,
                count: totals[status] ?? 0,
                visible: visible.includes(status),
              }))}
              onColumnToggle={(status, on) => setPrefs(on ? showColumn(prefs, status) : hideColumn(prefs, status))}
              archivedColumn={{ count: counts.data?.archived ?? 0, visible: archivedShown }}
              onArchivedToggle={setArchivedShown}
              onManage={() => startSelecting('manage')}
              onPrepare={() => startSelecting('prepare')}
              onImport={() => setImportOpen(true)}
              onExport={() => void exportCsv()}
              onBuildResumes={() => void buildResumes(null)}
              buildingResumes={buildingResumes}
              resumesLocked={resumesLocked}
              onArchiveAll={() => setArchiveAllOpen(true)}
              actions={actions}
            />
          }
        />
        {prepareMode && view !== 'chart' && (
          <PrepareBar
            count={prepareIds.filter((id) => selected.has(id)).length}
            total={prepareIds.length}
            allSelected={prepareIds.length > 0 && prepareIds.every((id) => selected.has(id))}
            onSelectAll={(on) => setSelected(on ? new Set(prepareIds) : new Set())}
            onPrepare={prepareSelected}
            pending={preparing}
            onDone={() => {
              setSelectMode(false);
              setSelected(new Set());
            }}
          />
        )}
        {selectMode && !prepareMode && view !== 'chart' && (
          <ManageBar
            tab={url.tab}
            count={selected.size}
            total={loadedIds.length}
            allSelected={loadedIds.length > 0 && loadedIds.every((id) => selected.has(id))}
            onSelectAll={(on) => setSelected(on ? new Set(loadedIds) : new Set())}
            onBulk={bulk}
            // v36 FIX-WEB (D1): Archive's question counts the chosen Saved entries in the auto-apply queue.
            archiveNote={inQueueNote(
              loadedApplications.filter((item) => selected.has(item.id) && isDraft(item)).length,
              queueWords,
            )}
            // v33 SHARE-9 fix (review): the zip only with Exports; Delete only on the person's own profile (F9).
            onBuildResumes={actions.buildResumes ? buildSelectedResumes : undefined}
            buildingResumes={buildingResumes}
            resumesLocked={resumesLocked}
            deletable={!scope.view.acting}
            onCopy={
              fanout.available
                ? () => {
                    const onScreen = new Set(loadedIds);
                    setCopying([...selected].filter((id) => onScreen.has(id)));
                  }
                : undefined
            }
            onDone={() => {
              setSelectMode(false);
              setSelected(new Set());
            }}
          />
        )}
        {view !== 'chart' && <FilterChipsRow filters={filters} onChange={setFilters} />}
      </div>

      {view === 'board' && board.isError && !board.data && (
        <div className={PAGE_GUTTER}>
          <LoadFailure error={board.error} onRetry={() => void board.refetch()} />
        </div>
      )}
      {view === 'board' && !(board.isError && !board.data) && (
        <div className="min-h-0 flex-1">
          <BoardView
            columns={columns}
            visible={visible}
            prefs={prefs}
            onPrefsChange={setPrefs}
            handlers={handlers}
            openId={url.app}
            selectMode={selectMode}
            selected={selected}
            onLoadMore={loadMoreColumn}
            loadingMore={board.isPlaceholderData ? loadingColumn : null}
            onDrop={moveApplication}
            archived={
              archivedShown
                ? {
                    items: archivedItems,
                    total: archivedList.data?.pages[0]?.total ?? counts.data?.archived ?? 0,
                    hasMore: Boolean(archivedList.hasNextPage),
                    loadingMore: archivedList.isFetchingNextPage,
                    onLoadMore: () => void archivedList.fetchNextPage(),
                    onHide: () => setArchivedShown(false),
                  }
                : null
            }
            onArchiveDrop={(application) => void setArchived(application, true)}
            onRestoreDrop={(application, status) => void restoreInto(application, status)}
            refreshing={board.isFetching}
            filtered={filtered}
          />
        </div>
      )}
      {view === 'list' && (
        <div className={clsx(PAGE_GUTTER, 'pb-12')}>
          {list.isError && !list.data ? (
            <LoadFailure error={list.error} onRetry={() => void list.refetch()} />
          ) : (
            <ListView
              items={listItems}
              loading={list.isLoading}
              empty={emptyKind}
              handlers={handlers}
              openId={url.app}
              selectMode={selectMode}
              selected={selected}
              hasMore={Boolean(list.hasNextPage)}
              loadingMore={list.isFetchingNextPage}
              failed={list.isFetchNextPageError}
              onLoadMore={() => void list.fetchNextPage()}
              onAdd={canEdit ? openAdd : null}
            />
          )}
        </div>
      )}
      {view === 'chart' && (
        <div className={PAGE_GUTTER}>
          <ChartView
            sankey={sankey.data}
            insights={insights.data}
            loading={sankey.isLoading}
            error={sankey.error ?? insights.error}
          />
        </div>
      )}

      <AddApplicationSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        returnFocus={() => (addOpener.current?.isConnected ? addOpener.current : addButton.current)}
        onAdded={(application: ApplicationDetail, fromLink: boolean) => {
          void invalidateApplications(client);
          toast.success('Application added');
          // v31 JOBSWEB: an entry TailorIT read from its link opens as it is; a typed one in edit mode.
          openApplication(application.id, !fromLink);
        }}
      />
      <DetailSheet
        id={url.app ?? lastApp}
        open={url.app !== null}
        initialEdit={url.edit}
        onEditConsumed={() => setUrl({ ...url, edit: false })}
        onClose={() => setUrl({ ...url, app: null, edit: false })}
      />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} />
      {fanout.available && (
        <ProfilesDialog
          open={copying !== null}
          onOpenChange={(open) => !open && setCopying(null)}
          title={FANOUT_COPY.copyToTitle(copying?.length ?? 0)}
          help={FANOUT_COPY.copyToHelp}
          profiles={fanout.profiles}
          label={fanout.label}
          exclude={(profile) => profile.current}
          confirmLabel={FANOUT_COPY.copyConfirm}
          // v34 FANWEB fix (spec L2): the opener is off once the selection clears: focus goes to the bar's Done.
          finalFocus={manageBarFocus}
          onConfirm={async (targets) => {
            if (!copying) return;
            await fanout.copy(
              copying.map((applicationId) => ({ profile: fanout.tab, applicationId })),
              targets,
            );
            setSelected(new Set());
          }}
        />
      )}
      {fanout.element}
      {prepare.elements}
      <LockedFeatureDialog feature="batch_download" open={resumesLockOpen} onOpenChange={setResumesLockOpen} />
      {zipLimits.dialog}
      <ConfirmDialog
        open={archiveAllOpen}
        onOpenChange={setArchiveAllOpen}
        title={t('MSG_TRACKER_ARCHIVE_ALL_TITLE')}
        description={t('MSG_TRACKER_ARCHIVE_ALL_TEXT')}
        confirmLabel="Archive"
        tone="primary"
        onConfirm={async () => {
          const { archived, ...queue } = await trackerApi.archiveAll();
          void invalidateApplications(client);
          // v36 FIX-WEB (D1): what it did to the auto-apply queue, and the Saved entries it left there.
          const notes = queueSentences(queue, queueWords.box, queueWords.name);
          toast.success(`${archived} ${archived === 1 ? 'application' : 'applications'} archived`, notes.length > 0 ? notes.join(' ') : undefined);
        }}
      />
    </div>
  );
}

/** A read that failed: the kit's load error ("Your applications didn't load.", its reason, Try again; v32 FIX-UX). */
function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <LoadError thing="Your applications" error={error} onRetry={onRetry} />;
}

export function TrackerPage() {
  return (
    <Suspense fallback={<PageSpinner label="Loading your applications..." />}>
      <Tracker />
    </Suspense>
  );
}
