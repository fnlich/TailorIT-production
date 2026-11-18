'use client';

import {
  AUTOFILL_ANYTHING_ELSE_MAX,
  type AsianSubgroup,
  type AutofillResumeList,
  type AutofillSensitive,
  type GenderIdentity,
  type RaceCategory,
  type SexualOrientation,
  type WorkStatus,
} from '@tailorit/shared/autofill';
import { countryDisplayName, currencyForCountry } from '@tailorit/shared/jobs';
import { useContext } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { DatePickerPopover } from '@/components/ui/DatePickerPopover';
import { Field } from '@/components/ui/Field';
import { CalendarBlankIcon, CheckCircleIcon, CheckIcon, TrashIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Select } from '@/components/ui/Select';
import { formatDate } from '@/lib/format';
import {
  ASIAN_SUBGROUP_OPTIONS,
  CLEARANCE_LEVEL_OPTIONS,
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  GENDER_OPTIONS,
  POLYGRAPH_OPTIONS,
  RACE_OPTIONS,
  REFERRAL_CATEGORY_OPTIONS,
  SALARY_PERIOD_OPTIONS,
  SEXUAL_ORIENTATION_OPTIONS,
  WORK_ARRANGEMENT_OPTIONS,
  WORK_STATUS_OPTIONS,
  withCurrent,
} from '../options';
import { Section } from '../Section';
import {
  AddButton,
  AnswerField,
  answerAt,
  ChipListField,
  DECLINED_LABEL,
  FieldGroup,
  NOT_ANSWERED_LABEL,
  NumberField,
  SelectField,
  SensitiveBooleanField,
  TextareaField,
  TextField,
  hintOf,
} from './fields';
import { useProfileForm } from './form';
import { ONCE_SECTIONS, onceChecklist, onceStatus } from './onceChecklist';
import { SectionLinkContext } from './sectionLink';

const MAX_COUNTRIES = 20;

type WorkAuthorizationRow = AutofillSensitive['workAuthorization'][number];

/** "Not answered" and "Prefer not to say" as Select values, beside an answer's own values. */
const NOT_PROVIDED = 'not_provided';
const DECLINED = 'declined';

function newWorkAuthorization(country: string): WorkAuthorizationRow {
  return {
    country,
    authorized: { state: 'not_provided' },
    sponsorshipNow: { state: 'not_provided' },
    sponsorshipFuture: { state: 'not_provided' },
    status: { state: 'not_provided' },
  };
}

function WorkStatusField({ path }: { path: string }) {
  const form = useProfileForm();
  const answer = answerAt<WorkStatus>(form.read, path);
  const value = answer.state === 'value' ? answer.value : answer.state;
  return (
    <Field label="Work status" error={form.errorWithin(path)} hint="Only for forms that ask for the status itself.">
      <Select<string>
        options={[
          { value: NOT_PROVIDED, label: NOT_ANSWERED_LABEL },
          { value: DECLINED, label: DECLINED_LABEL },
          ...WORK_STATUS_OPTIONS,
        ]}
        value={value}
        disabled={form.busy}
        onValueChange={(next) =>
          form.set(
            path,
            next === NOT_PROVIDED || next === DECLINED ? { state: next } : { state: 'value', value: next as WorkStatus },
          )
        }
      />
    </Field>
  );
}

