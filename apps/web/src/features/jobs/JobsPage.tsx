'use client';

import { clsx } from 'clsx';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageSpinner } from '@/components/ui/Spinner';
import { usePublicConstants } from '@/lib/constants';
import { AddJobButton } from './add/AddJobDialog'; // v31 JOBSWEB
import type { JobListItem } from './api';
import { JobDrawer } from './detail/JobDrawer';
import { DetailPaneSkeleton, JobDetailPanel, type DrawerNav } from './detail/JobDetailPanel';
import { clearedQuery } from './filters';
import { matchCount } from './format';
import { failure, useFacet, useJobDetail, useJobsList, useRowMatches, useSaveToggle } from './hooks';
import type { OpenHow } from './list/JobCard';
import { JobList, ResultsBar, needsResume, type JobSelection } from './list/JobList';
import { tabCan, useTabProfile } from '../sharing/access'; // v33 FIX-1
import { SELECTION_COPY, onTabAlone, tabSaveReport, tabUnsaveReport, type SelectionAction } from './list/selection'; // v36 JOBS
import { SELECTION_BAR_FIRST } from './list/selectionCopy'; // v36 FIX-WEB (ux L4)
import { JobsToolbar } from './toolbar/JobsToolbar';
import { queryKeyOf } from './url';
import { useJobsUrl } from './useJobsUrl';
import { useSplitLayout } from './useSplitLayout';
import { useFrameHeight } from '@/lib/useFrameHeight'; // v36 JOBS
import { useToast } from '@/components/ui/Toast';
import { isProfileRefusal, userMessage } from '@/lib/api'; // v36 JOBS
import type { FanoutTargets } from '@tailorit/shared/sharing';
import type { RowSaveTo } from './list/JobCard';
import { FANOUT_COPY } from '../sharing/fanout/copy'; // v34 FANWEB
import { boxName } from '../sharing/fanout/targets'; // v36 FIX-WEB (D8)
import { ProfilesDialog } from '../sharing/fanout/parts'; // v34 FANWEB
import { useSavedOn } from '../sharing/fanout/useFanout'; // v34 FANWEB
import { useSaveToProfiles } from '../sharing/fanout/useSaveTo'; // v34 FANWEB

const NO_JOBS: ReadonlySet<number> = new Set();

/** The list's row link of a job (focus goes back to it), or null when the list does not show the job. */
function rowLinkOf(jobId: number | null): HTMLElement | null {
  if (jobId === null) return null;
  return document.querySelector<HTMLElement>(`[data-job-card="${jobId}"] h3 a`);
}

/**
 * v32 JOBS2 (E3): the Jobs page (`/jobs?jobId=…&filters`), two panes again, in v3.1's look. The page header (Jobs, its
 * "?", Add job), the search panel (search, filters, the filters in use as removable chips), then (v32 FIX-UX, UXREQ-1: a
 * 1600 px page, the results bar the list card's own header, the list 40 % wide between 340 and 560 px):
 *   - from 1024 px (the split): the list of compact two-line rows on the left and the job's detail on the right, both on
 *     screen. The first job is shown as the list loads; a row shows its job in the pane (the address is replaced, so
 *     reload and a shared link land on it). v36 JOBS (PLAN J8): the frame of the two is measured to the window (16 px
 *     above its edge), so the page does not scroll: the list's rows scroll inside their card, under the results bar,
 *     and the pane scrolls on its own. Previous / Next walk the list (the row follows into view in the list); Escape in
 *     the pane goes back to the row.
 *   - below (the stack): the list fills the page and a row opens its job full screen with Back (the address gets a
 *     history entry, so the browser's Back closes it; focus returns to the row).
 */
export function JobsPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <JobsPageContent />
    </Suspense>
  );
}

