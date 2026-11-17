'use client';

import type { PrepareFilters as Filters, PrepareFiltersResponse } from '@tailorit/shared/filters';
import {
  EXPERIENCE_LEVELS,
  EMPLOYMENT_TYPES_V2,
  INDUSTRIES,
  INDUSTRY_IDS,
  WORK_ARRANGEMENTS,
} from '@tailorit/shared/jobs';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../../components/ui/Button';
import { Field } from '../../../components/ui/Field';
import { FunnelIcon } from '../../../components/ui/icons';
import { Input, Textarea } from '../../../components/ui/Input';
import { Notice } from '../../../components/ui/Notice';
import { SegmentedControl } from '../../../components/ui/SegmentedControl';
import { Skeleton } from '../../../components/ui/Skeleton';
import { Spinner } from '../../../components/ui/Spinner';
import { useToast } from '../../../components/ui/Toast';
import { ApiError, userMessage } from '../../../lib/api';
import { usePublicConstants } from '../../../lib/constants';
import { EXPERIENCE_CHOICES, LOCATION_TYPE_CHOICES } from '../choices';
import { CharacterCount, ChoiceGroup, SwitchRow } from '../parts';
import { fetchPrepareFilters, prepareSettingsKeys, previewPrepareFilters, savePrepareFilters } from './api';
import { FILTERS_COPY } from './copy';
import {
  JOB_TYPE_CHIPS,
  activeFilterCount,
  filtersToForm,
  formToFilters,
  previewLine,
  sameFilters,
  toggleIn,
  type FilterForm,
  type FilterFormErrors,
} from './filters';

// v2.0: Settings › Prepare & Queue › Prepare filters (docs/design/v2.0/08-ui.md; 06-filters-analysis.md). The person's
// saved filters as a form, a live preview of how many saved jobs they let through (POST /api/prepare/filters/preview,
// 500 ms after the last change, no AI), and a save bar that sticks to the bottom of the window while the form holds a
// change. Unknown details never filter a job out: the server's filters pass what a job's analysis does not know.

/** How long the form rests before the preview is asked again. */
export const PREVIEW_DELAY_MS = 500;
/** Where the location filter's notice sends the person: Job preferences › Where you live. */
export const WHERE_YOU_LIVE_ANCHOR = 'where-you-live';
/** The autofill profile, where certifications are kept. */
const CERTIFICATIONS_HREF = '/settings/autofill';

