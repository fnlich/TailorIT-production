'use client';

import type { PrepareFiltersResponse } from '@tailorit/shared/filters';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../../components/ui/Button';
import { HelpTip } from '../../../components/ui/HelpTip';
import { FunnelIcon } from '../../../components/ui/icons';
import { Notice } from '../../../components/ui/Notice';
import { Skeleton } from '../../../components/ui/Skeleton';
import { userMessage } from '../../../lib/api';
import { fetchPrepareFilters, prepareSettingsKeys } from './api';
import { NotShared, refusedRead } from '../../sharing/access'; // v33 SHARE-7
import { FILTERS_COPY } from './copy';
import { activeFilterCount } from './filters';
import { ReadOnlyLine, untickedWords, useFiltersScope } from './FiltersScope'; // v34 FANWEB
import { useFanoutReport, type ReportShow } from '../../sharing/fanout/useFanout';
import { FANOUT_COPY } from '../../sharing/fanout/copy';
import { usePublicConstants, type PublicMessageKey } from '../../../lib/constants';
import {
  PrepareFiltersFields,
  type FiltersAccess,
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

/**
 * v33 SHARE-7: `access` on a shared profile (PrepareSection computes it): read-only without the Job settings Change box
 * (shown, never saved), the eligibility switches by the Sensitive answers boxes. `shared: false` (no Prepare & queue See
 * box): "Not shared with you." and nothing is asked for.
 */
export function PrepareFilters({
  access = {},
  shared = true,
  owner = null,
}: {
  access?: FiltersAccess;
  shared?: boolean;
  owner?: string | null;
}) {
  const query = useQuery({
    queryKey: prepareSettingsKeys.filters,
    queryFn: ({ signal }) => fetchPrepareFilters(signal),
    enabled: shared, // v33 SHARE-7
  });
  // v34 FANWEB: a save on several profiles is said here (the form starts again after a save).
  const report = useFanoutReport();
  // v2.0 fix (UX-13): a save starts the form again (its key) and the save bar leaves; focus fell to <body> with it. The
  // new form puts it on the "Prepare filters" heading instead (unless the person already moved it).
  const focusHeading = useRef(false);
  return (
    <div className="flex flex-col gap-5 border-t border-divider-soft pt-6" data-prepare-filters="">
      {!shared ? (
        // v33 SHARE-7: not shared with the person (checked first: a copy read earlier stays in the cache).
        <>
          <FiltersHeading count={null} />
          <NotShared owner={owner} />
        </>
      ) : query.data ? (
        // A save (or another tab's change read on focus) starts the form again from what is stored.
        <FiltersForm
          key={query.dataUpdatedAt}
          access={access}
          owner={owner}
          report={report}
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
      ) : query.isError && refusedRead(query.error) ? (
        // v33 SHARE-7: refused because of the shared profile.
        <>
          <FiltersHeading count={null} />
          <NotShared owner={owner} />
        </>
      ) : query.isError ? (
        <>
          <FiltersHeading count={null} />
          <Notice
            tone="error"
            title="Your filters didn't load"
            action={
              <Button variant="outline" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          >
            {userMessage(query.error, 'Try again in a moment.')}
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
      {report.element}
    </div>
  );
}

function FiltersHeading({
  count,
  headingRef,
  applyTo,
}: {
  count: number | null;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** v34 FANWEB: "Apply to: …" at the heading's end (with a shared profile). */
  applyTo?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <h3
          ref={headingRef}
          tabIndex={-1}
          data-filters-heading=""
          className="flex items-center gap-2 text-[15px] leading-5 font-semibold text-foreground outline-none"
        >
          <FunnelIcon size={16} aria-hidden="true" className="text-muted-foreground" />
          {FILTERS_COPY.title}
        </h3>
        {/* v32 COPY (E5): what the filters do is the "?" beside the heading. */}
        <HelpTip label={FILTERS_COPY.title}>
          {FILTERS_COPY.description} {FILTERS_COPY.note}
        </HelpTip>
        {count !== null && (
          <span className="ml-1.5 text-[13px] leading-5 text-muted-foreground" data-filters-on={count}>
            {FILTERS_COPY.onCount(count)}
          </span>
        )}
      </div>
      {applyTo}
    </div>
  );
}

function FiltersForm({
  saved,
  onSaved,
  takeFocus,
  access = {},
  owner = null,
  report,
}: {
  saved: PrepareFiltersResponse;
  /** v33 SHARE-7: read-only: shown, never saved (its fields are off, no save bar); the eligibility switches' state. */
  access?: FiltersAccess;
  /** v34 FANWEB: whose filters (a shared profile's owner), for the read-only line. */
  owner?: string | null;
  /** v34 FANWEB: where a save on several profiles is said (outlives this form). */
  report?: ReportShow;
  /** The filters were saved: the next form takes focus. */
  onSaved: () => void;
  /** Whether this form takes focus when it mounts (once, after a save). */
  takeFocus: () => boolean;
}) {
  const state = usePrepareFiltersForm(saved);
  const save = useSaveFilters({ onSaved, onError: state.showServerErrors, report });
  // v34 FANWEB: Apply to this profile, several or all (only the changed or marked filters go).
  const scope = useFiltersScope(state, { readOnly: access.readOnly });
  const { t } = usePublicConstants();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!takeFocus()) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) headingRef.current?.focus();
    // On mount only: the form after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    const input = scope.input();
    if (input) save.mutate(input);
  };

  return (
    <>
      <FiltersHeading count={state.result.ok ? activeFilterCount(state.result.filters) : null} headingRef={headingRef} applyTo={scope.control} />
      {/* v34 FANWEB: a shared profile without Job settings' Change says so (the fields below are shown, not changed). */}
      {access.readOnly && <ReadOnlyLine owner={owner} label={(key) => t(key as PublicMessageKey)} />}
      {/* v33 SHARE-7: a disabled fieldset disables every field of a read-only form. */}
      <fieldset disabled={access.readOnly} className="m-0 min-w-0 border-0 p-0" data-filters-read-only={access.readOnly ? '' : undefined}>
        <PrepareFiltersFields state={state} access={access} marks={scope.marks} />
      </fieldset>
      <PreviewLine state={previewStateOf(state)} />
      {scope.dirty && !access.readOnly && (
        <SaveBar
          saving={save.isPending}
          onDiscard={state.reset}
          onSave={submit}
          // v34 FANWEB fix (spec L6): a change whose mark is unticked keeps the bar, and is named (it is not sent).
          canSave={!scope.several || state.applying.length > 0 || !state.result.ok}
          text={scope.several ? (state.applying.length > 0 ? FANOUT_COPY.marksCount(state.applying.length) : FANOUT_COPY.marksNone) : FILTERS_COPY.unsaved}
          note={scope.unticked.length > 0 ? FANOUT_COPY.notTicked(untickedWords(scope.unticked)) : null}
        />
      )}
      {save.element}
    </>
  );
}

function SaveBar({
  saving,
  onDiscard,
  onSave,
  text,
  canSave = true,
  note = null,
}: {
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
  text: string;
  canSave?: boolean;
  note?: string | null;
}) {
  return (
    <div
      data-filters-save-bar=""
      className="sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-wrap items-center justify-between gap-3 rounded-b-card border-t border-border bg-surface/95 px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm"
    >
      <p className="text-sm leading-5 font-medium text-foreground" aria-live="polite">
        {text}
        {note && (
          <span className="block text-[13px] font-normal text-muted-foreground" data-filters-unticked="">
            {note}
          </span>
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={saving} onClick={onDiscard}>
          {FILTERS_COPY.discard}
        </Button>
        <Button size="sm" loading={saving} disabled={!canSave} onClick={onSave}>
          {saving ? FILTERS_COPY.saving : FILTERS_COPY.save}
        </Button>
      </div>
    </div>
  );
}
