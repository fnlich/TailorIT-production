'use client';

import type { PrepareFiltersResponse } from '@tailorit/shared/filters';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type RefObject } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../../components/ui/Button';
import { FunnelIcon } from '../../../components/ui/icons';
import { Notice } from '../../../components/ui/Notice';
import { Skeleton } from '../../../components/ui/Skeleton';
import { userMessage } from '../../../lib/api';
import { fetchPrepareFilters, prepareSettingsKeys } from './api';
import { FILTERS_COPY } from './copy';
import { activeFilterCount } from './filters';
import {
  PrepareFiltersFields,
  PreviewLine,
  previewStateOf,
  usePrepareFiltersForm,
  useSaveFilters,
} from './PrepareFiltersForm';

// v2.0: Settings › Prepare & Queue › Prepare filters (docs/design/v2.0/08-ui.md; 06-filters-analysis.md): the shared
// filters form (PrepareFiltersForm, v31 AUTO: the Auto-apply page's filters dialog draws the same one) under a heading
// with the count of filters on, its live preview, and a save bar that sticks to the bottom of the window while the
// form holds a change.

export { PREVIEW_DELAY_MS, PreviewLine, WHERE_YOU_LIVE_ANCHOR } from './PrepareFiltersForm';

export function PrepareFilters() {
  const query = useQuery({ queryKey: prepareSettingsKeys.filters, queryFn: ({ signal }) => fetchPrepareFilters(signal) });
  // v2.0 fix (UX-13): a save starts the form again (its key) and the save bar leaves; focus fell to <body> with it. The
  // new form puts it on the "Prepare filters" heading instead (unless the person already moved it).
  const focusHeading = useRef(false);
  return (
    <div className="flex flex-col gap-5 border-t border-divider-soft pt-6" data-prepare-filters="">
      {query.data ? (
        // A save (or another tab's change read on focus) starts the form again from what is stored.
        <FiltersForm
          key={query.dataUpdatedAt}
          saved={query.data}
          onSaved={() => {
            focusHeading.current = true;
          }}
          takeFocus={() => {
            const take = focusHeading.current;
            focusHeading.current = false;
            return take;
          }}
        />
      ) : query.isError ? (
        <>
          <FiltersHeading count={null} />
          <Notice
            tone="error"
            title="Your filters could not be loaded"
            action={
              <Button variant="outline" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          >
            {userMessage(query.error, 'Please try again in a moment.')}
          </Notice>
        </>
      ) : (
        <>
          <FiltersHeading count={null} />
          <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your filters">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-10 w-full" rounded="control" />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FiltersHeading({ count, headingRef }: { count: number | null; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3
          ref={headingRef}
          tabIndex={-1}
          data-filters-heading=""
          className="flex items-center gap-2 text-[15px] leading-5 font-semibold text-foreground outline-none"
        >
          <FunnelIcon size={16} aria-hidden="true" className="text-muted-foreground" />
          {FILTERS_COPY.title}
        </h3>
        {count !== null && (
          <span className="text-[13px] leading-5 text-muted-foreground" data-filters-on={count}>
            {FILTERS_COPY.onCount(count)}
          </span>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
        {FILTERS_COPY.description} <strong className="font-semibold text-foreground">{FILTERS_COPY.note}</strong>
      </p>
    </div>
  );
}

function FiltersForm({
  saved,
  onSaved,
  takeFocus,
}: {
  saved: PrepareFiltersResponse;
  /** The filters were saved: the next form takes focus. */
  onSaved: () => void;
  /** Whether this form takes focus when it mounts (once, after a save). */
  takeFocus: () => boolean;
}) {
  const state = usePrepareFiltersForm(saved);
  const save = useSaveFilters({ onSaved, onError: state.showServerErrors });
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!takeFocus()) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) headingRef.current?.focus();
    // On mount only: the form after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    const filters = state.check();
    if (filters) save.mutate(filters);
  };

  return (
    <>
      <FiltersHeading count={state.result.ok ? activeFilterCount(state.result.filters) : null} headingRef={headingRef} />
      <PrepareFiltersFields state={state} />
      <PreviewLine state={previewStateOf(state)} />
      {state.dirty && <SaveBar saving={save.isPending} onDiscard={state.reset} onSave={submit} />}
    </>
  );
}

function SaveBar({ saving, onDiscard, onSave }: { saving: boolean; onDiscard: () => void; onSave: () => void }) {
  return (
    <div
      data-filters-save-bar=""
      className="sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-wrap items-center justify-between gap-3 rounded-b-card border-t border-border bg-surface/95 px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm"
    >
      <p className="text-sm leading-5 font-medium text-foreground">{FILTERS_COPY.unsaved}</p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={saving} onClick={onDiscard}>
          {FILTERS_COPY.discard}
        </Button>
        <Button size="sm" loading={saving} onClick={onSave}>
          {saving ? FILTERS_COPY.saving : FILTERS_COPY.save}
        </Button>
      </div>
    </div>
  );
}
