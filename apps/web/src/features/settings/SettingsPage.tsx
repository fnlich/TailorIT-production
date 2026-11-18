'use client';

import type { Account } from '@tailorit/shared/auth';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useMemo, useState, type FormEvent } from 'react';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Field, FieldLabel } from '@/components/ui/Field';
import { MapPinIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Slider } from '@/components/ui/Slider';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePublicConstants, type TooLongText } from '@/lib/constants';
import { formatSalary } from '@/lib/format';
import { NotificationSettings } from '@/features/notifications/NotificationSettings'; // v31 HEADER
import { AccountSection } from './AccountSection';
import {
  CHOICE_GROUP_LABEL,
  EXPERIENCE_CHOICES,
  JOB_PREFERENCES_DESCRIPTION,
  LOCATION_TYPE_CHOICES,
  PREFERENCE_JOB_TYPE_CHOICES,
} from './choices';
import { PREFERENCES_QUERY_KEY, fetchPreferences, renameAccount, savePreferences, type SettingsPreferences } from './api';
import {
  CITY_MAX,
  COUNTRY_CHOICES,
  LOCATION_COPY,
  cleanLocation,
  countryCode,
  countryName,
  deviceTimeZone,
  regionChoices,
  timeZoneChoices,
  validateLocation,
  type LocationErrors,
} from './location';
import { ChoiceGroup, Section } from './parts';
import { WHERE_YOU_LIVE_ANCHOR } from './prepare/PrepareFilters';
import { PrepareSection } from './prepare/PrepareSection';

const SALARY_MAX = 400_000;
const SALARY_STEP = 5_000;
/** The Jobs page's insights, whose match carries the experience-level check against these preferences. */
const JOBS_INSIGHTS_KEY = ['jobs', 'insights'] as const;

/**
 * Settings: v2.0's Account first (the plan, today's usage, extra credit), then the display name, the contact details
 * cover letters use, job preferences with where you live, and Prepare & Queue (/settings#prepare).
 */
export function SettingsPage() {
  const { account } = useAuth();
  const preferences = useQuery({ queryKey: PREFERENCES_QUERY_KEY, queryFn: ({ signal }) => fetchPreferences(signal) });

  return (
    <div className={clsx('mx-auto w-full max-w-[880px] pt-7 pb-20', PAGE_GUTTER)}>
      <PageHeader
        title="Settings"
        description="Your account, your profile, the jobs you are looking for, and how Prepare & Queue works."
      />
      <AccountSection className="mt-6" />
      {preferences.isError ? (
        <Notice
          tone="error"
          className="mt-6"
          title="Your settings could not be loaded"
          action={
            <Button variant="outline" size="sm" onClick={() => void preferences.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(preferences.error, 'Please try again in a moment.')}
        </Notice>
      ) : preferences.isPending || !account ? (
        <SettingsSkeleton />
      ) : (
        <SettingsForm key={preferences.dataUpdatedAt} account={account} initial={preferences.data} />
      )}
      <PrepareSection className="mt-6" />
      {/* v31 HEADER: Settings › Notification settings (/settings#notifications). */}
      <NotificationSettings className="mt-6" />
    </div>
  );
}

type FieldErrors = Partial<Record<'name' | 'phone' | 'linkedinUrl' | 'location' | 'portfolioUrl' | 'minSalary', string>> &
  LocationErrors;

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.includes('.');
  } catch {
    return false;
  }
}

function validate(name: string, prefs: SettingsPreferences, tooLong: TooLongText): FieldErrors {
  const errors: FieldErrors = { ...validateLocation(cleanLocation(prefs), tooLong) };
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) errors.name = 'A display name is between 1 and 120 characters.';
  if (prefs.linkedinUrl.trim() && !looksLikeUrl(prefs.linkedinUrl.trim())) errors.linkedinUrl = 'Must be a valid url';
  if (prefs.portfolioUrl.trim() && !looksLikeUrl(prefs.portfolioUrl.trim())) errors.portfolioUrl = 'Must be a valid url';
  return errors;
}

