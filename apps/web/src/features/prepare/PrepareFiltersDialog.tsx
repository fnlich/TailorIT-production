'use client';

import type { PrepareFiltersResponse } from '@tailorit/shared/filters';
import { useQuery } from '@tanstack/react-query';
// Relative, not '@/': the web tests draw this view.
import { Button } from '../../components/ui/Button';
import { Dialog, DialogContent } from '../../components/ui/Dialog';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { Spinner } from '../../components/ui/Spinner';
import { TapeMeter } from '../../components/ui/TapeMeter';
import { userMessage } from '../../lib/api';
import { fetchPrepareFilters, prepareSettingsKeys } from '../settings/prepare/api';
import { FILTERS_COPY } from '../settings/prepare/copy';
import { previewLine, REASON_SHORT } from '../settings/prepare/filters';
import {
  PrepareFiltersFields,
  previewStateOf,
  usePrepareFiltersForm,
  useSaveFilters,
  WHERE_YOU_LIVE_ANCHOR,
  type PrepareFiltersFormState,
} from '../settings/prepare/PrepareFiltersForm';
import { FILTERS_DIALOG, passCount } from './copy';

// v31 AUTO: the owner's "Filters Option in Auto Apply should be implement like dialog (not move to new page). And In
// dialog, there will be `Only Filter`, and `Filter and Prepare` buttons." The Prepare filters as a dialog over the page
// that needs them (the Auto-apply page's Filters button, "Change filters" in a filtered row's popover and in the result
// toast; the Tracker's toast too): the same form as Settings › Prepare & Queue (PrepareFiltersForm) without its save
// bar, a live count "38 of 52 saved jobs pass" (the preview, no AI), and the footer:
//   Cancel              closes; nothing is saved;
//   Only Filter         saves the filters (when changed) and closes; the Saved jobs' labels and the count follow;
//   Filter and Prepare  saves them, closes, then Prepare All for the saved jobs in To prepare that pass (its confirm).
// A field the person got wrong keeps the dialog open with the error on the field.

export interface PrepareFiltersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Filter and Prepare: the filters are saved (or unchanged) and the dialog closed; start Prepare All. */
  onFilterAndPrepare: () => void;
  /** Where focus goes when the dialog closes (the button that opened it). */
  finalFocus?: () => HTMLElement | boolean | null;
}

