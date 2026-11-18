'use client';

import type { JobsQuery } from '@tailorit/shared';
import { clsx } from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import { SearchPill } from '@/components/ui/SearchPill';
import { usePublicConstants } from '@/lib/constants';
import { activeFilters } from '../filters';
import { AiSearchInput, AiSearchStatus, SearchModeControl, useAiSearch } from './AiSearch';
import { AllFiltersDialog } from './AllFiltersDialog';
import { CanApplyPill } from './CanApplySwitch';
import { CategoryFilter } from './CategoryFilter';
import { ExperienceLevelFilter, JobTypeFilter } from './ChoiceFilters';
import { LocationFilter } from './LocationFilter';
import { SavedSearches } from './SavedSearches';

/** How long typing rests before the list searches. */
const SEARCH_DELAY_MS = 350;

/**
 * The search box (LABEL_JOBS_SEARCH): typing searches after a short pause, Enter at once. The box follows the address
 * when it changes elsewhere (Clear all, a saved search, back).
 */
function SearchBox({ q, onSearch, className }: { q: string; onSearch: (q: string) => void; className?: string }) {
  const { t } = usePublicConstants();
  const [text, setText] = useState(q);
  const sent = useRef(q);
  const search = useRef(onSearch);
  useEffect(() => {
    search.current = onSearch;
  }, [onSearch]);

  useEffect(() => {
    if (q !== sent.current) {
      sent.current = q;
      setText(q);
    }
  }, [q]);

  useEffect(() => {
    const value = text.trim();
    if (value === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = value;
      search.current(value);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <SearchPill
      value={text}
      onValueChange={setText}
      placeholder={t('LABEL_JOBS_SEARCH')}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        const value = text.trim();
        sent.current = value;
        onSearch(value);
      }}
      className={className}
    />
  );
}

export interface JobsToolbarProps {
  query: JobsQuery;
  onChange: (patch: Partial<JobsQuery>) => void;
  onReplace: (query: JobsQuery) => void;
  onClearAll: () => void;
  /** Labels the company filter's ids in the chips. */
  companyNames?: ReadonlyMap<string, string>;
  className?: string;
}

/**
 * v31 FIX-JOBS: the search panel, a white card above the feed. Its first line is the search (Classic | AI (v2.0), the
 * box, the saved searches); its second the filters (Location, Job Type, Experience Level, Category, "Jobs I can apply
 * to", All filters), wrapping on a narrow column; while anything filters the list, a third line names each filter as
 * a removable chip ("Filtering by: Full-Time ×  Senior ×") with Clear all. The search words stay in the box, not in
 * a chip. In AI mode (Paid) the box takes a sentence and the AI's filters go into the address; under the card, the
 * limit message, the AI's progress, or the summary of what it set.
 */
export function JobsToolbar({ query, onChange, onReplace, onClearAll, companyNames, className }: JobsToolbarProps) {
  const { t } = usePublicConstants();
  const ai = useAiSearch({ query, onReplace });
  const [editFilters, setEditFilters] = useState(0);
  const chips = useMemo(() => activeFilters(query, companyNames).filter((chip) => chip.key !== 'q'), [query, companyNames]);
  return (
    <div className={clsx('flex flex-col gap-3', className)}>
      <div
        className="@container/jobs-toolbar rounded-card border border-border bg-surface p-3 shadow-card sm:p-4"
        role="search"
        aria-label="Job search"
        data-jobs-toolbar=""
      >
        {/* A narrow panel puts the search box on its own line, under Classic | AI and the saved searches. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SearchModeControl state={ai} />
          <div className="order-last w-full min-w-0 @min-[36rem]/jobs-toolbar:order-none @min-[36rem]/jobs-toolbar:w-auto @min-[36rem]/jobs-toolbar:flex-1">
            {ai.mode === 'ai' ? (
              <AiSearchInput state={ai} className="w-full" />
            ) : (
              <SearchBox q={query.q ?? ''} onSearch={(q) => onChange({ q: q || undefined })} className="w-full" />
            )}
          </div>
          <div className="ml-auto flex @min-[36rem]/jobs-toolbar:ml-0">
            <SavedSearches query={query} onApply={onReplace} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2" data-jobs-filters="">
          <LocationFilter query={query} onChange={onChange} />
          <JobTypeFilter query={query} onChange={onChange} />
          <ExperienceLevelFilter query={query} onChange={onChange} />
          <CategoryFilter query={query} onChange={onChange} />
          {/* v30 FIX-WEB (INT-4 #8): "Jobs I can apply to" beside the other filters, pressed while on. */}
          <CanApplyPill on={Boolean(query.canApply)} onChange={(on) => onChange({ canApply: on || undefined })} />
          <AllFiltersDialog query={query} onApply={onReplace} requestOpen={editFilters} />
        </div>
        {chips.length > 0 && (
          <div
            className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-divider-soft pt-3"
            data-active-filters=""
          >
            <span id="jobs-filtering-by" className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
              {t('LABEL_JOBS_FILTERING_BY')}
            </span>
            <ul className="flex min-w-0 flex-wrap items-center gap-2" aria-labelledby="jobs-filtering-by">
              {chips.map((chip) => (
                <li key={chip.key} className="max-w-full" data-filter-chip={chip.key}>
                  <Chip tone="tint" size="sm" onRemove={() => onChange(chip.remove)} removeLabel={`Remove ${chip.label}`}>
                    {chip.label}
                  </Chip>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onClearAll}
              aria-label="Clear all filters"
              className="ml-auto inline-flex h-7 items-center rounded-control px-2 text-[13px] font-medium text-primary hover:bg-primary-50 hover:underline"
            >
              Clear all
            </button>
          </div>
        )}
      </div>
      <AiSearchStatus state={ai} onEditFilters={() => setEditFilters((count) => count + 1)} />
    </div>
  );
}
