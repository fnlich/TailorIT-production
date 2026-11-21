'use client';

import type { PrepareFilters as Filters, PrepareFiltersPreview, PrepareFiltersResponse } from '@tailorit/shared/filters';
import { EXPERIENCE_LEVELS, EMPLOYMENT_TYPES_V2, INDUSTRIES, INDUSTRY_IDS, WORK_ARRANGEMENTS } from '@tailorit/shared/jobs';
import type { SharePermission } from '@tailorit/shared/sharing';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Badge } from '../../../components/ui/Badge';
import { Field } from '../../../components/ui/Field';
import { HelpTip } from '../../../components/ui/HelpTip';
import { WarningCircleIcon } from '../../../components/ui/icons';
import { Input, Textarea } from '../../../components/ui/Input';
import { SegmentedControl } from '../../../components/ui/SegmentedControl';
import { Spinner } from '../../../components/ui/Spinner';
import { useToast } from '../../../components/ui/Toast';
import { ApiError, isProfileRefusal, userMessage } from '../../../lib/api';
import { usePublicConstants } from '../../../lib/constants';
import { EXPERIENCE_CHOICES, LOCATION_TYPE_CHOICES } from '../choices';
import { CharacterCount, ChoiceGroup, SwitchRow } from '../parts';
import { prepareSettingsKeys, previewPrepareFilters, savePrepareFilters } from './api';
import { FILTERS_COPY } from './copy';
import {
  JOB_TYPE_CHIPS,
  filtersToForm,
  formToFilters,
  previewLine,
  sameFilters,
  toggleIn,
  type FilterForm,
  type FilterFormErrors,
  type FormResult,
} from './filters';

// v31 AUTO: the Prepare filters as one form, shared by Settings › Prepare & Queue (PrepareFilters, with its save bar)
// and the Auto-apply page's filters dialog (features/prepare/PrepareFiltersDialog, with Only Filter and Filter and
// Prepare). Built from v2.0's Settings form (docs/design/v2.0/08-ui.md; 06-filters-analysis.md): the person's saved
// filters as fields, a live preview of how many saved jobs they let through (POST /api/prepare/filters/preview, 500 ms
// after the last change, no AI), and the save (PUT /api/prepare/filters), after which the Auto-apply page's lists read
// their labels again. Unknown details never filter a job out: the server's filters pass what a job's analysis does not
// know.

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

/** The preview's read, as the form shows it. */
export interface FiltersPreviewRead {
  data: PrepareFiltersPreview | undefined;
  isFetching: boolean;
  isError: boolean;
}

/** One filters form over the saved filters: its fields, their errors, the valid filters and the live preview. */
export interface PrepareFiltersFormState {
  saved: PrepareFiltersResponse;
  form: FilterForm;
  set: <K extends keyof FilterForm>(key: K, value: FilterForm[K]) => void;
  /** The form as PrepareFiltersSchema, or its errors. */
  result: FormResult;
  /** The errors shown: the server's, and the ones the person has typed. */
  errors: FilterFormErrors;
  /** The form says something else than the saved filters (or cannot be read as filters). */
  dirty: boolean;
  preview: FiltersPreviewRead;
  /** Back to the saved filters. */
  reset: () => void;
  /** The valid filters to save, or null with every error shown. */
  check: () => Filters | null;
  /** A refused save's field errors, shown on their fields. */
  showServerErrors: (error: unknown) => void;
  /** CUSTOM_FILTER_PROMPT_MAX_CHARS. */
  promptMax: number;
}

/** The form's own errors show once the person has typed something that is wrong, not for an empty prompt not yet typed. */
function visibleErrors(errors: FilterFormErrors, form: FilterForm): FilterFormErrors {
  return {
    ...(errors.minSalary ? { minSalary: errors.minSalary } : {}),
    ...(errors.customPrompt && form.customPrompt.trim() !== '' ? { customPrompt: errors.customPrompt } : {}),
  };
}

export function usePrepareFiltersForm(saved: PrepareFiltersResponse): PrepareFiltersFormState {
  const { get, t } = usePublicConstants();
  const promptMax = get('CUSTOM_FILTER_PROMPT_MAX_CHARS');
  const initial = useMemo(() => filtersToForm(saved.filters), [saved.filters]);
  const [form, setForm] = useState<FilterForm>(initial);
  const [errors, setErrors] = useState<FilterFormErrors>({});
  const result = useMemo(() => formToFilters(form, promptMax, (max) => t('MSG_TEXT_TOO_LONG', { max })), [form, promptMax, t]);
  const valid = result.ok ? result.filters : null;
  const dirty = valid === null || !sameFilters(valid, saved.filters);

  const set = useCallback(<K extends keyof FilterForm>(key: K, value: FilterForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === 'minSalary') setErrors((current) => ({ ...current, minSalary: undefined }));
    if (key === 'customPrompt' || key === 'customEnabled') setErrors((current) => ({ ...current, customPrompt: undefined }));
  }, []);

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

  const shown: FilterFormErrors = { ...errors, ...(result.ok ? {} : visibleErrors(result.errors, form)) };
  return {
    saved,
    form,
    set,
    result,
    errors: shown,
    dirty,
    preview: { data: preview.data, isFetching: preview.isFetching, isError: preview.isError },
    reset: () => {
      setForm(initial);
      setErrors({});
    },
    check: () => {
      if (!result.ok) {
        setErrors(result.errors);
        return null;
      }
      setErrors({});
      return result.filters;
    },
    showServerErrors: (error) => {
      if (!(error instanceof ApiError) || !error.fields) return;
      const fields = Object.entries(error.fields);
      const prompt = fields.find(([key]) => /prompt|custom/i.test(key));
      const salary = fields.find(([key]) => /salary/i.test(key));
      setErrors((current) => ({
        ...current,
        ...(prompt ? { customPrompt: prompt[1] } : {}),
        ...(salary ? { minSalary: salary[1] } : {}),
      }));
    },
    promptMax,
  };
}

