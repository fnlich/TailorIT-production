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
import { useFacet, useJobDetail, useJobsList, useRowMatches, useSaveToggle } from './hooks';
import type { OpenHow } from './list/JobCard';
import { JobList, ResultsBar, needsResume, type JobSelection } from './list/JobList';
import { saveBlockReason, useSaveSelected } from './list/useSaveSelected';
import { JobsToolbar } from './toolbar/JobsToolbar';
import { queryKeyOf } from './url';
import { useJobsUrl } from './useJobsUrl';
import { usePaneHeight, useSplitLayout } from './useSplitLayout';

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
 *     reload and a shared link land on it). The list scrolls with the page; the pane stays 16 px under the top bar and
 *     scrolls on its own. Previous / Next walk the list (the row follows into view); Escape in the pane goes back to the
 *     row.
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
  const companies = useFacet('companies', '', query.companies.length > 0);
  const pages = useMemo(() => list.data?.pages ?? [], [list.data]);
  const matches = useRowMatches(pages);

  const items = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  const total = pages[0]?.total ?? 0;
  const settled = list.isSuccess && !list.isPlaceholderData;
  const filtersKey = queryKeyOf(query);

  // v2.0 (A4): "Select" chooses jobs in the list to save to Saved Jobs (no job is queued from here: Prepare & Queue on
  // the Auto-apply page does that). New filters start a new choice (jobs that left the list are never saved).
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
  // Once saved, the choice ends; jobs a failed request never saved stay chosen, to try again.
  const { saveSelected, pending: saving } = useSaveSelected((left) => {
    if (left.length === 0) endSelection();
    else setSelection({ key: filtersKey, ids: new Set(left) });
  });
  const choosable = (item: JobListItem) => saveBlockReason(item) === null;
  // UX-3: starting and ending the choice keeps keyboard focus: on the bar's first control, then back on Select.
  const focusAfterMode = useRef<'bar' | 'select' | null>(null);
  useEffect(() => {
    const target = focusAfterMode.current;
    if (!target) return;
    focusAfterMode.current = null;
    const element =
      target === 'bar'
        ? document.querySelector<HTMLElement>('[data-selection-bar] button:not([disabled])')
        : document.querySelector<HTMLElement>('[data-select-start]');
    element?.focus();
  }, [selectMode]);
  const selectionProps: JobSelection = {
    active: selectMode,
    selected,
    pending: saving,
    onStart: () => {
      focusAfterMode.current = 'bar';
      setSelectMode(true);
    },
    onToggle: toggleSelected,
    // Only jobs not saved or applied to yet can be chosen.
    onSelectAll: (on) =>
      setSelection({ key: filtersKey, ids: on ? new Set(items.filter(choosable).map((item) => item.id)) : NO_JOBS }),
    // Only what the list shows now is saved, in its order.
    onSave: () => saveSelected(items.filter((item) => choosable(item) && selected.has(item.id)).map((item) => item.id)),
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

  // New filters start the list from the top (when the page has scrolled past it).
  const firstFilters = useRef(filtersKey);
  useEffect(() => {
    if (firstFilters.current === filtersKey) return;
    firstFilters.current = filtersKey;
    const feed = document.querySelector('[data-jobs-feed]');
    if (feed && feed.getBoundingClientRect().top < 0) window.scrollTo({ top: 0 });
  }, [filtersKey]);

  // The split: the row of the job shown stays in view as Previous / Next walk the list (it scrolls with the page).
  useEffect(() => {
    if (!split || jobId === null) return;
    const row = document.querySelector<HTMLElement>(`[data-job-card="${jobId}"]`);
    if (!row) return;
    const box = row.getBoundingClientRect();
    const bar = document.querySelector('[data-results-bar]')?.getBoundingClientRect().bottom ?? 0;
    if (box.top < bar || box.bottom > window.innerHeight) row.scrollIntoView({ block: 'nearest' });
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
  // whole width with its next step. Its height follows what the window shows of it (usePaneHeight).
  const showPane = split !== false && (list.isPending || items.length > 0 || jobId !== null);
  const paneRef = useRef<HTMLDivElement>(null);
  usePaneHeight(paneRef, split === true && showPane);

  return (
    // v32 FIX-UX (UXREQ-1, UXREQ-13): a wide page, as Auto-apply and the Tracker (up to 1600 px).
    <div className={clsx('mx-auto flex w-full max-w-[1600px] flex-col pt-6 pb-16', PAGE_GUTTER)}>
      <PageHeader
        title="Jobs"
        // v32 JOBS2 (E5): one short sentence; the kit's PageHeader draws it as the title's "?" (COPY).
        description={t('MSG_JOBS_INTRO')}
        actions={<AddJobButton onOpenJob={(id) => open(id)} />}
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
        <div
          className={clsx(showPane && 'lg:grid lg:grid-cols-[clamp(340px,40%,560px)_minmax(0,1fr)] lg:items-start lg:gap-4')}
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
            onClearAll={() => setQuery(clearedQuery(query))}
            companyNames={companyNames}
            selection={selectionProps}
            // v32 FIX-UX (UXREQ-1): the results bar is the list card's own header (it stays under the top bar).
            header={
              <ResultsBar
                query={query}
                list={list}
                selection={selectionProps}
                needsResume={needsResume(items, matches)}
                onQueryChange={updateQuery}
              />
            }
          />
          {showPane && (
            // The pane: beside the list from its top, down to the window's edge, scrolling on its own.
            <div
              ref={paneRef}
              className={clsx(
                'hidden lg:sticky lg:top-[calc(var(--spacing-topbar)_+_16px)] lg:flex',
                'lg:h-[var(--pane-height,calc(100dvh_-_var(--spacing-topbar)_-_32px))]',
                'min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card',
              )}
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
