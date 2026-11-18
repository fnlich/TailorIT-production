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
import type { DrawerNav } from './detail/JobDetailPanel';
import { clearedQuery } from './filters';
import { matchCount } from './format';
import { useFacet, useJobDetail, useJobsList, useRowMatches, useSaveToggle } from './hooks';
import { JobList, type JobSelection } from './list/JobList';
import { saveBlockReason, useSaveSelected } from './list/useSaveSelected';
import { JobsToolbar } from './toolbar/JobsToolbar';
import { queryKeyOf } from './url';
import { useJobsUrl } from './useJobsUrl';

const NO_JOBS: ReadonlySet<number> = new Set();

/** The feed's row link of a job (the drawer gives focus back to it), or null when the feed does not show the job. */
function rowLinkOf(jobId: number | null): HTMLElement | null {
  if (jobId === null) return null;
  return document.querySelector<HTMLElement>(`[data-job-card="${jobId}"] h3 a`);
}

/**
 * v31 FIX-JOBS: the Jobs page (`/jobs?jobId=…&filters`), TailorIT's own composition (REV-UX UX-1): the page header
 * ("Jobs", what the page is, Add job), the search panel (search, filters, the active filters as removable chips), then
 * one full-width feed of job rows, each measured against the person's resume with a tape meter. A row opens its job in
 * a drawer from the right (the address keeps the job, so links, reload and Back work: opening adds a history entry,
 * Back or Close removes it). The drawer steps through the feed with Previous / Next; closing it gives focus back to
 * the row. Nothing opens by itself: the feed is the page.
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
  const list = useJobsList(query);
  const { toggle } = useSaveToggle();
  const companies = useFacet('companies', '', query.companies.length > 0);
  const pages = useMemo(() => list.data?.pages ?? [], [list.data]);
  const matches = useRowMatches(pages);

  const items = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  const total = pages[0]?.total ?? 0;
  const filtersKey = queryKeyOf(query);

  // v2.0 (A4): "Select" chooses jobs in the feed to save to Saved Jobs (no job is queued from here: Prepare & Queue on
  // the Auto-apply page does that). New filters start a new choice (jobs that left the feed are never saved).
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
    // Only what the feed shows now is saved, in its order.
    onSave: () => saveSelected(items.filter((item) => choosable(item) && selected.has(item.id)).map((item) => item.id)),
    onDone: () => {
      focusAfterMode.current = 'select';
      endSelection();
    },
  };

  // A job the person added from a page that gave way to the posting's shared job answers as that job: the address
  // follows it, so Save, Hide and the rest act on the job shown (the drawer shares this query).
  const detail = useJobDetail(jobId);
  const answeredId = detail.data?.id;
  useEffect(() => {
    if (jobId !== null && answeredId !== undefined && answeredId !== jobId) selectJob(answeredId);
  }, [jobId, answeredId, selectJob]);

  // New filters start the feed from the top (when the page has scrolled past it).
  const firstFilters = useRef(filtersKey);
  useEffect(() => {
    if (firstFilters.current === filtersKey) return;
    firstFilters.current = filtersKey;
    const feed = document.querySelector('[data-jobs-feed]');
    if (feed && feed.getBoundingClientRect().top < 0) window.scrollTo({ top: 0 });
  }, [filtersKey]);

  const companyNames = useMemo(
    () => new Map((companies.data?.items ?? []).map((item) => [item.value, item.label] as const)),
    [companies.data],
  );

  const toggleSave = useCallback(
    (job: JobListItem) => toggle({ jobId: job.id, saved: job.saved, appliedOn: job.appliedOn, applicationId: job.applicationId }),
    [toggle],
  );

  // The job the drawer shows last: closing gives focus back to its row.
  const lastShown = useRef<number | null>(null);
  useEffect(() => {
    if (jobId !== null) lastShown.current = jobId;
  }, [jobId]);

  const [applyIntent, setApplyIntent] = useState<number | null>(null);

  const open = useCallback((id: number) => openJob(id), [openJob]);
  const quickApply = useCallback(
    (id: number) => {
      setApplyIntent(id);
      openJob(id);
    },
    [openJob],
  );

  // Previous / Next walk the feed as it is loaded; Next at the end of a page loads the next one first. Each press steps
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

  // After hiding, the drawer closes and focus lands on the next job's row (or the one before when it was the last),
  // where the person carries on; the toast's Undo is in reach then (a modal drawer keeps the page, toasts included,
  // out of reach while it is open).
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
      lastShown.current = (after ?? before)?.id ?? null;
      closeJob();
    },
    [items, jobId, closeJob],
  );

  return (
    <div className={clsx('mx-auto flex w-full max-w-[1280px] flex-col pt-7 pb-16', PAGE_GUTTER)}>
      <PageHeader
        title="Jobs"
        description={t('MSG_JOBS_INTRO')}
        actions={<AddJobButton onOpenJob={open} />}
        className="mb-6"
      />
      <JobsToolbar
        query={query}
        onChange={updateQuery}
        onReplace={setQuery}
        onClearAll={() => setQuery(clearedQuery(query))}
        companyNames={companyNames}
      />
      <JobList
        query={query}
        list={list}
        selectedId={jobId}
        matches={matches}
        onSelect={open}
        onApply={quickApply}
        onToggleSave={toggleSave}
        onQueryChange={updateQuery}
        onClearAll={() => setQuery(clearedQuery(query))}
        companyNames={companyNames}
        selection={selectionProps}
      />
      <JobDrawer
        jobId={jobId}
        onClose={closeJob}
        nav={nav}
        // Back to the job's row (the next one after a hide); for a job the feed does not show (opened from a link or Add
        // job), to Add job.
        finalFocus={() => rowLinkOf(lastShown.current) ?? document.querySelector<HTMLElement>('[data-add-job-button]') ?? true}
        onJobsHidden={onJobsHidden}
        applyIntent={applyIntent}
        onApplyIntentHandled={() => setApplyIntent(null)}
      />
    </div>
  );
}