/**
 * Saves the filters: the stored copy is set at once (every form over it starts again from it), the Auto-apply page's
 * reads are marked stale (the Saved jobs' "Filtered: …" labels and the Filters count follow), and a toast says so.
 * A refused save shows its error in a toast; `onError` puts its field errors on the fields.
 */
export function useSaveFilters({ onSaved, onError }: { onSaved?: () => void; onError?: (error: unknown) => void } = {}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (filters: Filters) => savePrepareFilters(filters),
    onSuccess: (answer) => {
      onSaved?.();
      queryClient.setQueryData(prepareSettingsKeys.filters, answer);
      void queryClient.invalidateQueries({ queryKey: ['auto-apply'] });
      toast.success(FILTERS_COPY.savedToast);
    },
    onError: (error) => {
      onError?.(error);
      // v33 SHARE-7: a shared profile's refusal is the shell's one alert, not a toast too.
      if (isProfileRefusal(error)) return;
      toast.error(FILTERS_COPY.saveFailed, userMessage(error));
    },
  });
}

/** One filter of the list. */
function FilterRow({ children }: { children: ReactNode }) {
  return <div className="py-4 first:pt-1 last:pb-1">{children}</div>;
}

/**
 * v33 SHARE-7 (PLAN F9 "Permissions"): how the filters show on a profile shared with the person. `readOnly` (no Job
 * settings Change box): every field shown and off, nothing changes. `eligibility` (the visa sponsorship and clearance
 * switches, under Sensitive answers): `hidden` without its See box, `readOnly` without its Change box.
 */
export interface FiltersAccess {
  readOnly?: boolean;
  eligibility?: 'shown' | 'readOnly' | 'hidden';
}

/**
 * v33 SHARE-7: the filters' access from what the tab's profile may do (`can`: always true on the person's own): Job
 * settings' Change box to change them; Sensitive answers' See box to show the eligibility switches, its Change box to
 * change them.
 */
export function filtersAccessOf(can: (perm: SharePermission) => boolean): FiltersAccess {
  return {
    readOnly: !can('settings:edit'),
    eligibility: !can('sensitive:view') ? 'hidden' : can('sensitive:edit') ? 'shown' : 'readOnly',
  };
}

/**
 * The filters' fields, one per row. `whereYouLiveHref`: where the location notice's link goes (in Settings the anchor
 * on the same page; elsewhere Settings' own).
 */
