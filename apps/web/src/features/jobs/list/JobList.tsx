'use client';

import { CheckSquareIcon } from '@phosphor-icons/react/CheckSquare';
import { JOB_SORTS, JOB_SORT_LABEL, hasJobFilters, type JobRowMatch, type JobSort, type JobsQuery } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadError } from '@/components/ui/LoadError';
import { ArrowsDownUpIcon, CaretDownIcon, MagnifyingGlassIcon, PlusIcon } from '@/components/ui/icons';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useNow } from '@/lib/useNow';
import type { JobListItem } from '../api';
import { activeFilters } from '../filters';
import { foundJobsLabel, relevanceHint } from '../format';
import { HelpTip } from '@/components/ui/HelpTip';
import type { useJobsList } from '../hooks';
import { jobHrefBuilder } from '../url';
import { JobCard, type OpenHow } from './JobCard';
import { SaveAllButton } from './SaveAllButton';
import { BAR_BUTTON, BAR_WORD } from './styles';
import { saveBlockReason } from './useSaveSelected';

/** v2.0 (A4): choosing jobs to save to Saved Jobs (Prepare & Queue then queues them, on the Auto-apply page). */
export interface JobSelection {
  /** The rows show their boxes, and the results bar becomes the selection's bar. */
  active: boolean;
  selected: ReadonlySet<number>;
  /** The chosen jobs are being saved. */
  pending: boolean;
  onStart: () => void;
  onToggle: (job: JobListItem, selected: boolean) => void;
  /** Every job the list shows now, or none. */
  onSelectAll: (selected: boolean) => void;
  onSave: () => void;
  onDone: () => void;
}

type JobsList = ReturnType<typeof useJobsList>;

/** Few enough results that the list suggests removing a filter. */
const FEW_RESULTS = 10;

/** The jobs the list has loaded, in its order. */
export function listedJobs(list: JobsList): JobListItem[] {
  return list.data?.pages.flatMap((page) => page.items) ?? [];
}

/** No resume to measure against: every measured row answers the same, so one says it for all. */
export function needsResume(items: readonly JobListItem[], matches: { byJob: ReadonlyMap<number, JobRowMatch> }): boolean {
  return items.length > 0 && [...matches.byJob.values()].some((match) => match.state === 'no_resume');
}

/**
 * The sort menu. v30 WEB-JOBS (11 §7.3, owner question 3): while the search has words, "Most relevant" says it ranks the
 * newest SEARCH_RELEVANCE_WINDOW matches (`relevanceWindow`); without words it lists the newest first.
 */
