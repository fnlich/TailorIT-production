'use client';

import { CheckSquareIcon } from '@phosphor-icons/react/CheckSquare';
import { JOB_SORTS, JOB_SORT_LABEL, hasJobFilters, type JobSort, type JobsQuery } from '@tailorit/shared';
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { CaretDownIcon, MagnifyingGlassIcon } from '@/components/ui/icons';
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
import { CAN_APPLY_COPY, foundJobsLabel, relevanceHint } from '../format';
import type { useJobsList } from '../hooks';
import { jobHrefBuilder } from '../url';
import { JobCard } from './JobCard';
import { SaveAllButton } from './SaveAllButton';
import { saveBlockReason } from './useSaveSelected';

/** v2.0 (A4): choosing jobs to save to Saved Jobs (Prepare & Queue then queues them, on the Auto-apply page). */
export interface JobSelection {
  /** The cards show their boxes, and the header becomes the selection's bar. */
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
  selectedId: number | null;
  /** The panel that scrolls (the infinite-scroll sentinel watches it). */
  scrollRef: RefObject<HTMLDivElement | null>;
  onSelect: (jobId: number) => void;
  onToggleSave: (job: JobListItem) => void;
  onQueryChange: (patch: Partial<JobsQuery>) => void;
  onClearAll: () => void;
  companyNames: ReadonlyMap<string, string>;
  selection: JobSelection;
}

/** Few enough results that Simplify suggests removing a filter. */
const FEW_RESULTS = 10;

/**
 * The sort menu. v30 WEB-JOBS (11 §7.3, owner question 3): while the search has words, "Most relevant" says it ranks the
 * newest SEARCH_RELEVANCE_WINDOW matches (`relevanceWindow`); without words it lists the newest first.
 */