export function PrepareFiltersFields({
  state,
  whereYouLiveHref = `#${WHERE_YOU_LIVE_ANCHOR}`,
  access = {},
}: {
  state: PrepareFiltersFormState;
  whereYouLiveHref?: string;
  /** v33 SHARE-7: on a shared profile (the person's own: everything). */
  access?: FiltersAccess;
}) {
  const { form, errors, saved, promptMax } = state;
  // v33 SHARE-7: a read-only form changes nothing (the switches are spans a disabled fieldset does not reach).
  const readOnly = access.readOnly === true;
  const eligibility = access.eligibility ?? 'shown';
  const eligibilityOff = readOnly || eligibility === 'readOnly';
  // v33 FIX-2 (final review, sharing 1): the qualification filter's citizenship part decides by the owner's
  // citizenships, so only Sensitive answers' Change changes it (the server keeps it otherwise); it shows either way.
  const qualificationLocked = !readOnly && eligibility !== 'shown';
  const set: PrepareFiltersFormState['set'] = (key, value) => {
    if (readOnly || (eligibilityOff && (key === 'noSponsorship' || key === 'clearanceMismatch'))) return;
    if (qualificationLocked && key === 'qualificationMismatch') return;
    state.set(key, value);
  };
  const locationMissing = form.locationMismatch && (!saved.locationKnown || !saved.timeZoneKnown);
  return (
    <div className="flex flex-col divide-y divide-divider-soft" data-prepare-filters-fields="">
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
            <span className="flex items-center gap-1.5">
              <span className="text-sm leading-5 font-medium text-foreground">{FILTERS_COPY.industry}</span>
              <HelpTip label={FILTERS_COPY.industry}>{FILTERS_COPY.anyHint}</HelpTip>
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
          disabled={readOnly}
          onCheckedChange={(on) => set('locationMismatch', on)}
        >
          {/* v32 COPY (E4): a state, so a small chip with its "?" and the link, never a banner. */}
          {locationMissing && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-location-missing="">
              <span className="inline-flex items-center gap-1">
                <Badge tone="warning" icon={<WarningCircleIcon size={13} weight="fill" aria-hidden="true" />}>
                  {FILTERS_COPY.locationMissingChip}
                </Badge>
                <HelpTip label={FILTERS_COPY.locationMissingChip}>{FILTERS_COPY.locationMissing}</HelpTip>
              </span>
              <a href={whereYouLiveHref} className="text-[13px] leading-5 font-medium text-primary underline-offset-2 hover:underline">
                {FILTERS_COPY.locationMissingLink}
              </a>
            </span>
          )}
        </SwitchRow>
      </FilterRow>
      <FilterRow>
        <SwitchRow
          title={FILTERS_COPY.qualifications}
          hint={qualificationLocked ? `${FILTERS_COPY.qualificationsHint} ${FILTERS_COPY.qualificationsLocked}` : FILTERS_COPY.qualificationsHint}
          checked={form.qualificationMismatch}
          disabled={readOnly || qualificationLocked}
          onCheckedChange={(on) => set('qualificationMismatch', on)}
        />
      </FilterRow>
      <FilterRow>
        <SwitchRow
          title={FILTERS_COPY.certifications}
          hint={FILTERS_COPY.certificationsHint}
          checked={form.certificationMismatch}
          disabled={readOnly}
          onCheckedChange={(on) => set('certificationMismatch', on)}
        >
          {/* v32 COPY: a link is an action, so it stays visible (the hint is a "?" now). */}
          <Link
            href={CERTIFICATIONS_HREF}
            className="self-start text-[13px] leading-5 font-medium text-primary underline-offset-2 hover:underline"
          >
            {FILTERS_COPY.certificationsLink}
          </Link>
        </SwitchRow>
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
        <Field label={FILTERS_COPY.minPay} hint={FILTERS_COPY.minPayHint} error={errors.minSalary} className="max-w-xs">
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
      {/* v33 SHARE-7: the eligibility switches follow the owner's Sensitive answers boxes on a shared profile. */}
      {eligibility !== 'hidden' && (
        <FilterRow>
          <SwitchRow
            title={FILTERS_COPY.sponsorshipSwitch}
            hint={FILTERS_COPY.sponsorshipHint}
            checked={form.noSponsorship}
            disabled={eligibilityOff}
            onCheckedChange={(on) => set('noSponsorship', on)}
          />
        </FilterRow>
      )}
      {eligibility !== 'hidden' && (
        <FilterRow>
          <SwitchRow
            title={FILTERS_COPY.clearance}
            hint={FILTERS_COPY.clearanceHint}
            checked={form.clearanceMismatch}
            disabled={eligibilityOff}
            onCheckedChange={(on) => set('clearanceMismatch', on)}
          />
        </FilterRow>
      )}
      <FilterRow>
        <SwitchRow
          title={FILTERS_COPY.custom}
          hint={FILTERS_COPY.customHint}
          checked={form.customEnabled}
          disabled={readOnly}
          onCheckedChange={(on) => set('customEnabled', on)}
        >
          {form.customEnabled && (
            <Field label={FILTERS_COPY.customPrompt} error={errors.customPrompt}>
              <Textarea
                rows={4}
                value={form.customPrompt}
                placeholder={FILTERS_COPY.customPlaceholder}
                onChange={(event) => set('customPrompt', event.target.value)}
              />
              {/* A count is a value: it stays visible. */}
              <span className="text-[13px] leading-5 text-muted-foreground">
                <CharacterCount length={form.customPrompt.trim().length} max={promptMax} />
              </span>
            </Field>
          )}
        </SwitchRow>
      </FilterRow>
    </div>
  );
}

/** What the preview says now. */
export type PreviewState =
  | { kind: 'ready'; text: string; checking: boolean }
  | { kind: 'checking' }
  | { kind: 'error' }
  | { kind: 'invalid' };

/** The preview's state for a form: invalid fields first, then the read (its words from `words`). */
export function previewStateOf(
  state: Pick<PrepareFiltersFormState, 'result' | 'preview'>,
  words: (preview: PrepareFiltersPreview) => string = previewLine,
): PreviewState {
  if (!state.result.ok) return { kind: 'invalid' };
  if (state.preview.data) return { kind: 'ready', text: words(state.preview.data), checking: state.preview.isFetching };
  return state.preview.isError ? { kind: 'error' } : { kind: 'checking' };
}

/** The live preview: read out politely as it changes. */
export function PreviewLine({ state, className }: { state: PreviewState; className?: string }) {
  return (
    <p
      aria-live="polite"
      data-filters-preview={state.kind}
      className={className ?? 'flex items-start gap-2 rounded-control bg-surface-low px-3.5 py-3 text-sm leading-5 text-foreground'}
    >
      {(state.kind === 'checking' || (state.kind === 'ready' && state.checking)) && <Spinner size={14} className="mt-0.5 shrink-0" />}
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