export function WorkAuthorizationSection() {
  const form = useProfileForm();
  const rows = form.state.draft.sensitive.workAuthorization;
  const listed = new Set(rows.map((row) => row.country));
  const homeCountry = form.state.draft.profile.contact.address.country;
  // A new row starts on the home country, else the countries most applied to, else the first one free.
  const nextCountry = [homeCountry, 'US', 'CA', 'GB', ...COUNTRY_OPTIONS.map((option) => option.value)].find(
    (code): code is string => Boolean(code) && !listed.has(code as string),
  );
  const changeRows = (clears: string | null, next: (list: WorkAuthorizationRow[]) => WorkAuthorizationRow[]) =>
    form.dispatch({
      type: 'change',
      clears,
      recipe: (draft) => ({
        ...draft,
        sensitive: { ...draft.sensitive, workAuthorization: next(draft.sensitive.workAuthorization) },
      }),
    });
  return (
    <Section
      id={ONCE_SECTIONS.workAuthorization}
      title="Work authorization"
      description="One set of answers for each country you apply to work in."
    >
      <div className="flex flex-col gap-4">
        <Notice tone="info">
          Used only for questions that ask exactly this. TailorIT never sends these answers to AI and never writes them to
          its logs.
        </Notice>
        {rows.map((row, index) => {
          const base = `sensitive.workAuthorization.${index}`;
          const name = countryDisplayName(row.country);
          return (
            <div key={index} className="rounded-control border border-border p-4" role="group" aria-label={name}>
              <div className="flex items-end justify-between gap-3">
                <SelectField
                  path={`${base}.country`}
                  label="Country"
                  // A country another row answers for cannot be picked twice.
                  options={withCurrent(COUNTRY_OPTIONS, row.country).map((option) => ({
                    ...option,
                    disabled: option.value !== row.country && listed.has(option.value),
                  }))}
                  className="min-w-0 flex-1 sm:max-w-xs"
                />
                <IconButton
                  label={`Remove ${name}`}
                  tooltip="Remove"
                  size="sm"
                  icon={<TrashIcon size={16} />}
                  disabled={form.busy}
                  onClick={() =>
                    changeRows('sensitive.workAuthorization', (list) => list.filter((_, other) => other !== index))
                  }
                />
              </div>
              <div className="mt-5 flex flex-col gap-5">
                <SensitiveBooleanField path={`${base}.authorized`} label="Authorized to work there?" />
                <SensitiveBooleanField path={`${base}.sponsorshipNow`} label="Need visa sponsorship now?" />
                <SensitiveBooleanField path={`${base}.sponsorshipFuture`} label="Need visa sponsorship in the future?" />
                <div className="sm:max-w-xs">
                  <WorkStatusField path={`${base}.status`} />
                </div>
              </div>
            </div>
          );
        })}
        <div>
          <AddButton
            label="Add a country"
            full={rows.length >= MAX_COUNTRIES || !nextCountry}
            onAdd={() => nextCountry && changeRows(null, (list) => [...list, newWorkAuthorization(nextCountry)])}
          />
        </div>
      </div>
    </Section>
  );
}

const GENDER_CHOICES = [
  ...GENDER_OPTIONS,
  { value: DECLINED, label: DECLINED_LABEL },
  { value: NOT_PROVIDED, label: NOT_ANSWERED_LABEL },
] as const;
type GenderChoice = (typeof GENDER_CHOICES)[number]['value'];
type GenderValue = Extract<AutofillSensitive['eeo']['gender'], { state: 'value' }>['value'];

function GenderField() {
  const form = useProfileForm();
  const path = 'sensitive.eeo.gender';
  const answer = answerAt<GenderValue>(form.read, path);
  const value: GenderChoice = answer.state === 'value' ? answer.value.identity : answer.state;
  const choose = (next: GenderChoice) => {
    if (next === DECLINED || next === NOT_PROVIDED) {
      form.set(path, { state: next });
      return;
    }
    const words = answer.state === 'value' ? answer.value.selfDescribed : '';
    const value: GenderValue = { identity: next as GenderIdentity, selfDescribed: next === 'self-describe' ? words : '' };
    form.set(path, { state: 'value', value });
  };
  return (
    <div className="flex flex-col gap-3">
      <Field label="Gender" error={form.error(path)}>
        <RadioGroup orientation="horizontal" disabled={form.busy} options={GENDER_CHOICES} value={value} onValueChange={choose} />
      </Field>
      {value === 'self-describe' && (
        <div className="border-l-2 border-border pl-4 sm:max-w-md">
          <TextField path={`${path}.value.selfDescribed`} label="In your words" required maxLength={100} />
        </div>
      )}
    </div>
  );
}

const VETERAN_CHOICES = [
  { value: 'protected', label: 'Protected veteran' },
  { value: 'veteran', label: 'Veteran, not protected' },
  { value: 'not-veteran', label: 'Not a veteran' },
  { value: DECLINED, label: DECLINED_LABEL },
  { value: NOT_PROVIDED, label: NOT_ANSWERED_LABEL },
] as const;
type VeteranChoice = (typeof VETERAN_CHOICES)[number]['value'];
type VeteranValue = Extract<AutofillSensitive['eeo']['veteran'], { state: 'value' }>['value'];

