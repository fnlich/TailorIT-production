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
 * v31 FIX-JOBS: the search panel, a white card above the feed: the search (Keywords | Ask AI (v2.0), the box, the
 * saved searches) and the filters (Location, Job Type, Experience Level, Category, "Jobs I can apply to", All
 * filters); while anything filters the list, a last line names each filter as a removable chip ("Filtering by:
 * Full-Time ×  Senior ×") with Clear all. The search words stay in the box, not in a chip. In AI mode (Paid) the box
 * takes a sentence and the AI's filters go into the address; under the card, the AI's progress, a sentence it could
 * not use, or the summary of what it set (v32 JOBS2: limits are dialogs, see AiSearch).
 *
 * v32 FIX-UX (UXREQ-1: the first jobs in view, as v3.0's one search line had them), by the card's width:
 *   - from 74 rem (a 1280 px window): the search and the filters on one line (they wrap only when a filter's value
 *     makes them too long);
 *   - from 36 rem: the search on the first line, the filters on the second (v3.1's panel);
 *   - a phone: Keywords | Ask AI with All filters (counting every filter on) and the saved searches, then the box; the
 *     filters are All filters' (it holds every one), so the first job shows in the first screen.
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
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-3" data-jobs-search-line="">
          <SearchModeControl state={ai} />
          {/* A phone puts the box on its own line, under Keywords | Ask AI, All filters and the saved searches. */}
          <div className="order-last w-full min-w-0 @min-[36rem]/jobs-toolbar:order-none @min-[36rem]/jobs-toolbar:w-auto @min-[36rem]/jobs-toolbar:min-w-56 @min-[36rem]/jobs-toolbar:flex-1">
            {ai.mode === 'ai' ? (
              <AiSearchInput state={ai} className="w-full" />
            ) : (
              <SearchBox q={query.q ?? ''} onSearch={(q) => onChange({ q: q || undefined })} className="w-full" />
            )}
          </div>
          <div className="ml-auto flex @min-[36rem]/jobs-toolbar:ml-0">
            <SavedSearches query={query} onApply={onReplace} />
          </div>
          {/* The filters' own line on a mid-width panel (a break), the search's line from 74 rem. */}
          <span aria-hidden="true" className="hidden h-0 basis-full @min-[36rem]/jobs-toolbar:block @min-[74rem]/jobs-toolbar:hidden" />
          <div className="contents" data-jobs-filters="">
            <span className="contents @max-[36rem]/jobs-toolbar:hidden">
              <LocationFilter query={query} onChange={onChange} />
              <JobTypeFilter query={query} onChange={onChange} />
              <ExperienceLevelFilter query={query} onChange={onChange} />
              <CategoryFilter query={query} onChange={onChange} />
              {/* v30 FIX-WEB (INT-4 #8): "Jobs I can apply to" beside the other filters, pressed while on. */}
              <CanApplyPill on={Boolean(query.canApply)} onChange={(on) => onChange({ canApply: on || undefined })} />
            </span>
            <span className="flex @max-[36rem]/jobs-toolbar:order-2">
              <AllFiltersDialog query={query} onApply={onReplace} requestOpen={editFilters} />
            </span>
          </div>
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