function SortMenu({ sort, onChange, relevanceWindow }: { sort: JobSort; onChange: (sort: JobSort) => void; relevanceWindow: number | null }) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Sort jobs: ${JOB_SORT_LABEL[sort]}`}
        className="-mr-2 inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-black hover:bg-hover data-popup-open:bg-hover"
      >
        {JOB_SORT_LABEL[sort]}
        <CaretDownIcon size={14} />
      </MenuTrigger>
      <MenuContent align="end" width="w-48" aria-label="Sort jobs">
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

/** "Select" in the list header, styled like Save all beside it: it starts choosing jobs to save. */
function SelectButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content="Choose jobs to save to Saved Jobs">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-black hover:bg-hover disabled:pointer-events-none disabled:opacity-50"
      >
        <CheckSquareIcon size={14} />
        <span className="lg:max-xl:sr-only">Select</span>
      </button>
    </Tooltip>
  );
}

/** The header while jobs are being chosen: select all (the jobs not saved yet), the count, Save (N) and Done. */
function SelectionBar({ selection, shown }: { selection: JobSelection; shown: readonly JobListItem[] }) {
  const eligible = shown.filter((job) => saveBlockReason(job) === null);
  const count = eligible.filter((job) => selection.selected.has(job.id)).length;
  const all = eligible.length > 0 && count === eligible.length;
  return (
    <div role="toolbar" aria-label="Choose jobs to save" className="flex min-w-0 flex-1 items-center gap-2.5">
      <Checkbox
        checked={all}
        indeterminate={!all && count > 0}
        disabled={eligible.length === 0 || selection.pending}
        aria-label="Select every job shown that is not saved yet"
        onCheckedChange={(on) => selection.onSelectAll(on)}
      />
      <span className="min-w-0 truncate text-xs font-medium text-foreground" aria-live="polite">
        {count} selected
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button size="sm" loading={selection.pending} disabled={count === 0} onClick={selection.onSave}>
          Save ({count})
        </Button>
        <Button size="sm" variant="ghost" disabled={selection.pending} onClick={selection.onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <li className="flex gap-3 px-4 py-4" aria-hidden="true">
      <Skeleton className="size-10" rounded="control" />
      <div className="flex flex-1 flex-col gap-2 pt-0.5">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    </li>
  );
}

/**
 * The left panel: "Found N jobs", Save all and the sort, then the cards, 21 at a time; the next page loads as the end
 * of the list comes near (IntersectionObserver with Simplify's 150% bottom margin). "Load more" appears only after an
 * error.
 */
export function JobList({
  query,
  list,
  selectedId,
  scrollRef,
  onSelect,
  onToggleSave,
  onQueryChange,
  onClearAll,
  companyNames,
  selection,
}: JobListProps) {
  const now = useNow();
  // v30 WEB-JOBS: "Found 10,000+ jobs" past JOB_SEARCH_COUNT_CAP; "Most relevant" within SEARCH_RELEVANCE_WINDOW.
  const constants = usePublicConstants();
  const countCap = constants.get('JOB_SEARCH_COUNT_CAP');
  const sentinel = useRef<HTMLDivElement>(null);
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = list;

  useEffect(() => {
    const target = sentinel.current;
    const root = scrollRef.current;
    if (!target || !root || !hasNextPage || isFetchNextPageError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { root, rootMargin: '0px 0px 150% 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollRef, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, items.length]);

  const hrefOf = useMemo(() => jobHrefBuilder(query), [query]);
  const filtered = hasJobFilters(query);
  const chips = filtered && !hasNextPage && total > 0 && total < FEW_RESULTS ? activeFilters(query, companyNames) : [];

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-2 bg-surface pr-4 pl-4">
        {selection.active ? (
          <SelectionBar selection={selection} shown={items} />
        ) : (
          <>
            <p className="min-w-0 truncate text-xs text-muted-foreground" role="status" aria-live="polite">
              {list.isPending ? 'Finding jobs...' : list.data ? foundJobsLabel(total, countCap) : ''}
            </p>
            <div className="flex shrink-0 items-center gap-1">
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

      {/* v30 FIX-WEB (INT-4 #8, REV-UX): "Jobs I can apply to" shows its chip whenever it is on (the few-results list below
          names it with the others), so a list it narrowed always says why. */}
      {query.canApply && chips.length === 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2" data-can-apply-chip="">
          <Chip tone="neutral" size="sm" onRemove={() => onQueryChange({ canApply: undefined })} removeLabel={`Remove ${CAN_APPLY_COPY.chip}`}>
            {CAN_APPLY_COPY.chip}
          </Chip>
        </div>
      )}
      {list.isPending ? (
        <ul aria-label="Loading jobs">
          {Array.from({ length: 5 }, (_, index) => (
            <CardSkeleton key={index} />
          ))}
        </ul>
      ) : !list.data ? (
        <div className="p-4">
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
          icon={<MagnifyingGlassIcon size={22} />}
          title="No matching jobs found"
          description={
            filtered ? 'Try a different search, or remove a filter to see more jobs.' : 'New postings will appear here as job boards are added.'
          }
          action={
            filtered ? (
              <Button variant="outline" onClick={onClearAll}>
                Clear all filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul aria-label="Jobs">
            {items.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                href={hrefOf(job.id)}
                selected={job.id === selectedId}
                sort={query.sort}
                now={now}
                onSelect={onSelect}
                onToggleSave={onToggleSave}
                selectable={selection.active}
                checked={selection.active && selection.selected.has(job.id)}
                onToggleChecked={selection.onToggle}
              />
            ))}
          </ul>
          <div ref={sentinel} aria-hidden="true" className="h-px" />
          {isFetchingNextPage && (
            <div className="flex justify-center py-4">
              <Spinner size={18} label="Loading more jobs..." />
            </div>
          )}
          {isFetchNextPageError && (
            <div className="flex flex-col items-center gap-2 px-4 py-4 text-center">
              <p className="text-sm text-muted-foreground">{userMessage(list.error, 'More jobs could not be loaded.')}</p>
              <Button variant="outline" size="sm" onClick={() => void fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
          {chips.length > 0 && (
            <div className="mt-2 border-t border-border px-4 py-5">
              <p className="text-sm text-muted-foreground">
                Only {total} {total === 1 ? 'job matches' : 'jobs match'} your filters. Remove one of these filters to see more
                results.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {chips.map((chip) => (
                  <Chip key={chip.key} tone="neutral" size="sm" onRemove={() => onQueryChange(chip.remove)} removeLabel={`Remove ${chip.label}`}>
                    {chip.label}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