const INDUSTRY_CHIPS = INDUSTRIES.map((entry) => ({ value: entry.id, label: entry.label }));
// v2.0 fix (UX-7): the same words as Job preferences' groups (choices.ts).
const LOCATION_CHIPS = LOCATION_TYPE_CHOICES;
const EXPERIENCE_CHIPS = EXPERIENCE_CHOICES;

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
          className="flex items-center gap-2 text-sm leading-5 font-semibold text-foreground outline-none"
        >
          <FunnelIcon size={16} aria-hidden="true" />
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
  const queryClient = useQueryClient();
  const toast = useToast();
  const { get, t } = usePublicConstants();
  const promptMax = get('CUSTOM_FILTER_PROMPT_MAX_CHARS');
  const initial = useMemo(() => filtersToForm(saved.filters), [saved.filters]);
  const [form, setForm] = useState<FilterForm>(initial);
  const [errors, setErrors] = useState<FilterFormErrors>({});
  const result = useMemo(() => formToFilters(form, promptMax, (max) => t('MSG_TEXT_TOO_LONG', { max })), [form, promptMax, t]);
  const valid = result.ok ? result.filters : null;
  const dirty = valid === null || !sameFilters(valid, saved.filters);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!takeFocus()) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) headingRef.current?.focus();
    // On mount only: the form after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof FilterForm>(key: K, value: FilterForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === 'minSalary') setErrors((current) => ({ ...current, minSalary: undefined }));
    if (key === 'customPrompt' || key === 'customEnabled') setErrors((current) => ({ ...current, customPrompt: undefined }));
  };

  // The preview follows the form 500 ms after its last change, from valid filters only.
  const validKey = valid ? JSON.stringify(valid) : null;
  const [previewed, setPreviewed] = useState<Filters | null>(valid);
  useEffect(() => {
    if (validKey === null) return;
    const timer = window.setTimeout(() => setPreviewed(JSON.parse(validKey) as Filters), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [validKey]);
  const preview = useQuery({
    queryKey: prepareSettingsKeys.preview(previewed ?? saved.filters),
    queryFn: ({ signal }) => previewPrepareFilters(previewed ?? saved.filters, signal),
    enabled: previewed !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: (filters: Filters) => savePrepareFilters(filters),
    onSuccess: (answer) => {
      onSaved();
      queryClient.setQueryData(prepareSettingsKeys.filters, answer);
      // The Saved jobs' "Filtered: …" labels follow the new filters on the Auto-apply page.
      void queryClient.invalidateQueries({ queryKey: ['auto-apply'] });
      toast.success(FILTERS_COPY.savedToast);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fields) {
        const fields = Object.entries(error.fields);
        const prompt = fields.find(([key]) => /prompt|custom/i.test(key));
        const salary = fields.find(([key]) => /salary/i.test(key));
        setErrors((current) => ({
          ...current,
          ...(prompt ? { customPrompt: prompt[1] } : {}),
          ...(salary ? { minSalary: salary[1] } : {}),
        }));
      }
      toast.error(FILTERS_COPY.saveFailed, userMessage(error));
    },
  });

  const submit = () => {
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result.filters);
  };

  const shownErrors: FilterFormErrors = { ...errors, ...(result.ok ? {} : visibleErrors(result.errors, form)) };
  const locationMissing = form.locationMismatch && (!saved.locationKnown || !saved.timeZoneKnown);

  return (
    <>
      <FiltersHeading count={valid ? activeFilterCount(valid) : null} headingRef={headingRef} />
      <div className="flex flex-col divide-y divide-divider-soft">
        <FilterRow>
          <ChoiceGroup
            label={FILTERS_COPY.locationType}
            hint={FILTERS_COPY.anyHint}
            options={LOCATION_CHIPS}
            selected={form.locationTypes}
            onToggle={(value) => set('locationTypes', toggleIn(form.locationTypes, value, WORK_ARRANGEMENTS))}
          />
        </FilterRow>
        <FilterRow>
          <ChoiceGroup
            label={FILTERS_COPY.jobType}
            hint={FILTERS_COPY.anyHint}
            options={JOB_TYPE_CHIPS}
            selected={form.jobTypes}
            onToggle={(value) => set('jobTypes', toggleIn(form.jobTypes, value, EMPLOYMENT_TYPES_V2))}
          />
        </FilterRow>
        <FilterRow>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm leading-5 font-medium text-foreground">
                {FILTERS_COPY.industry}
                <span className="ml-2 text-[13px] font-normal text-muted-foreground">{FILTERS_COPY.anyHint}</span>
              </span>
              <SegmentedControl
                size="sm"
                aria-label={FILTERS_COPY.industryModeLabel}
                value={form.industryMode}
                onValueChange={(mode) => set('industryMode', mode)}
                items={[
                  { value: 'include', label: FILTERS_COPY.industryOnly },
                  { value: 'exclude', label: FILTERS_COPY.industrySkip },
                ]}
              />
            </div>
            <ChoiceGroup
              label={form.industryMode === 'include' ? 'Only these industries' : 'Skip these industries'}
              options={INDUSTRY_CHIPS}
              selected={form.industryIds}
              onToggle={(value) => set('industryIds', toggleIn(form.industryIds, value, INDUSTRY_IDS))}
            />
          </div>
        </FilterRow>
        <FilterRow>
          <SwitchRow
            title={FILTERS_COPY.locationMismatch}
            hint={FILTERS_COPY.locationMismatchHint}
            checked={form.locationMismatch}
            onCheckedChange={(on) => set('locationMismatch', on)}
          >
            {locationMissing && (
              <Notice tone="warning">
                {FILTERS_COPY.locationMissing}{' '}
                <a href={`#${WHERE_YOU_LIVE_ANCHOR}`} className="font-semibold underline underline-offset-2">
                  {FILTERS_COPY.locationMissingLink}
                </a>
              </Notice>
            )}
          </SwitchRow>
        </FilterRow>
        <FilterRow>
          <SwitchRow
            title={FILTERS_COPY.qualifications}
            hint={FILTERS_COPY.qualificationsHint}
            checked={form.qualificationMismatch}
            onCheckedChange={(on) => set('qualificationMismatch', on)}
          />
        </FilterRow>
        <FilterRow>
          <SwitchRow
            title={FILTERS_COPY.certifications}
            hint={
              <>
                {FILTERS_COPY.certificationsHint}{' '}
                <Link href={CERTIFICATIONS_HREF} className="font-medium text-primary-ink underline-offset-2 hover:underline">
                  {FILTERS_COPY.certificationsLink}
                </Link>
              </>
            }
            checked={form.certificationMismatch}
            onCheckedChange={(on) => set('certificationMismatch', on)}
          />
        </FilterRow>
        <FilterRow>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm leading-5 font-medium text-foreground">{FILTERS_COPY.autoApply}</span>
            <SegmentedControl
              size="sm"
              aria-label={FILTERS_COPY.autoApply}
              value={form.autoApplySupport}
              onValueChange={(value) => set('autoApplySupport', value)}
              items={[
                { value: 'all', label: FILTERS_COPY.autoApplyAll },
                { value: 'supported', label: FILTERS_COPY.autoApplySupported },
              ]}
            />
          </div>
        </FilterRow>
        <FilterRow>
          <Field label={FILTERS_COPY.minPay} hint={FILTERS_COPY.minPayHint} error={shownErrors.minSalary} className="max-w-xs">
            <Input
              inputMode="numeric"
              placeholder="No minimum"
              leading={<span aria-hidden="true">$</span>}
              className="pl-7"
              value={form.minSalary}
              onChange={(event) => set('minSalary', event.target.value)}
            />
          </Field>
        </FilterRow>
        <FilterRow>
          <ChoiceGroup
            label={FILTERS_COPY.experience}
            hint={FILTERS_COPY.anyHint}
            options={EXPERIENCE_CHIPS}
            selected={form.experienceLevels}
            onToggle={(value) => set('experienceLevels', toggleIn(form.experienceLevels, value, EXPERIENCE_LEVELS))}
          />
        </FilterRow>
        <FilterRow>
          <SwitchRow
            title={FILTERS_COPY.sponsorshipSwitch}
            hint={FILTERS_COPY.sponsorshipHint}
            checked={form.noSponsorship}
            onCheckedChange={(on) => set('noSponsorship', on)}
          />
        </FilterRow>
        <FilterRow>
          <SwitchRow
            title={FILTERS_COPY.clearance}
            hint={FILTERS_COPY.clearanceHint}
            checked={form.clearanceMismatch}
            onCheckedChange={(on) => set('clearanceMismatch', on)}
          />
        </FilterRow>
        <FilterRow>
          <SwitchRow
            title={FILTERS_COPY.custom}
            hint={FILTERS_COPY.customHint}
            checked={form.customEnabled}
            onCheckedChange={(on) => set('customEnabled', on)}
          >
            {form.customEnabled && (
              <Field
                label={FILTERS_COPY.customPrompt}
                error={shownErrors.customPrompt}
                hint={<CharacterCount length={form.customPrompt.trim().length} max={promptMax} />}
              >
                <Textarea
                  rows={4}
                  value={form.customPrompt}
                  placeholder={FILTERS_COPY.customPlaceholder}
                  onChange={(event) => set('customPrompt', event.target.value)}
                />
              </Field>
            )}
          </SwitchRow>
        </FilterRow>
      </div>

      <PreviewLine
        state={
          !result.ok
            ? { kind: 'invalid' }
            : preview.data
              ? { kind: 'ready', text: previewLine(preview.data), checking: preview.isFetching }
              : preview.isError
                ? { kind: 'error' }
                : { kind: 'checking' }
        }
      />

      {dirty && (
        <SaveBar
          saving={save.isPending}
          onDiscard={() => {
            setForm(initial);
            setErrors({});
          }}
          onSave={submit}
        />
      )}
    </>
  );
}

