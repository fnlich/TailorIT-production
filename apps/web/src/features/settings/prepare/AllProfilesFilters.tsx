'use client';

import type { PrepareFiltersResponse } from '@tailorit/shared/filters';
import { PROFILE_SELF } from '@tailorit/shared/sharing';
import { useQuery } from '@tanstack/react-query';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../../components/ui/Button';
import { Dialog, DialogContent } from '../../../components/ui/Dialog';
import { LoadError } from '../../../components/ui/LoadError';
import { Skeleton } from '../../../components/ui/Skeleton';
import { FANOUT_COPY } from '../../sharing/fanout/copy';
import { fetchOwnPrepareFilters, prepareSettingsKeys } from './api';
import { untickedWords, useFiltersScope } from './FiltersScope';
import { PrepareFiltersFields, usePrepareFiltersForm, useSaveFilters } from './PrepareFiltersForm';
import type { ReportShow } from '../../sharing/fanout/useFanout';

// v34 FANWEB (PLAN G3: the Profiles page's "Change filters for all profiles"): the Prepare filters form over every
// profile at once. It starts from the person's OWN filters (read without a profile: GET /api/prepare/filters as
// themselves, whatever profile the tab works on), each filter with its "Apply" mark (a changed one is ticked; tick an
// unchanged one to set every profile to it), Apply to All profiles or the ones chosen, and one request
// (PATCH /api/profiles/prepare/filters) for the marked filters. Where you live stays each person's own; an eligibility
// switch is changed only where the person has that profile's Sensitive answers › Change, else kept and said.

export function AllProfilesFiltersDialog({
  open,
  onOpenChange,
  finalFocus,
  report,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus?: () => HTMLElement | boolean | null;
  /** Where the result is said (the page's: it outlives the dialog). */
  report: ReportShow;
}) {
  const query = useQuery({
    queryKey: prepareSettingsKeys.ownFilters,
    queryFn: ({ signal }) => fetchOwnPrepareFilters(signal),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={FANOUT_COPY.filtersAllTitle} help={FANOUT_COPY.filtersAllHelp} size="xl" className="max-sm:p-4" finalFocus={finalFocus}>
        {query.data ? (
          <AllProfilesFiltersForm key={query.dataUpdatedAt} saved={query.data} onClose={() => onOpenChange(false)} report={report} />
        ) : query.isError ? (
          <LoadError className="mt-5" thing="Your filters" error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <div className="mt-5 flex flex-col gap-4" aria-busy="true" aria-label="Loading your filters">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-10 w-full" rounded="control" />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where the form over every profile sends its changes: All profiles to start, never "This profile"; its values are your
 * own filters ('me', whatever profile the tab works on). v34 FANWEB fix: the profiles chosen are exactly the ones ticked
 * (untick You to change only Ana's), always through the fan-out, once the list of shared profiles is read.
 */
export const ALL_PROFILES_SCOPE = { start: { kind: 'all' }, allowThis: false, self: PROFILE_SELF, everyProfile: true } as const;

/** The form itself (drawn by the tests on its own). */
export function AllProfilesFiltersForm({ saved, onClose, report }: { saved: PrepareFiltersResponse; onClose: () => void; report?: ReportShow }) {
  const state = usePrepareFiltersForm(saved, { preview: false });
  const save = useSaveFilters({ onError: state.showServerErrors, report });
  const scope = useFiltersScope(state, ALL_PROFILES_SCOPE);
  const apply = () => {
    const input = scope.input();
    if (!input) return;
    save.mutateAsync(input).then(onClose, () => undefined);
  };
  return (
    <>
      {/* v34 FIX-WEB (final review U-M1): `relative`, so the marks' sr-only names and the pay field's "$" stay inside this
          scrolling body (the dialog itself never scrolls; its title stays on screen). */}
      <div className="relative -mx-6 mt-4 min-h-0 flex-1 overflow-y-auto border-t border-divider-soft px-6 pt-3 max-sm:-mx-4 max-sm:px-4" data-all-profiles-filters="">
        {scope.control && <div className="mb-2 flex justify-end">{scope.control}</div>}
        <PrepareFiltersFields state={state} whereYouLiveHref="/settings#where-you-live" marks={scope.marks} />
      </div>
      <div
        className="-mx-6 -mb-6 flex flex-col gap-3 rounded-b-popup border-t border-border bg-surface-low px-6 py-4 max-sm:-mx-4 max-sm:-mb-4 max-sm:px-4 sm:flex-row sm:items-center"
        data-all-profiles-filters-footer=""
      >
        <p className="text-[13px] leading-5 text-muted-foreground" aria-live="polite">
          {scope.waiting
            ? FANOUT_COPY.loadingProfiles
            : state.applying.length > 0
              ? FANOUT_COPY.marksCount(state.applying.length)
              : FANOUT_COPY.marksNone}
          {scope.unticked.length > 0 && <span className="block">{FANOUT_COPY.notTicked(untickedWords(scope.unticked))}</span>}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2.5 sm:ml-auto">
          <Button variant="outline" className="max-sm:h-11 max-sm:flex-1" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="max-sm:h-11 max-sm:flex-1"
            loading={save.isPending}
            disabled={state.applying.length === 0 || scope.waiting}
            onClick={apply}
            data-all-profiles-filters-apply=""
          >
            {save.isPending ? FANOUT_COPY.filtersAllSaving : scope.waiting ? FANOUT_COPY.loadingProfiles : FANOUT_COPY.filtersAllSave}
          </Button>
        </div>
      </div>
      {save.element}
    </>
  );
}