function SortMenu({ sort, onChange, relevanceWindow }: { sort: JobSort; onChange: (sort: JobSort) => void; relevanceWindow: number | null }) {
  return (
    <Menu>
      <MenuTrigger aria-label={`Sort jobs: ${JOB_SORT_LABEL[sort]}`} className={BAR_BUTTON}>
        <ArrowsDownUpIcon size={15} className="text-muted-foreground" />
        {JOB_SORT_LABEL[sort]}
        <CaretDownIcon size={14} />
      </MenuTrigger>
      <MenuContent align="end" width="w-56" aria-label="Sort jobs">
        <MenuRadioGroup value={sort} onValueChange={onChange}>
          {JOB_SORTS.map((value) => (
            <MenuRadioItem key={value} value={value} closeOnClick>
              {value === 'relevant' && relevanceWindow !== null ? (
                <span className="flex flex-col" data-relevance-hint="">
                  <span className="truncate">{JOB_SORT_LABEL[value]}</span>
                  <span className="text-xs leading-4 whitespace-normal text-muted-foreground">{relevanceHint(relevanceWindow)}</span>
                </span>
              ) : (
                JOB_SORT_LABEL[value]
              )}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/**
 * "Select" in the results bar: it starts choosing jobs to save. v32 FIX-UX (UXREQ-1): the bar is the list card's
 * header, so in a narrow list its word is kept for screen readers only (the icon and the tooltip show), as Save all's.
 */
function SelectButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content="Choose jobs to save">
      <button type="button" disabled={disabled} onClick={onClick} className={BAR_BUTTON} data-select-start="">
        <CheckSquareIcon size={15} aria-hidden="true" />
        <span className={BAR_WORD}>Select</span>
      </button>
    </Tooltip>
  );
}

/** The bar while jobs are being chosen: select all (the jobs not saved yet), the count, Save (N) and Done. */
function SelectionBar({ selection, shown }: { selection: JobSelection; shown: readonly JobListItem[] }) {
  const eligible = shown.filter((job) => saveBlockReason(job) === null);
  const count = eligible.filter((job) => selection.selected.has(job.id)).length;
  const all = eligible.length > 0 && count === eligible.length;
  return (
    <div role="toolbar" aria-label="Choose jobs to save" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2" data-selection-bar="">
      <Checkbox
        checked={all}
        indeterminate={!all && count > 0}
        disabled={eligible.length === 0 || selection.pending}
        aria-label="Select every job shown that is not saved yet"
        onCheckedChange={(on) => selection.onSelectAll(on)}
      />
      <span className="text-[13px] font-medium text-foreground" aria-live="polite">
        {count} selected
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="ghost" disabled={selection.pending} onClick={selection.onDone}>
          Done
        </Button>
        <Button size="sm" loading={selection.pending} disabled={count === 0} onClick={selection.onSave}>
          Save ({count})
        </Button>
      </div>
    </div>
  );
}

/**
 * v32 JOBS2 (E4): no resume to measure the list against: a small link in the results bar ("Add a resume", its "?" says
 * why), not a banner over the list.
 */
function AddResumeChip() {
  const { t } = usePublicConstants();
  return (
    <span className="inline-flex items-center gap-1" data-jobs-resume-hint="">
      <Link
        href="/resumes/new"
        className="inline-flex h-7 items-center gap-1 rounded-control border border-dashed border-border-strong px-2 text-[13px] font-medium text-primary hover:border-primary hover:bg-primary-50"
      >
        <PlusIcon size={12} weight="bold" aria-hidden="true" />
        Add a resume
      </Link>
      <HelpTip label="Add a resume">{t('MSG_JOBS_ADD_RESUME_HINT')}</HelpTip>
    </span>
  );
}

export interface ResultsBarProps {
  query: JobsQuery;
  list: JobsList;
  selection: JobSelection;
  /** No resume to measure the jobs against (the bar offers to add one). */
  needsResume: boolean;
  onQueryChange: (patch: Partial<JobsQuery>) => void;
}

/**
 * The results bar: the list card's header (v32 FIX-UX, UXREQ-1: inside the card, as v3.0's list had it), staying
 * under the top bar while the page scrolls: "Found N jobs", the resume hint when there is none to measure, then Select,
 * Save all and the sort; the selection's bar while jobs are chosen. The count never cuts (UX-4): the bar wraps instead.
 */
export function ResultsBar({ query, list, selection, needsResume: noResume, onQueryChange }: ResultsBarProps) {
  const constants = usePublicConstants();
  const items = useMemo(() => listedJobs(list), [list]);
  const total = list.data?.pages[0]?.total ?? 0;
  return (
    <div
      className="sticky top-topbar z-20 flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-t-card border-b border-border bg-surface/95 py-1 pr-2 pl-4 backdrop-blur-sm"
      data-results-bar=""
    >
      {selection.active ? (
        <SelectionBar selection={selection} shown={items} />
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-3">
            <p className="shrink-0 text-[13px] leading-5 font-semibold text-foreground" role="status" aria-live="polite" data-results-count="">
              {list.isPending ? 'Finding jobs...' : list.data ? foundJobsLabel(total, constants.get('JOB_SEARCH_COUNT_CAP')) : ''}
            </p>
            {noResume && <AddResumeChip />}
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-0.5">
            <SelectButton disabled={!list.data || items.length === 0} onClick={selection.onStart} />
            <SaveAllButton query={query} list={list} />
            <SortMenu
              sort={query.sort}
              onChange={(sort) => onQueryChange({ sort })}
              relevanceWindow={query.q?.trim() ? constants.get('SEARCH_RELEVANCE_WINDOW') : null}
            />
          </div>
        </>
      )}
    </div>
  );
}

function RowSkeleton() {
  return (
    <li className="flex gap-3 py-3.5 pr-4 pl-4" aria-hidden="true">
      <Skeleton className="size-9" rounded="control" />
      <div className="flex flex-1 flex-col gap-2.5 pt-0.5">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-1.5 w-16" />
        </div>
        <Skeleton className="h-3.5 w-4/5" />
      </div>
    </li>
  );
}

export interface JobListProps {
  query: JobsQuery;
  list: JobsList;
  /** The job shown in the detail. */
  selectedId: number | null;
  /** v31 FIX-JOBS: each listed job's keyword match by its id (absent: still loading). */
  matches: { byJob: ReadonlyMap<number, JobRowMatch>; settled: boolean };
  onSelect: (jobId: number, how: OpenHow) => void;
  /** The rows' quick Apply, while the list fills the page (see JobCard). */
  onApply?: (jobId: number) => void;
  onToggleSave: (job: JobListItem) => void;
  onClearAll: () => void;
  companyNames: ReadonlyMap<string, string>;
  selection: JobSelection;
  /** v32 FIX-UX: the card's header (the results bar). */
  header?: ReactNode;
  className?: string;
}

/**
 * v32 JOBS2 (E3): the list of jobs (the region "Job list"), a card of compact rows (beside the job's detail from
 * 1024 px, the page below), 21 at a time; the next page loads as the end of the list comes near (an
 * IntersectionObserver on the window with a 150% bottom margin: the list scrolls with the page, the detail beside it
 * stays put). "Load more" appears only after an error.
 */
export function JobList({
  query,
  list,
  selectedId,
  matches,
  onSelect,
  onApply,
  onToggleSave,
  onClearAll,
  companyNames,
  selection,
  header,
  className,
}: JobListProps) {
  const now = useNow();
  const { t } = usePublicConstants();
  const sentinel = useRef<HTMLDivElement>(null);
  const items = useMemo(() => listedJobs(list), [list]);
  const total = list.data?.pages[0]?.total ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = list;

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasNextPage || isFetchNextPageError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '0px 0px 150% 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, items.length]);

  const hrefOf = useMemo(() => jobHrefBuilder(query), [query]);
  const filtered = hasJobFilters(query);
  const fewResults = filtered && !hasNextPage && total > 0 && total < FEW_RESULTS && activeFilters(query, companyNames).length > 0;

  return (
    <section
      aria-label="Job list"
      className={clsx('@container/job-list min-w-0 rounded-card border border-border bg-surface shadow-card', className)}
      data-job-list=""
    >
      {header}
      {list.isPending ? (
        <ul aria-label="Loading jobs" className="divide-y divide-divider-soft">
          {Array.from({ length: 6 }, (_, index) => (
            <RowSkeleton key={index} />
          ))}
        </ul>
      ) : !list.data ? (
        // v32 FIX-UX (UXREQ-8, UXREQ-13): the list's load error as every page draws one: its reason in view, announced.
        <LoadError thing="Jobs" error={list.error} onRetry={() => void list.refetch()} className="m-3" />
      ) : items.length === 0 ? (
        <EmptyState
          variant="dashed"
          icon={<MagnifyingGlassIcon size={22} />}
          title={filtered ? t('MSG_JOBS_NONE_TITLE') : t('MSG_JOBS_NONE_YET_TITLE')}
          description={filtered ? t('MSG_JOBS_NONE_FILTERED') : t('MSG_JOBS_NONE_YET')}
          action={
            filtered ? (
              <Button variant="outline" onClick={onClearAll}>
                Clear all filters
              </Button>
            ) : undefined
          }
          className="m-3"
        />
      ) : (
        <>
          <ul aria-label="Jobs" className="divide-y divide-divider-soft overflow-hidden rounded-b-card">
            {items.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                href={hrefOf(job.id)}
                selected={job.id === selectedId}
                sort={query.sort}
                now={now}
                match={matches.byJob.get(job.id) ?? (matches.settled ? null : undefined)}
                onSelect={onSelect}
                onApply={onApply}
                onToggleSave={onToggleSave}
                selectable={selection.active}
                checked={selection.active && selection.selected.has(job.id)}
                onToggleChecked={selection.onToggle}
              />
            ))}
          </ul>
          <div ref={sentinel} aria-hidden="true" className="h-px" />
          {isFetchingNextPage && (
            <div className="flex justify-center border-t border-divider-soft py-4">
              <Spinner size={18} label="Loading more jobs..." />
            </div>
          )}
          {isFetchNextPageError && (
            <div className="flex flex-col items-center gap-2 border-t border-divider-soft px-4 py-4 text-center">
              <p className="text-sm text-muted-foreground">{userMessage(list.error, "More jobs didn't load.")}</p>
              <Button variant="outline" size="sm" onClick={() => void fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
          {fewResults && (
            // v31 FIX-JOBS: the filters in use are the search panel's chips (each removable there), not listed twice.
            <p className="border-t border-divider-soft px-4 py-3.5 text-[13px] leading-5 text-muted-foreground" data-few-results="">
              Only {total} {total === 1 ? 'job matches' : 'jobs match'}. Remove a filter above to see more.
            </p>
          )}
        </>
      )}
    </section>
  );
}