function JobsPageContent() {
  const { t, get } = usePublicConstants();
  const { query, jobId, setQuery, updateQuery, selectJob, openJob, closeJob, currentJobId } = useJobsUrl();
  const split = useSplitLayout();
  const list = useJobsList(query);
  const { toggle } = useSaveToggle();
  // v33 FIX-1 (PLAN-sharing §9: write controls hidden or off without the Change box): on a profile shared without the
  // Job Tracker's Change, no Add job, Select or row Save (each was refused).
  const trackerEdit = tabCan(useTabProfile(), 'tracker:edit');
  const companies = useFacet('companies', '', query.companies.length > 0);
  const pages = useMemo(() => list.data?.pages ?? [], [list.data]);
  const matches = useRowMatches(pages);

  const items = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  // v34 FANWEB (PLAN G2, G4): with a shared profile, rows and the Select bar save to other profiles too (Save to…), and
  // each row says which other profiles have its job ("Saved on"), read for the jobs on screen.
  const toast = useToast();
  const saveTo = useSaveToProfiles();
  const itemIds = useMemo(() => items.map((item) => item.id), [items]);
  const savedOn = useSavedOn(itemIds);
  /**
   * The jobs the choice of profiles is open for (a row's, or the selection's), whether it ends the selection, and what it
   * does (v36 JOBS: the selection's Unsave ▾ › Choose profiles… too).
   */
  const [choosingFor, setChoosingFor] = useState<{ jobIds: number[]; selection: boolean; action: SelectionAction } | null>(null);
  const { save: saveOn, unsave: unsaveOn, profiles: saveProfiles, label: saveLabel, available: saveAvailable, tab: tabProfile } = saveTo;
  // v36 FIX-WEB (D8, Jobs as Auto-apply): on a profile shared to see only, Select still shows when another profile may
  // be saved to; the bar's Save and Unsave are then off on this profile (with why) and their carets offer the others.
  const selectOthers = !trackerEdit && saveTo.others;
  const canSelect = trackerEdit || selectOthers;
  const profilesOffered = saveAvailable || selectOthers;
  const rowSaveTo = useMemo<RowSaveTo | undefined>(
    () =>
      saveAvailable
        ? {
            profiles: saveProfiles,
            label: saveLabel,
            onPick: (jobId: number, targets: FanoutTargets) =>
              void saveOn(targets, [jobId]).catch((error: unknown) => failure(toast, 'The job could not be saved', error)),
            onChoose: (jobId: number) => setChoosingFor({ jobIds: [jobId], selection: false, action: 'save' }),
          }
        : undefined,
    [saveAvailable, saveProfiles, saveLabel, saveOn, toast],
  );
  const total = pages[0]?.total ?? 0;
  const settled = list.isSuccess && !list.isPlaceholderData;
  const filtersKey = queryKeyOf(query);

  // v2.0 (A4): "Select" chooses jobs in the list (no job is queued from here: the Auto-apply page prepares them). v36
  // JOBS (PLAN J2-J4): every row can be chosen, saved and applied ones too; the bar saves them to or removes them from
  // Saved Jobs, on the tab's profile or the profiles picked. New filters start a new choice (jobs that left the list are
  // never touched).
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<number> }>(() => ({
    key: filtersKey,
    ids: NO_JOBS,
  }));
  const selected = selection.key === filtersKey ? selection.ids : NO_JOBS;
  const toggleSelected = useCallback(
    (job: JobListItem, on: boolean) =>
      setSelection((current) => {
        const next = new Set(current.key === filtersKey ? current.ids : NO_JOBS);
        if (on) next.add(job.id);
        else next.delete(job.id);
        return { key: filtersKey, ids: next };
      }),
    [filtersKey],
  );
  const endSelection = useCallback(() => {
    setSelectMode(false);
    setSelection({ key: filtersKey, ids: NO_JOBS });
  }, [filtersKey]);
  // UX-3: starting and ending the choice keeps keyboard focus: on the bar's first control, then back on Select.
  const focusAfterMode = useRef<'bar' | 'select' | null>(null);
  useEffect(() => {
    const target = focusAfterMode.current;
    if (!target) return;
    focusAfterMode.current = null;
    const element =
      target === 'bar'
        ? document.querySelector<HTMLElement>(SELECTION_BAR_FIRST)
        : document.querySelector<HTMLElement>('[data-select-start]');
    element?.focus();
  }, [selectMode]);
  // v36 JOBS (PLAN J3-J5): Save and Unsave of the chosen jobs (only what the list shows now, in its order), on the tab's
  // profile or on `targets`: one message with Undo (useSaveToProfiles: in batches of SAVE_BATCH_MAX); on the tab's
  // profile alone the message is the tab's own ("3 jobs saved", "2 already saved."). Done, the choice ends and focus goes
  // back to Select; a request that failed keeps it, to try again.
  const [acting, setActing] = useState<SelectionAction | null>(null);
  const chosenIds = () => items.filter((item) => selected.has(item.id)).map((item) => item.id);
  const runSelection = useCallback(
    async (action: SelectionAction, targets: FanoutTargets, jobIds: readonly number[]) => {
      const alone = onTabAlone(targets, tabProfile);
      if (action === 'save') await saveOn(targets, jobIds, alone ? { report: (answer) => tabSaveReport(answer, saveProfiles, saveLabel) } : {});
      else await unsaveOn(targets, jobIds, alone ? { report: (answer) => tabUnsaveReport(answer, saveProfiles, saveLabel) } : {});
      focusAfterMode.current = 'select';
      endSelection();
    },
    [saveOn, unsaveOn, tabProfile, saveProfiles, saveLabel, endSelection],
  );
  const actOnSelection = (action: SelectionAction, targets: FanoutTargets) => {
    const jobIds = chosenIds();
    if (acting !== null || jobIds.length === 0) return;
    setActing(action);
    runSelection(action, targets, jobIds)
      .catch((error: unknown) => {
        // A shared profile's refusal is the shell's one alert.
        if (isProfileRefusal(error)) return;
        toast.error(action === 'save' ? SELECTION_COPY.saveFailed : SELECTION_COPY.unsaveFailed, userMessage(error, 'Please try again.'));
      })
      .finally(() => setActing(null));
  };
  const selectionProps: JobSelection = {
    active: selectMode,
    selected,
    pending: acting,
    onStart: () => {
      focusAfterMode.current = 'bar';
      setSelectMode(true);
    },
    onToggle: toggleSelected,
    // Every job the list shows (saved and applied ones too).
    onSelectAll: (on) => setSelection({ key: filtersKey, ids: on ? new Set(items.map((item) => item.id)) : NO_JOBS }),
    onSave: () => actOnSelection('save', [tabProfile]),
    onUnsave: () => actOnSelection('unsave', [tabProfile]),
    // v36 JOBS (PLAN J4): with a shared profile, Save ▾ and Unsave ▾ on the profiles picked (Choose profiles…: the dialog).
    profiles: profilesOffered
      ? {
          profiles: saveProfiles,
          labelOf: saveLabel,
          onPick: (action, targets) => actOnSelection(action, targets),
          onChoose: (action) => setChoosingFor({ jobIds: chosenIds(), selection: true, action }),
        }
      : undefined,
    ...(selectOthers ? { tabOff: FANOUT_COPY.prepareBlocked(boxName('tracker:edit', saveLabel)) } : {}),
    onDone: () => {
      focusAfterMode.current = 'select';
      endSelection();
    },
  };

  // The split shows the first job as the list loads (and again after new filters); the address records it, so a
  // reload lands on the same job. The stack opens nothing by itself: its list is the page.
  useEffect(() => {
    if (split && jobId === null && settled && items[0]) selectJob(items[0].id);
  }, [split, jobId, settled, items, selectJob]);

  // A job the person added from a page that gave way to the posting's shared job answers as that job: the address
  // follows it, so Save, Hide and the rest act on the job shown (the detail shares this query).
  const detail = useJobDetail(jobId);
  const answeredId = detail.data?.id;
  useEffect(() => {
    if (jobId !== null && answeredId !== undefined && answeredId !== jobId) selectJob(answeredId);
  }, [jobId, answeredId, selectJob]);

  // New filters start the list from the top: v36 JOBS (PLAN J8) the list's own rows beside the details, the page in the
  // stack (when it has scrolled past the list's top).
  const listScroller = useRef<HTMLDivElement>(null);
  const firstFilters = useRef(filtersKey);
  useEffect(() => {
    if (firstFilters.current === filtersKey) return;
    firstFilters.current = filtersKey;
    if (split) {
      listScroller.current?.scrollTo({ top: 0 });
      return;
    }
    const feed = document.querySelector('[data-jobs-feed]');
    if (feed && feed.getBoundingClientRect().top < 0) window.scrollTo({ top: 0 });
  }, [filtersKey, split]);

  // The split: the row of the job shown stays in view in the list's rows as Previous / Next walk the list (v36 JOBS: the
  // rows scroll inside their card, under the results bar, which is outside that scroller).
  useEffect(() => {
    if (!split || jobId === null) return;
    const row = document.querySelector<HTMLElement>(`[data-job-card="${jobId}"]`);
    const scroller = listScroller.current;
    if (!row || !scroller) return;
    const box = row.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) row.scrollIntoView({ block: 'nearest' });
  }, [split, jobId]);

  const companyNames = useMemo(
    () => new Map((companies.data?.items ?? []).map((item) => [item.value, item.label] as const)),
    [companies.data],
  );

  const toggleSave = useCallback(
    (job: JobListItem) => toggle({ jobId: job.id, saved: job.saved, appliedOn: job.appliedOn, applicationId: job.applicationId }),
    [toggle],
  );

  // The job the sheet shows last: closing it gives focus back to its row.
  const lastShown = useRef<number | null>(null);
  useEffect(() => {
    if (jobId !== null) lastShown.current = jobId;
  }, [jobId]);

  // The pane's title takes focus for this job once it is shown: a row opened with the keyboard, the next job after a
  // hide. A pointer leaves focus on the row, so the list is where the person carries on.
  const [focusDetailFor, setFocusDetailFor] = useState<number | null>(null);
  const [applyIntent, setApplyIntent] = useState<number | null>(null);

  const open = useCallback(
    (id: number, how?: OpenHow) => {
      if (split) {
        if (how?.keyboard) setFocusDetailFor(id);
        selectJob(id);
      } else {
        openJob(id);
      }
    },
    [split, selectJob, openJob],
  );
  // While the list fills the page (the stack), a row's quick Apply opens its job and its posting.
  const quickApply = useCallback(
    (id: number) => {
      setApplyIntent(id);
      openJob(id);
    },
    [openJob],
  );

  // Previous / Next walk the list as it is loaded; Next at the end of a page loads the next one first. Each press steps
  // from the job last asked for, so quick presses count one by one before the address catches up.
  const index = jobId === null ? -1 : items.findIndex((item) => item.id === jobId);
  const { hasNextPage, fetchNextPage } = list;
  const step = (delta: -1 | 1) => {
    const at = items.findIndex((item) => item.id === currentJobId());
    if (at < 0) return;
    const target = items[at + delta];
    if (target) {
      selectJob(target.id);
      return;
    }
    if (delta === 1 && hasNextPage) {
      void fetchNextPage().then((result) => {
        const next = result.data?.pages.flatMap((page) => page.items)[at + 1];
        if (next) selectJob(next.id);
      });
    }
  };
  const nav: DrawerNav = {
    position: index >= 0 ? { index: index + 1, total: matchCount(total, get('JOB_SEARCH_COUNT_CAP')) } : null,
    onPrevious: index > 0 ? () => step(-1) : null,
    onNext: index >= 0 && (index < items.length - 1 || hasNextPage) ? () => step(1) : null,
  };

  // After hiding: the split shows the next job in the pane (or the one before when it was the last), its title taking
  // focus, the toast's Undo in reach; the sheet closes with focus on that job's row (a modal sheet keeps the page,
  // toasts included, out of reach while it is open).
  const onJobsHidden = useCallback(
    ({ jobId: hiddenJob, companyId }: { jobId?: number; companyId?: number }) => {
      const gone = (item: JobListItem) =>
        (hiddenJob !== undefined && item.id === hiddenJob) || (companyId !== undefined && item.company.id === companyId);
      const at = items.findIndex((item) => item.id === jobId);
      const after = items.slice(at + 1).find((item) => !gone(item));
      const before = items
        .slice(0, Math.max(at, 0))
        .reverse()
        .find((item) => !gone(item));
      const next = (after ?? before)?.id ?? null;
      if (split) {
        setFocusDetailFor(next);
        selectJob(next);
        return;
      }
      lastShown.current = next;
      closeJob();
    },
    [items, jobId, split, selectJob, closeJob],
  );

  // A job that no longer exists, in the pane: "Back to jobs" shows the list's first job again, focus on its row.
  const leaveGone = useCallback(() => {
    selectJob(null);
    document.querySelector<HTMLElement>('[data-job-card] h3 a')?.focus();
  }, [selectJob]);

  // The pane's way back (Escape, "Back to the job list"): the row of the job shown, else the list's first row.
  const backToList = useCallback(() => {
    (rowLinkOf(jobId) ?? document.querySelector<HTMLElement>('[data-job-card] h3 a'))?.focus();
  }, [jobId]);

  // The split draws the pane while there are jobs to show (or they are loading); an empty list or an error takes the
  // whole width with its next step. v36 JOBS (PLAN J8): the frame of the list and the pane is measured to the window
  // (lib/useFrameHeight: down to 16 px above its edge, at least 360 px), so the page does not scroll; the list's rows and
  // the pane scroll inside it. Below 1024 px the page scrolls as before.
  const showPane = split !== false && (list.isPending || items.length > 0 || jobId !== null);
  const framed = split === true && showPane;
  const frameRef = useRef<HTMLDivElement>(null);
  useFrameHeight(frameRef, framed);

  return (
    // v32 FIX-UX (UXREQ-1, UXREQ-13): a wide page, as Auto-apply and the Tracker (up to 1600 px). v36 JOBS: framed, no
    // padding under the frame (its own 16 px gap is the margin), or the page would scroll.
    <div className={clsx('mx-auto flex w-full max-w-[1600px] flex-col pt-6 pb-16', framed && 'lg:pb-0', PAGE_GUTTER)}>
      <PageHeader
        title="Jobs"
        // v32 JOBS2 (E5): one short sentence; the kit's PageHeader draws it as the title's "?" (COPY).
        description={t('MSG_JOBS_INTRO')}
        actions={trackerEdit ? <AddJobButton onOpenJob={(id) => open(id)} /> : undefined}
        className="mb-4"
      />
      <JobsToolbar
        query={query}
        onChange={updateQuery}
        onReplace={setQuery}
        onClearAll={() => setQuery(clearedQuery(query))}
        companyNames={companyNames}
      />
      <div className="mt-4" data-jobs-feed="" data-jobs-layout={split === null ? undefined : split ? 'split' : 'stack'}>
        {/* v33 JOBDETAIL (F2): the list takes 40% (340 to 560 px), less when the pane would then lack the 764 px its two
            columns need (43 rem inside its 24 px gutters, its border and a scrollbar of up to 17 px): two columns from
            1280 px, with a scrollbar or without. */}
        <div
          ref={frameRef}
          className={clsx(
            showPane && 'lg:grid lg:grid-cols-[clamp(340px,min(40%,100%_-_780px),560px)_minmax(0,1fr)] lg:gap-4',
            framed && 'lg:h-[var(--frame-height,calc(100dvh_-_var(--spacing-topbar)_-_32px))] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch',
          )}
          data-jobs-frame=""
        >
          <JobList
            query={query}
            list={list}
            selectedId={jobId}
            matches={matches}
            onSelect={open}
            onApply={split === false ? quickApply : undefined}
            onToggleSave={toggleSave}
            canSave={trackerEdit}
            saveTo={rowSaveTo}
            savedOn={savedOn}
            onClearAll={() => setQuery(clearedQuery(query))}
            companyNames={companyNames}
            selection={selectionProps}
            contained={framed}
            scrollerRef={listScroller}
            // v32 FIX-UX (UXREQ-1): the results bar is the list card's own header (it stays under the top bar).
            header={
              <ResultsBar
                query={query}
                list={list}
                selection={selectionProps}
                needsResume={needsResume(items, matches)}
                onQueryChange={updateQuery}
                canSave={canSelect}
              />
            }
          />
          {showPane && (
            // The pane: beside the list, the frame's height, scrolling on its own.
            <div
              className={clsx('hidden min-h-0 lg:flex lg:h-full', 'min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card')}
              data-detail-pane=""
            >
              {split && jobId !== null ? (
                <JobDetailPanel
                  jobId={jobId}
                  variant="pane"
                  nav={nav}
                  onClose={backToList}
                  onGone={leaveGone}
                  onJobsHidden={onJobsHidden}
                  focusTitle={focusDetailFor === jobId}
                  onTitleFocused={() => setFocusDetailFor(null)}
                />
              ) : (
                <DetailPaneSkeleton />
              )}
            </div>
          )}
        </div>
      </div>
      {profilesOffered && (
        <ProfilesDialog
          open={choosingFor !== null}
          onOpenChange={(open) => !open && setChoosingFor(null)}
          title={
            choosingFor?.action === 'unsave'
              ? FANOUT_COPY.unsaveSelectedTitle(choosingFor.jobIds.length)
              : choosingFor && choosingFor.jobIds.length > 1
                ? FANOUT_COPY.saveSelectedTitle(choosingFor.jobIds.length)
                : FANOUT_COPY.saveToTitle
          }
          help={choosingFor?.action === 'unsave' ? FANOUT_COPY.unsaveHelp : FANOUT_COPY.saveToHelp}
          profiles={saveProfiles}
          label={saveLabel}
          savedOn={choosingFor && !choosingFor.selection && choosingFor.jobIds.length === 1 ? savedOn.get(choosingFor.jobIds[0]!)?.choices : undefined}
          initial={choosingFor?.selection ? [saveTo.tab] : []}
          confirmLabel={choosingFor?.action === 'unsave' ? FANOUT_COPY.unsaveConfirm : FANOUT_COPY.saveToConfirm}
          // v34 FANWEB fix (spec L2): the Select bar goes with the save: focus returns to Select.
          finalFocus={choosingFor?.selection ? () => document.querySelector<HTMLElement>('[data-select-start]') ?? true : undefined}
          onConfirm={async (targets) => {
            if (!choosingFor) return;
            if (!choosingFor.selection) {
              await saveOn(targets, choosingFor.jobIds);
              return;
            }
            // v34 FANWEB fix (spec L2): focus back on Select, as Done does (the bar goes). v36 JOBS: Save or Unsave.
            setActing(choosingFor.action);
            try {
              await runSelection(choosingFor.action, targets, choosingFor.jobIds);
            } finally {
              setActing(null);
            }
          }}
        />
      )}
      {saveTo.element}
      {split === false && (
        <JobDrawer
          jobId={jobId}
          onClose={closeJob}
          nav={nav}
          // Back to the job's row (the next one after a hide); for a job the list does not show (opened from a link or
          // Add job), to Add job.
          finalFocus={() => rowLinkOf(lastShown.current) ?? document.querySelector<HTMLElement>('[data-add-job-button]') ?? true}
          onJobsHidden={onJobsHidden}
          applyIntent={applyIntent}
          onApplyIntentHandled={() => setApplyIntent(null)}
        />
      )}
    </div>
  );
}
