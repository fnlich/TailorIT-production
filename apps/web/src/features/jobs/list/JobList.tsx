'use client';

import { CheckSquareIcon } from '@phosphor-icons/react/CheckSquare';
import { JOB_SORTS, JOB_SORT_LABEL, hasJobFilters, type JobRowMatch, type JobSort, type JobsQuery } from '@tailorit/shared';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { ArrowsDownUpIcon, CaretDownIcon, MagnifyingGlassIcon } from '@/components/ui/icons';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/Menu';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useNow } from '@/lib/useNow';
import type { JobListItem } from '../api';
import { activeFilters } from '../filters';
import { foundJobsLabel, relevanceHint } from '../format';
import type { useJobsList } from '../hooks';
import { jobHrefBuilder } from '../url';
import { FEED_COLUMNS, JobCard } from './JobCard';
import { SaveAllButton } from './SaveAllButton';
import { BAR_BUTTON } from './styles';
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

export interface JobListProps {
  query: JobsQuery;
  list: ReturnType<typeof useJobsList>;
  /** The job open in the drawer. */
  selectedId: number | null;
  /** v31 FIX-JOBS: each listed job's keyword match by its id (absent: still loading). */
  matches: { byJob: ReadonlyMap<number, JobRowMatch>; settled: boolean };
  onSelect: (jobId: number) => void;
  onApply: (jobId: number) => void;
  onToggleSave: (job: JobListItem) => void;
  onQueryChange: (patch: Partial<JobsQuery>) => void;
  onClearAll: () => void;
  companyNames: ReadonlyMap<string, string>;
  selection: JobSelection;
}

/** Few enough results that the list suggests removing a filter. */
const FEW_RESULTS = 10;

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

/** "Select" in the results bar: it starts choosing jobs to save. Its word shows at every width (UX-4). */
function SelectButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content="Choose jobs to save to Saved Jobs">
      <button type="button" disabled={disabled} onClick={onClick} className={BAR_BUTTON} data-select-start="">
        <CheckSquareIcon size={15} />
        Select
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

function RowSkeleton() {
  return (
    <li className="flex gap-4 px-5 py-4" aria-hidden="true">
      <Skeleton className="size-11" rounded="control" />
      <div className="flex flex-1 flex-col gap-2 pt-0.5">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="mt-1 h-5 w-24" rounded="control" />
      </div>
      <Skeleton className="mt-1 h-2 w-40 max-sm:hidden" />
    </li>
  );
}

/**
 * v31 FIX-JOBS: the results, one full-width feed under the toolbar (no list-and-detail split): a bar that stays under
 * the top bar while the page scrolls ("Found N jobs", Select, Save all and the sort; the selection's bar while jobs are
 * chosen), a hint to add a resume when there is none to measure, then the rows, 21 at a time; the next page loads as
 * the end of the feed comes near (an IntersectionObserver on the window with a 150% bottom margin). "Load more"
 * appears only after an error. The count never cuts (UX-4): the bar wraps on a phone instead.
 */
export function JobList({
  query,
  list,
  selectedId,
  matches,
  onSelect,
  onApply,
  onToggleSave,
  onQueryChange,
  onClearAll,
  companyNames,
  selection,
}: JobListProps) {
  const now = useNow();
  // v30 WEB-JOBS: "Found 10,000+ jobs" past JOB_SEARCH_COUNT_CAP; "Most relevant" within SEARCH_RELEVANCE_WINDOW.
  const constants = usePublicConstants();
  const { t } = constants;
  const countCap = constants.get('JOB_SEARCH_COUNT_CAP');
  const sentinel = useRef<HTMLDivElement>(null);
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
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
  // No resume to measure against: the first measured row says so (every row answers the same).
  const noResume = items.length > 0 && [...matches.byJob.values()].some((match) => match.state === 'no_resume');

  return (
    <section aria-label="Job list" className="mt-5" data-jobs-feed="">
      <div
        className="sticky top-topbar z-20 -mx-1 flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-canvas/95 px-1 py-1.5 backdrop-blur-sm"
        data-results-bar=""
      >
        {selection.active ? (
          <SelectionBar selection={selection} shown={items} />
        ) : (
          <>
            <p
              className="text-[13px] leading-5 font-semibold text-foreground"
              role="status"
              aria-live="polite"
              data-results-count=""
            >
              {list.isPending ? 'Finding jobs...' : list.data ? foundJobsLabel(total, countCap) : ''}
            </p>
            <div className="-mr-2 flex flex-wrap items-center justify-end gap-x-0.5">
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

      {noResume && (
        <Notice
          tone="info"
          className="mt-2"
          action={
            <Link href="/resumes/new" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
              Create a resume
            </Link>
          }
        >
          <span data-jobs-resume-hint="">{t('MSG_JOBS_ADD_RESUME_HINT')}</span>
        </Notice>
      )}

      <div className="@container/feed mt-2 rounded-card border border-border bg-surface shadow-card">
        {/* The wide feed's column heads (the rows' cells say what they are to assistive technology). */}
        {items.length > 0 && (
          <div
            aria-hidden="true"
            className={clsx(
              'hidden h-10 items-center gap-x-4 rounded-t-card border-b border-border bg-surface-low px-5 @min-[56rem]/feed:grid',
              FEED_COLUMNS,
              'text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase',
            )}
            data-feed-heads=""
          >
            <span className={selection.active ? 'pl-[94px]' : 'pl-[60px]'}>{t('LABEL_JOBS_HEAD_JOB')}</span>
            <span>{t('LABEL_JOBS_HEAD_WHERE')}</span>
            <span>{t('LABEL_JOB_YOUR_MATCH')}</span>
            <span />
          </div>
        )}
        {list.isPending ? (
          <ul aria-label="Loading jobs" className="divide-y divide-divider-soft">
            {Array.from({ length: 6 }, (_, index) => (
              <RowSkeleton key={index} />
            ))}
          </ul>
        ) : !list.data ? (
          <div className="p-5">
            <Notice
              tone="error"
              title="The jobs could not be loaded"
              action={
                <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                  Try again
                </Button>
              }
            >
              {userMessage(list.error)}
            </Notice>
          </div>
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
            <ul
              aria-label="Jobs"
              className="divide-y divide-divider-soft [&>li:last-child]:rounded-b-card [&>li:first-child]:rounded-t-card @min-[56rem]/feed:[&>li:first-child]:rounded-t-none"
            >
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
                <p className="text-sm text-muted-foreground">{userMessage(list.error, 'More jobs could not be loaded.')}</p>
                <Button variant="outline" size="sm" onClick={() => void fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
            {fewResults && (
              // v31 FIX-JOBS: the filters in use are the search panel's chips (each removable there), not listed twice.
              <p className="border-t border-divider-soft px-5 py-4 text-sm text-muted-foreground" data-few-results="">
                Only {total} {total === 1 ? 'job matches' : 'jobs match'} your filters. Remove one of the filters above to see more
                results.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