export function PrepareFiltersDialog({ open, onOpenChange, onFilterAndPrepare, finalFocus }: PrepareFiltersDialogProps) {
  const query = useQuery({
    queryKey: prepareSettingsKeys.filters,
    queryFn: ({ signal }) => fetchPrepareFilters(signal),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={FILTERS_DIALOG.title}
        help={`${FILTERS_COPY.description} ${FILTERS_COPY.note}`}
        size="xl"
        className="max-sm:p-4"
        finalFocus={finalFocus}
      >
        {query.data ? (
          // Each opening starts from what is stored (a save sets it, so the next form starts from the save).
          <FiltersDialogForm
            key={query.dataUpdatedAt}
            saved={query.data}
            onClose={() => onOpenChange(false)}
            onFilterAndPrepare={onFilterAndPrepare}
          />
        ) : query.isError ? (
          <Notice
            tone="error"
            className="mt-5"
            title={FILTERS_DIALOG.loadFailed}
            action={
              <Button variant="outline" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
                {FILTERS_DIALOG.tryAgain}
              </Button>
            }
          >
            {userMessage(query.error, 'Please try again in a moment.')}
          </Notice>
        ) : (
          <div className="mt-5 flex flex-col gap-4" aria-busy="true" aria-label={FILTERS_DIALOG.loading}>
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-10 w-full" rounded="control" />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's form, its footer and its live count (drawn by the tests on its own: a closed dialog draws nothing). */
export function FiltersDialogForm({
  saved,
  onClose,
  onFilterAndPrepare,
}: {
  saved: PrepareFiltersResponse;
  onClose: () => void;
  onFilterAndPrepare: () => void;
}) {
  const state = usePrepareFiltersForm(saved);
  const save = useSaveFilters({ onError: state.showServerErrors });

  /** Saves when the form changed something, then runs `then`; a wrong field keeps the dialog open. */
  const finish = (then: () => void) => {
    const filters = state.check();
    if (!filters) return;
    if (!state.dirty) {
      then();
      return;
    }
    // The save sets the stored filters, which starts a new form (its key): the promise, not a per-call callback,
    // carries `then` past that. A refused save is told by useSaveFilters (a toast, the fields' errors).
    save.mutateAsync(filters).then(then, () => undefined);
  };

  return (
    <>
      <div className="-mx-6 mt-4 min-h-0 flex-1 overflow-y-auto border-t border-divider-soft px-6 pt-3 max-sm:-mx-4 max-sm:px-4">
        <PrepareFiltersFields state={state} whereYouLiveHref={`/settings#${WHERE_YOU_LIVE_ANCHOR}`} />
      </div>
      <div
        className="-mx-6 -mb-6 flex flex-col gap-3 rounded-b-popup border-t border-border bg-surface-low px-6 py-4 max-sm:-mx-4 max-sm:-mb-4 max-sm:px-4 sm:flex-row sm:items-center"
        data-filters-dialog-footer=""
      >
        <PassCount state={state} />
        <div className="flex flex-wrap items-center justify-end gap-2.5 sm:ml-auto">
          <Button variant="outline" className="max-sm:h-11 max-sm:flex-1" disabled={save.isPending} onClick={onClose}>
            {FILTERS_DIALOG.cancel}
          </Button>
          <Button
            variant="outline"
            className="max-sm:h-11 max-sm:flex-1"
            disabled={save.isPending}
            onClick={() => finish(onClose)}
            data-only-filter=""
          >
            {FILTERS_DIALOG.onlyFilter}
          </Button>
          <Button
            className="max-sm:h-11 max-sm:flex-1"
            loading={save.isPending}
            onClick={() =>
              finish(() => {
                onClose();
                onFilterAndPrepare();
              })
            }
            data-filter-and-prepare=""
          >
            {FILTERS_DIALOG.filterAndPrepare}
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * The live count: a tape meter of the saved jobs that pass, "38 of 52 saved jobs pass", and the most common reasons
 * under it; read politely as it changes (its words, the same as Settings' preview, in one live region).
 */
function PassCount({ state }: { state: PrepareFiltersFormState }) {
  const preview = previewStateOf(state, (data) => previewLine(data));
  const data = state.result.ok ? state.preview.data : undefined;
  const reasons = data
    ? Object.entries(data.byReason)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 3)
        .map(([code, n]) => `${n} ${REASON_SHORT[code as keyof typeof REASON_SHORT]}`)
    : [];
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-80 sm:flex-1" data-filters-count={data ? data.pass : undefined}>
      {data && data.total > 0 ? (
        <TapeMeter
          label={FILTERS_DIALOG.countLabel}
          value={data.pass}
          max={data.total}
          valueText={passCount(data)}
          tone="primary"
          size="sm"
          layout="inline"
        />
      ) : null}
      <p aria-live="polite" className="flex items-center gap-1.5 text-[13px] leading-5 text-muted-foreground" data-filters-preview={preview.kind}>
        {(preview.kind === 'checking' || (preview.kind === 'ready' && preview.checking)) && <Spinner size={12} className="shrink-0" />}
        {/* The count is drawn by the meter (aria-hidden there); the live region says it first. */}
        {preview.kind === 'ready' && data && data.total > 0 && <span className="sr-only">{passCount(data)}. </span>}
        <span>
          {preview.kind === 'ready' && data
            ? data.total === 0
              ? preview.text
              : reasons.length > 0
                ? `Filtered out: ${reasons.join(', ')}`
                : 'No saved job is filtered out.'
            : preview.kind === 'checking'
              ? FILTERS_COPY.previewChecking
              : preview.kind === 'error'
                ? FILTERS_COPY.previewFailed
                : FILTERS_COPY.previewFix}
        </span>
      </p>
    </div>
  );
}