/** The form's own errors show once the person has typed something that is wrong, not for an empty prompt not yet typed. */
function visibleErrors(errors: FilterFormErrors, form: FilterForm): FilterFormErrors {
  return {
    ...(errors.minSalary ? { minSalary: errors.minSalary } : {}),
    ...(errors.customPrompt && form.customPrompt.trim() !== '' ? { customPrompt: errors.customPrompt } : {}),
  };
}

function FilterRow({ children }: { children: ReactNode }) {
  return <div className="py-4 first:pt-1 last:pb-1">{children}</div>;
}

type PreviewState =
  | { kind: 'ready'; text: string; checking: boolean }
  | { kind: 'checking' }
  | { kind: 'error' }
  | { kind: 'invalid' };

/** The live preview: read out politely as it changes. */
export function PreviewLine({ state }: { state: PreviewState }) {
  return (
    <p
      aria-live="polite"
      data-filters-preview={state.kind}
      className="flex items-start gap-2 rounded-control bg-surface-low px-3.5 py-3 text-sm leading-5 text-foreground"
    >
      {(state.kind === 'checking' || (state.kind === 'ready' && state.checking)) && (
        <Spinner size={14} className="mt-0.5 shrink-0" />
      )}
      <span>
        {state.kind === 'ready'
          ? state.text
          : state.kind === 'checking'
            ? FILTERS_COPY.previewChecking
            : state.kind === 'error'
              ? FILTERS_COPY.previewFailed
              : FILTERS_COPY.previewFix}
      </span>
    </p>
  );
}

function SaveBar({ saving, onDiscard, onSave }: { saving: boolean; onDiscard: () => void; onSave: () => void }) {
  return (
    <div
      data-filters-save-bar=""
      className="sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-wrap items-center justify-between gap-3 rounded-b-surface border-t border-border bg-surface/95 px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm"
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