function VeteranField() {
  const form = useProfileForm();
  const path = 'sensitive.eeo.veteran';
  const answer = answerAt<VeteranValue>(form.read, path);
  const value: VeteranChoice =
    answer.state !== 'value'
      ? answer.state
      : answer.value.isProtectedVeteran
        ? 'protected'
        : answer.value.isVeteran
          ? 'veteran'
          : 'not-veteran';
  const activeDuty = answer.state === 'value' && answer.value.isActiveDuty;
  const choose = (next: VeteranChoice) => {
    if (next === DECLINED || next === NOT_PROVIDED) form.set(path, { state: next });
    else {
      const value: VeteranValue = {
        isVeteran: next !== 'not-veteran',
        isProtectedVeteran: next === 'protected',
        isActiveDuty: activeDuty,
      };
      form.set(path, { state: 'value', value });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Field label="Veteran status" error={form.errorWithin(path)}>
        <RadioGroup orientation="horizontal" disabled={form.busy} options={VETERAN_CHOICES} value={value} onValueChange={choose} />
      </Field>
      {answer.state === 'value' && (
        <div className="border-l-2 border-border pl-4">
          <Checkbox
            label="I serve in the U.S. armed forces now (active duty)"
            checked={activeDuty}
            disabled={form.busy}
            onCheckedChange={(checked) =>
              form.set(path, { state: 'value', value: { ...answer.value, isActiveDuty: checked } })
            }
          />
        </div>
      )}
    </div>
  );
}

function RacesEditor({ value, update }: { value: RaceCategory[]; update: (next: RaceCategory[]) => void }) {
  const form = useProfileForm();
  const subgroups = form.state.draft.sensitive.eeo.raceSubgroups;
  // Kept in the list's order, whatever order they are ticked in.
  const toggle = (race: RaceCategory, on: boolean) => {
    update(
      RACE_OPTIONS.map((option) => option.value).filter((code) => (code === race ? on : value.includes(code))),
    );
    // Snapshot round 2: the Asian subgroups go with Asian.
    if (race === 'asian' && !on && subgroups.length > 0) form.set('sensitive.eeo.raceSubgroups', []);
  };
  const toggleSubgroup = (subgroup: AsianSubgroup, on: boolean) =>
    form.set(
      'sensitive.eeo.raceSubgroups',
      ASIAN_SUBGROUP_OPTIONS.map((option) => option.value).filter((code) =>
        code === subgroup ? on : subgroups.includes(code),
      ),
    );
  return (
    <div className="flex flex-col gap-4">
      <FieldGroup label="Every race that applies" error={form.errorWithin('sensitive.eeo.races')}>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {RACE_OPTIONS.map((option) => (
            <Checkbox
              key={option.value}
              label={option.label}
              checked={value.includes(option.value)}
              disabled={form.busy}
              onCheckedChange={(checked) => toggle(option.value, checked)}
            />
          ))}
        </div>
      </FieldGroup>
      {value.includes('asian') && (
        <FieldGroup
          label="Asian: which apply"
          error={form.errorWithin('sensitive.eeo.raceSubgroups')}
          hint="For forms that list East, South and Southeast Asian apart."
        >
          <div className="grid gap-2.5 sm:grid-cols-3">
            {ASIAN_SUBGROUP_OPTIONS.map((option) => (
              <Checkbox
                key={option.value}
                label={option.label}
                checked={subgroups.includes(option.value)}
                disabled={form.busy}
                onCheckedChange={(checked) => toggleSubgroup(option.value, checked)}
              />
            ))}
          </div>
        </FieldGroup>
      )}
    </div>
  );
}

type OrientationValue = Extract<AutofillSensitive['eeo']['sexualOrientation'], { state: 'value' }>['value'];

/** Snapshot round 2: every sexual orientation that applies, and the words for "I describe myself". */
function OrientationEditor({ value, update }: { value: OrientationValue; update: (next: OrientationValue) => void }) {
  const form = useProfileForm();
  const toggle = (orientation: SexualOrientation, on: boolean) =>
    update({
      ...value,
      values: SEXUAL_ORIENTATION_OPTIONS.map((option) => option.value).filter((code) =>
        code === orientation ? on : value.values.includes(code),
      ),
    });
  return (
    <div className="flex flex-col gap-4">
      <FieldGroup
        label="Every answer that applies"
        error={form.errorWithin('sensitive.eeo.sexualOrientation.value.values')}
      >
        <div className="grid gap-2.5 sm:grid-cols-2">
          {SEXUAL_ORIENTATION_OPTIONS.map((option) => (
            <Checkbox
              key={option.value}
              label={option.label}
              checked={value.values.includes(option.value)}
              disabled={form.busy}
              onCheckedChange={(checked) => toggle(option.value, checked)}
            />
          ))}
        </div>
      </FieldGroup>
      {value.values.includes('self-describe') && (
        <div className="sm:max-w-md">
          <TextField
            path="sensitive.eeo.sexualOrientation.value.selfDescribed"
            label="In your words"
            required
            maxLength={100}
          />
        </div>
      )}
    </div>
  );
}

export function SelfIdentificationSection() {
  return (
    <Section
      id={ONCE_SECTIONS.selfIdentification}
      title="Voluntary self-identification"
      description="The equal opportunity questions many US applications ask. Each one is optional."
    >
      <div className="flex flex-col gap-6">
        <Notice tone="info">
          Not answered: TailorIT leaves the question blank for you. Prefer not to say: TailorIT chooses the form&apos;s
          decline option. These answers never go to AI and never reach TailorIT&apos;s logs.
        </Notice>
        <GenderField />
        <SensitiveBooleanField path="sensitive.eeo.hispanicOrLatino" label="Hispanic or Latino" />
        <AnswerField<RaceCategory[]> path="sensitive.eeo.races" label="Race" blank={() => []}>
          {(value, update) => <RacesEditor value={value} update={update} />}
        </AnswerField>
        <div className="sm:max-w-md">
          <TextField
            path="sensitive.eeo.raceSelfDescribed"
            label="Your race in your words"
            maxLength={100}
            hint={'For a form\'s "I prefer to self-describe". Empty: that choice is never taken.'}
          />
        </div>
        <VeteranField />
        <SensitiveBooleanField path="sensitive.eeo.disability" label="Disability" />
        <AnswerField<OrientationValue>
          path="sensitive.eeo.sexualOrientation"
          label="Sexual orientation"
          blank={() => ({ values: [], selfDescribed: '' })}
        >
          {(value, update) => <OrientationEditor value={value} update={update} />}
        </AnswerField>
        <SensitiveBooleanField path="sensitive.eeo.transgender" label="Do you identify as transgender?" />
        <AnswerField<string> path="sensitive.eeo.pronouns" label="Pronouns" blank={() => ''}>
          {() => (
            <div className="sm:max-w-xs">
              <TextField path="sensitive.eeo.pronouns.value" label="Your pronouns" required maxLength={40} placeholder="she/her" />
            </div>
          )}
        </AnswerField>
      </div>
    </Section>
  );
}

/**
 * "Answer these once": the answers the extension never guesses (each country's work authorization and sponsorship,
 * the criminal record, the equal opportunity answers), and which of them the draft still lacks, each linked to its card.
 */
export function OnceChecklistSection() {
  const form = useProfileForm();
  const linkTo = useContext(SectionLinkContext);
  const items = onceChecklist(form.state.draft);
  const answered = items.filter((item) => item.state !== 'not_provided').length;
  return (
    <Section
      id="autofill-answer-once"
      title="Answer these once"
      description="The extension never guesses these and never asks AI about them: it fills each one from your answer here, on every form."
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-5 text-foreground">
          Left empty, a work authorization, sponsorship or criminal record question is left blank for you, and an equal
          opportunity question gets the form&apos;s decline option.
        </p>
        <p className="text-sm leading-5 font-semibold text-foreground" data-once-count="">
          {answered} of {items.length} answered
        </p>
        <ul aria-label="Answer these once" className="flex flex-col divide-y divide-divider-soft rounded-control border border-border">
          {items.map((item) => {
            const missing = item.state === 'not_provided';
            return (
              <li
                key={item.id}
                data-once={item.id}
                data-missing={missing ? 'true' : 'false'}
                className="flex items-center justify-between gap-4 px-4 py-2.5"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  {missing ? (
                    <span aria-hidden="true" className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-control-strong" />
                  ) : (
                    <CheckCircleIcon aria-hidden="true" size={18} weight="fill" className="shrink-0 text-success" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm leading-5 font-medium text-foreground">{item.label}</p>
                    <p className="text-[13px] leading-5 text-foreground">{onceStatus(item)}</p>
                  </div>
                </div>
                {missing && (
                  <a
                    href={`#${item.section}`}
                    aria-label={`Answer: ${item.label}`}
                    onClick={(event) => {
                      if (!linkTo) return;
                      event.preventDefault();
                      linkTo(item.section);
                    }}
                    className="shrink-0 text-sm font-medium text-primary-ink underline underline-offset-2"
                  >
                    Answer
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}

/** A calendar date ("2026-11-30") as the day it names, in local time. */
function dayOf(value: string | null): Date | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function calendarDate(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

function EarliestStartField() {
  const form = useProfileForm();
  const path = 'profile.preferences.earliestStartDate';
  const day = dayOf(form.text(path) || null);
  return (
    <FieldGroup
      label="Earliest start date"
      error={form.error(path)}
      hint={hintOf(form, path, day ? null : 'Empty: the extension leaves the question for you.')}
    >
      <div>
        <DatePickerPopover
          value={day}
          withActions
          aria-label="Earliest start date"
          onValueChange={(next) => form.set(path, next ? calendarDate(next) : null)}
        >
          <Button variant="outline" icon={<CalendarBlankIcon size={16} />} disabled={form.busy}>
            {day ? formatDate(day) : 'Choose a date'}
          </Button>
        </DatePickerPopover>
      </div>
    </FieldGroup>
  );
}

const RELOCATE_CHOICES = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: NOT_PROVIDED, label: NOT_ANSWERED_LABEL },
] as const;

function RelocateField() {
  const form = useProfileForm();
  const path = 'profile.preferences.willingToRelocate';
  const raw = form.read(path);
  const value = raw === 'yes' || raw === 'no' ? raw : NOT_PROVIDED;
  return (
    <Field label="Willing to relocate?" error={form.error(path)} hint={hintOf(form, path, null)}>
      <RadioGroup
        orientation="horizontal"
        disabled={form.busy}
        options={RELOCATE_CHOICES}
        value={value}
        onValueChange={(next) => form.set(path, next === NOT_PROVIDED ? null : next)}
      />
    </Field>
  );
}

function WorkArrangementsField() {
  const form = useProfileForm();
  const path = 'profile.preferences.workArrangements';
  const selected = form.state.draft.profile.preferences.workArrangements;
  return (
    <FieldGroup label="Work arrangements you accept" error={form.errorWithin(path)} hint={hintOf(form, path, null)}>
      <div className="flex flex-wrap gap-2">
        {WORK_ARRANGEMENT_OPTIONS.map((option) => {
          const on = selected.includes(option.value);
          return (
            <Chip
              key={option.value}
              selected={on}
              disabled={form.busy}
              icon={on ? <CheckIcon size={14} weight="bold" /> : undefined}
              onClick={() =>
                form.set(
                  path,
                  WORK_ARRANGEMENT_OPTIONS.map((choice) => choice.value).filter((value) =>
                    value === option.value ? !on : selected.includes(value),
                  ),
                )
              }
            >
              {option.label}
            </Chip>
          );
        })}
      </div>
    </FieldGroup>
  );
}

type ExpectedSalary = Extract<AutofillSensitive['compensation']['expectedSalary'], { state: 'value' }>['value'];

/** The amounts write themselves by key; `value` gives the currency the list must show. */
function SalaryEditor({ value }: { value: ExpectedSalary }) {
  const base = 'sensitive.compensation.expectedSalary.value';
  return (
    <div className="grid gap-5 sm:grid-cols-4">
      <NumberField path={`${base}.min`} label="Minimum" min={1} zeroIsEmpty placeholder="120000" />
      <NumberField path={`${base}.max`} label="Maximum" min={1} placeholder="150000" hint="Empty: no maximum." />
      <SelectField
        path={`${base}.currency`}
        label="Currency"
        options={withCurrent(CURRENCY_OPTIONS, value.currency)}
      />
      <SelectField path={`${base}.period`} label="Per" options={SALARY_PERIOD_OPTIONS} />
    </div>
  );
}

export function OtherQuestionsSection() {
  const form = useProfileForm();
  const country = form.state.draft.profile.contact.address.country;
  return (
    <Section
      id={ONCE_SECTIONS.otherQuestions}
      title="Other application questions"
      description="Answers many forms ask for in the same words."
    >
      <div className="flex flex-col gap-6">
        <div className="grid gap-5 sm:grid-cols-3">
          <EarliestStartField />
          <NumberField path="profile.preferences.noticePeriodWeeks" label="Notice period (weeks)" min={0} max={52} />
          <NumberField path="profile.preferences.travelPercent" label="Travel (% of the time)" min={0} max={100} />
        </div>
        <RelocateField />
        <WorkArrangementsField />
        <SensitiveBooleanField path="sensitive.legal.atLeast18" label="Are you 18 or older?" />
        <SensitiveBooleanField
          path="sensitive.legal.criminalRecord"
          label="Have you ever been convicted of a crime?"
          hint="Used only for questions that ask this. Never sent to AI. Not answered: the extension leaves the question for you."
        />
        <AnswerField<ExpectedSalary>
          path="sensitive.compensation.expectedSalary"
          label="Expected salary"
          blank={() => ({ min: 0, max: null, currency: currencyForCountry(country) ?? 'USD', period: 'year' })}
        >
          {(value) => <SalaryEditor value={value} />}
        </AnswerField>
        <ChipListField
          path="profile.preferences.relocationPlaces"
          label="Places you would relocate to or work from"
          placeholder="Type a city and press Enter"
          max={10}
          maxLength={100}
          hint={'For "Where would you relocate?" and "Which of these locations could you work from?"'}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            path="profile.preferences.referralSource"
            label='Usual answer to "How did you hear about us?"'
            maxLength={100}
            placeholder="LinkedIn"
            hint="Empty: the extension leaves the question for you."
          />
          <SelectField
            path="profile.preferences.referralSourceCategory"
            label="What kind of source that is"
            options={REFERRAL_CATEGORY_OPTIONS}
            emptyLabel="Not said"
            placeholder="Not said"
            hint="For forms that list kinds of sources (Social media, Employee referral...)."
          />
        </div>
      </div>
    </Section>
  );
}

type GovernmentService = Extract<AutofillSensitive['legal']['governmentService'], { state: 'value' }>['value'];
type Clearance = Extract<AutofillSensitive['legal']['clearance'], { state: 'value' }>['value'];

/** A service and the year it ended: its box, then (ticked) the year, empty while it goes on. */
function ServiceEditor({
  value,
  update,
  served,
  year,
  label,
}: {
  value: GovernmentService;
  update: (next: GovernmentService) => void;
  served: 'military' | 'government';
  year: 'militaryEndYear' | 'governmentEndYear';
  label: string;
}) {
  const form = useProfileForm();
  return (
    <div className="flex flex-col gap-3">
      <Checkbox
        label={label}
        checked={value[served]}
        disabled={form.busy}
        onCheckedChange={(checked) => update({ ...value, [served]: checked, ...(checked ? {} : { [year]: null }) })}
      />
      {value[served] && (
        <div className="pl-7 sm:max-w-[200px]">
          <NumberField
            path={`sensitive.legal.governmentService.value.${year}`}
            label="Year it ended"
            min={1940}
            max={2100}
            hint="Empty: you serve now."
          />
        </div>
      )}
    </div>
  );
}

const ACTIVE_CHOICES = [
  { value: 'yes', label: 'Active now' },
  { value: 'no', label: 'Not active' },
  { value: NOT_PROVIDED, label: 'Not said' },
] as const;

function ClearanceEditor({ value, update }: { value: Clearance; update: (next: Clearance) => void }) {
  const form = useProfileForm();
  const base = 'sensitive.legal.clearance.value';
  return (
    <div className="grid gap-5 sm:grid-cols-3">
      <SelectField path={`${base}.level`} label="Level" options={CLEARANCE_LEVEL_OPTIONS} />
      {value.level !== 'none' && (
        <>
          <Field label="Status">
            <Select<string>
              options={ACTIVE_CHOICES}
              value={value.active === null ? NOT_PROVIDED : value.active ? 'yes' : 'no'}
              disabled={form.busy}
              onValueChange={(next) => update({ ...value, active: next === NOT_PROVIDED ? null : next === 'yes' })}
            />
          </Field>
          <SelectField
            path={`${base}.polygraph`}
            label="Polygraph"
            options={POLYGRAPH_OPTIONS}
            emptyLabel="Not said"
            placeholder="Not said"
          />
        </>
      )}
    </div>
  );
}

const MAX_CITIZENSHIPS = 3;

function CitizenshipsEditor({ value, update }: { value: string[]; update: (next: string[]) => void }) {
  const form = useProfileForm();
  const listed = new Set(value);
  const next = ['US', 'CA', 'GB', ...COUNTRY_OPTIONS.map((option) => option.value)].find((code) => !listed.has(code));
  return (
    <div className="flex flex-col gap-3">
      {value.map((country, index) => (
        <div key={index} className="flex items-end gap-3">
          <SelectField
            path={`sensitive.legal.citizenships.value.${index}`}
            label={index === 0 ? 'Citizenship (your country of origin)' : 'Another citizenship'}
            options={withCurrent(COUNTRY_OPTIONS, country).map((option) => ({
              ...option,
              disabled: option.value !== country && listed.has(option.value),
            }))}
            className="min-w-0 flex-1 sm:max-w-xs"
          />
          {value.length > 1 && (
            <IconButton
              label={`Remove ${countryDisplayName(country)}`}
              tooltip="Remove"
              size="sm"
              icon={<TrashIcon size={16} />}
              disabled={form.busy}
              onClick={() => update(value.filter((_, other) => other !== index))}
            />
          )}
        </div>
      ))}
      <div>
        <AddButton
          label="Add a citizenship"
          full={value.length >= MAX_CITIZENSHIPS || !next}
          onAdd={() => next && update([...value, next])}
        />
      </div>
    </div>
  );
}

/**
 * Snapshot round 2 (the extension's, 2026-11-07): the screening questions it answers from these alone, never guessed
 * and never sent to AI: an agreement that restricts the person, U.S. military or government service, relatives at
 * the company, the role's essential functions, a security clearance, citizenships.
 */
export function ScreeningSection() {
  const form = useProfileForm();
  const home = form.state.draft.profile.contact.address.country;
  return (
    <Section
      id={ONCE_SECTIONS.screening}
      title="Screening questions"
      description="Used only for questions that ask exactly this. Never sent to AI. Not answered: the extension leaves the question for you."
    >
      <div className="flex flex-col gap-6">
        <SensitiveBooleanField
          path="sensitive.legal.restrictiveAgreement"
          label="Are you bound by a non-compete, non-solicitation or similar agreement?"
        />
        <SensitiveBooleanField
          path="sensitive.legal.essentialFunctions"
          label="Can you perform a role's essential functions, with or without reasonable accommodation?"
        />
        <AnswerField<GovernmentService>
          path="sensitive.legal.governmentService"
          label="U.S. armed forces or government service"
          blank={() => ({ military: false, militaryEndYear: null, government: false, governmentEndYear: null })}
        >
          {(value, update) => (
            <div className="flex flex-col gap-4">
              <ServiceEditor
                value={value}
                update={update}
                served="military"
                year="militaryEndYear"
                label="I served in the U.S. armed forces"
              />
              <ServiceEditor
                value={value}
                update={update}
                served="government"
                year="governmentEndYear"
                label="I worked for a U.S. federal, state or local government"
              />
            </div>
          )}
        </AnswerField>
        <AnswerField<string[]>
          path="sensitive.legal.relativesAt"
          label="Companies where a relative of yours works"
          blank={() => []}
        >
          {() => (
            <ChipListField
              path="sensitive.legal.relativesAt.value"
              label="Companies"
              placeholder="Type a company and press Enter"
              max={20}
              maxLength={100}
              hint="None listed: no relative of yours works at a company you apply to. No relative's name is kept."
            />
          )}
        </AnswerField>
        <AnswerField<Clearance>
          path="sensitive.legal.clearance"
          label="Security clearance"
          blank={() => ({ level: 'none', active: null, polygraph: null })}
        >
          {(value, update) => <ClearanceEditor value={value} update={update} />}
        </AnswerField>
        <AnswerField<string[]> path="sensitive.legal.citizenships" label="Citizenship" blank={() => [home ?? 'US']}>
          {(value, update) => <CitizenshipsEditor value={value} update={update} />}
        </AnswerField>
      </div>
    </Section>
  );
}

/** The note as a save found it, and its lines (0-based) that state a sensitive answer, which the AI never reads. */
export interface FlaggedNote {
  note: string;
  lines: number[];
}

/** A flagged line as the notice quotes it: trimmed, and cut short past 90 characters. */
function quoted(line: string): string {
  const text = line.trim();
  return text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text;
}

/**
 * "Anything else we should know?": the person's standing note to TailorIT's AI, read beside the profile when it answers
 * a question or writes an answer as the applicant. Lines that state a sensitive answer never reach the AI; the last
 * save's are listed, while the note is as it was saved, so the person can take them out.
 */
export function AnythingElseSection({ flagged }: { flagged: FlaggedNote | null }) {
  const form = useProfileForm();
  const note = form.text('profile.anythingElse');
  const shown = flagged && flagged.lines.length > 0 && flagged.note === note ? flagged : null;
  const lines = shown ? note.split(/\r?\n/) : [];
  return (
    <Section
      title="Anything else we should know?"
      description="TailorIT's AI reads this note when it answers application questions and writes answers for you: what you are looking for, what to stress, how you like to come across. Never put passwords or sensitive details here (work authorization, salary, age, health): those come from your answers above, and a line that states one is left out of what the AI reads."
    >
      <div className="flex flex-col gap-4">
        <TextareaField
          path="profile.anythingElse"
          label="Your note"
          maxLength={AUTOFILL_ANYTHING_ELSE_MAX}
          rows={5}
        />
        {shown && (
          <Notice tone="warning" title="Remove these lines from your note">
            <p>
              They state a sensitive answer, so the AI never reads them. Keep those answers in the questions above
              instead.
            </p>
            <ul className="mt-1.5 list-disc pl-5">
              {shown.lines
                .filter((index) => index >= 0 && index < lines.length)
                .map((index) => (
                  <li key={index}>
                    Line {index + 1}: “{quoted(lines[index] ?? '')}”
                  </li>
                ))}
            </ul>
          </Notice>
        )}
      </div>
    </Section>
  );
}

/** "Senior SRE · PDF". */
function resumeLabel(resume: AutofillResumeList['items'][number]): string {
  return `${resume.label} · ${resume.fileKind.toUpperCase()}`;
}

export function ResumeSection({ resumes }: { resumes: AutofillResumeList | null }) {
  const form = useProfileForm();
  const chosen = form.state.draft.profile.documents.resumeId;
  const options = (resumes?.items ?? []).map((resume) => ({ value: resume.id, label: resumeLabel(resume) }));
  const missing = resumes !== null && chosen !== null && !resumes.items.some((resume) => resume.id === chosen);
  return (
    <Section title="Resume to attach" description="The file the extension uploads where a form asks for a resume.">
      <div className="sm:max-w-md">
        <SelectField
          path="profile.documents.resumeId"
          label="Resume"
          options={withCurrent(options, chosen, () => (resumes ? 'A resume that was deleted' : 'The resume you chose'))}
          emptyLabel="Best match for each job (recommended)"
          hint={
            missing
              ? 'That resume was deleted: the extension uses the best match until you choose another.'
              : 'The best match is the one TailorIT suggests for the job.'
          }
        />
      </div>
    </Section>
  );
}