function toggle<V extends string>(list: readonly V[], value: V): V[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function SettingsForm({ account, initial }: { account: Account; initial: SettingsPreferences }) {
  const queryClient = useQueryClient();
  const { setAccount } = useAuth();
  const toast = useToast();
  const { t } = usePublicConstants();
  const [name, setName] = useState(account.name);
  const [prefs, setPrefs] = useState<SettingsPreferences>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const nameChanged = name.trim() !== account.name.trim();
  const prefsChanged = JSON.stringify(prefs) !== JSON.stringify(initial);
  const dirty = nameChanged || prefsChanged;

  const save = useMutation({
    mutationFn: async () => {
      if (nameChanged) {
        const updated = await renameAccount(name.trim());
        setAccount(updated ?? { ...account, name: name.trim() });
      }
      if (prefsChanged) {
        const cleaned: SettingsPreferences = {
          ...prefs,
          ...cleanLocation(prefs),
          phone: prefs.phone.trim(),
          location: prefs.location.trim(),
          linkedinUrl: prefs.linkedinUrl.trim(),
          portfolioUrl: prefs.portfolioUrl.trim(),
        };
        const saved = await savePreferences(cleaned);
        queryClient.setQueryData(PREFERENCES_QUERY_KEY, saved);
        // The Jobs page reads its level check again instead of comparing against the previous preferences.
        void queryClient.invalidateQueries({ queryKey: JOBS_INSIGHTS_KEY });
      }
    },
    onSuccess: () => {
      toast.success('Settings saved');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fields) {
        setErrors((current) => ({ ...current, ...(error.fields as FieldErrors) }));
      }
      setFormError(userMessage(error, 'Your settings could not be saved. Please try again.'));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = validate(name, prefs, (max) => t('MSG_TEXT_TOO_LONG', { max }));
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    save.mutate();
  };

  const set = <K extends keyof SettingsPreferences>(key: K, value: SettingsPreferences[K]) => {
    setPrefs((current) => ({ ...current, [key]: value }));
    if (key in errors) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  return (
    <form onSubmit={submit} noValidate className="mt-6 flex flex-col gap-6">
      <Section title="Profile" description="How TailorIT addresses you.">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Display name" error={errors.name}>
            <Input
              value={name}
              maxLength={120}
              autoComplete="name"
              onChange={(event) => {
                setName(event.target.value);
                if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
              }}
            />
          </Field>
          <Field label="Email" hint="You sign in with this address.">
            <Input value={account.email} readOnly disabled />
          </Field>
        </div>
      </Section>

      <Section
        title="Contact details"
        description="Cover letters use these when your resume does not include them."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Phone" optional error={errors.phone}>
            <Input
              type="tel"
              autoComplete="tel"
              placeholder="(555) 123-4567"
              value={prefs.phone}
              onChange={(event) => set('phone', event.target.value)}
            />
          </Field>
          <Field label="Location" optional error={errors.location}>
            <Input
              autoComplete="address-level2"
              placeholder="City, State"
              value={prefs.location}
              onChange={(event) => set('location', event.target.value)}
            />
          </Field>
          <Field label="LinkedIn URL" optional error={errors.linkedinUrl}>
            <Input
              type="url"
              inputMode="url"
              placeholder="linkedin.com/in/your-name"
              value={prefs.linkedinUrl}
              onChange={(event) => set('linkedinUrl', event.target.value)}
            />
          </Field>
          <Field label="Portfolio URL" optional error={errors.portfolioUrl}>
            <Input
              type="url"
              inputMode="url"
              placeholder="your-site.com"
              value={prefs.portfolioUrl}
              onChange={(event) => set('portfolioUrl', event.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        id="job-preferences"
        title="Job preferences"
        description={JOB_PREFERENCES_DESCRIPTION}
      >
        <div className="flex flex-col gap-6">
          <JobPreferenceChoices prefs={prefs} set={set} />
          <div className="flex max-w-md flex-col gap-2">
            <div className="flex items-baseline justify-between gap-4">
              <FieldLabel>Minimum salary</FieldLabel>
              {/* A salary is a measurement (mono figures); "No minimum" stays in the UI face. */}
              <span className={clsx('text-sm text-foreground', prefs.minSalary ? 'num' : 'font-medium')}>
                {prefs.minSalary ? `${formatSalary(prefs.minSalary)}/yr` : 'No minimum'}
              </span>
            </div>
            <Slider
              value={prefs.minSalary ?? 0}
              min={0}
              max={SALARY_MAX}
              step={SALARY_STEP}
              thumbLabels={['Minimum salary']}
              formatValue={(value) => (value ? `${formatSalary(value)} a year` : 'No minimum')}
              onValueChange={(value) => set('minSalary', value > 0 ? value : null)}
            />
            <div className="num flex justify-between text-xs text-muted-foreground">
              <span>$0</span>
              <span>$400k+</span>
            </div>
          </div>
          <WhereYouLive prefs={prefs} errors={errors} set={set} />
        </div>
      </Section>

      {formError && <Notice tone="error">{formError}</Notice>}

      <div className="flex items-center justify-end gap-3">
        <Button
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setName(account.name);
            setPrefs(initial);
            setErrors({});
            setFormError(null);
          }}
        >
          Discard changes
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!dirty}>
          {save.isPending ? 'Saving...' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

/** Job preferences' chip groups: experience level, job type, location type, in the Prepare filters' words (UX-7). */
export function JobPreferenceChoices({
  prefs,
  set,
}: {
  prefs: Pick<SettingsPreferences, 'experienceLevels' | 'jobTypes' | 'workArrangements'>;
  set: <K extends 'experienceLevels' | 'jobTypes' | 'workArrangements'>(key: K, value: SettingsPreferences[K]) => void;
}) {
  return (
    <>
      <ChoiceGroup
        label={CHOICE_GROUP_LABEL.experience}
        options={EXPERIENCE_CHOICES}
        selected={prefs.experienceLevels}
        onToggle={(value) => set('experienceLevels', toggle(prefs.experienceLevels, value))}
      />
      <ChoiceGroup
        label={CHOICE_GROUP_LABEL.jobType}
        options={PREFERENCE_JOB_TYPE_CHOICES}
        selected={prefs.jobTypes}
        onToggle={(value) => set('jobTypes', toggle(prefs.jobTypes, value))}
      />
      <ChoiceGroup
        label={CHOICE_GROUP_LABEL.locationType}
        options={LOCATION_TYPE_CHOICES}
        selected={prefs.workArrangements}
        onToggle={(value) => set('workArrangements', toggle(prefs.workArrangements, value))}
      />
    </>
  );
}

function SettingsSkeleton() {
  return (
    <div className="mt-6 flex flex-col gap-6" aria-busy="true" aria-label="Loading settings">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-card border border-border bg-surface p-6 shadow-card">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-4 w-72" />
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <Skeleton className="h-9 w-full" rounded="control" />
            <Skeleton className="h-9 w-full" rounded="control" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * v2.0 (A22): Job preferences › Where you live: country, state or province, city and time zone, for the location
 * filter (Settings › Prepare & Queue). Saved with the rest of the form.
 */
function WhereYouLive({
  prefs,
  errors,
  set,
}: {
  prefs: SettingsPreferences;
  errors: FieldErrors;
  set: <K extends keyof SettingsPreferences>(key: K, value: SettingsPreferences[K]) => void;
}) {
  const regions = regionChoices(prefs.homeCountry);
  const zones = useMemo(() => timeZoneChoices(prefs.timeZone), [prefs.timeZone]);
  const [device] = useState(deviceTimeZone);
  const titleId = `${WHERE_YOU_LIVE_ANCHOR}-title`;
  return (
    <div
      id={WHERE_YOU_LIVE_ANCHOR}
      role="group"
      aria-labelledby={titleId}
      className="flex scroll-mt-[calc(var(--spacing-topbar)_+_16px)] flex-col gap-4 border-t border-divider-soft pt-6"
    >
      <div>
        <h3 id={titleId} className="flex items-center gap-2 text-sm leading-5 font-semibold text-foreground">
          <MapPinIcon size={16} aria-hidden="true" />
          {LOCATION_COPY.group}
        </h3>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{LOCATION_COPY.helper}</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={LOCATION_COPY.country} optional error={errors.homeCountry}>
          <Combobox
            options={COUNTRY_CHOICES.map((choice) => choice.label)}
            value={countryName(prefs.homeCountry)}
            placeholder={LOCATION_COPY.countryPlaceholder}
            onValueChange={(name) => {
              const code = countryCode(name);
              set('homeCountry', code);
              if (code !== prefs.homeCountry) set('homeRegion', null);
            }}
          />
        </Field>
        <Field
          label={LOCATION_COPY.region}
          optional
          error={errors.homeRegion}
          hint={regions ? undefined : LOCATION_COPY.regionCodeHint}
        >
          {regions ? (
            <Select
              options={regions}
              value={prefs.homeRegion && regions.some((region) => region.value === prefs.homeRegion) ? prefs.homeRegion : null}
              placeholder={LOCATION_COPY.regionPlaceholder}
              onValueChange={(region) => set('homeRegion', region)}
            />
          ) : (
            <Input
              value={prefs.homeRegion ?? ''}
              maxLength={6}
              autoComplete="address-level1"
              className="uppercase"
              disabled={!prefs.homeCountry}
              onChange={(event) => set('homeRegion', event.target.value.toUpperCase() || null)}
            />
          )}
        </Field>
        <Field label={LOCATION_COPY.city} optional error={errors.homeCity}>
          <Input
            value={prefs.homeCity ?? ''}
            maxLength={CITY_MAX}
            autoComplete="address-level2"
            onChange={(event) => set('homeCity', event.target.value || null)}
          />
        </Field>
        <Field
          label={LOCATION_COPY.timeZone}
          optional
          error={errors.timeZone}
          hint={
            device && device !== prefs.timeZone ? (
              <button
                type="button"
                className="font-medium text-primary-ink underline-offset-2 hover:underline"
                onClick={() => set('timeZone', device)}
              >
                {LOCATION_COPY.deviceZone(device)}
              </button>
            ) : undefined
          }
        >
          <Combobox
            options={zones}
            value={prefs.timeZone}
            placeholder={LOCATION_COPY.timeZonePlaceholder}
            onValueChange={(zone) => set('timeZone', zone)}
          />
        </Field>
      </div>
    </div>
  );
}
