'use client';

import type { AutofillEducation, AutofillExperience, AutofillProfile } from '@tailorit/shared/autofill';
import { Field } from '@/components/ui/Field';
import { TrashIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { moved } from '../draft';
import { DEGREE_LEVEL_OPTIONS, LANGUAGE_PROFICIENCY_OPTIONS } from '../options';
import { Section } from '../Section';
import {
  AddButton,
  CheckboxField,
  ChipListField,
  EntryCard,
  FromResumeHint,
  MonthYearField,
  NumberField,
  SelectField,
  TextareaField,
  TextField,
  hintOf,
  newEntryId,
} from './fields';
import { useProfileForm, type ProfileForm } from './form';
import { CountryField, RegionField } from './PersonalSections';

// The contract's caps on the lists.
const MAX_EDUCATION = 10;
const MAX_EXPERIENCE = 30;
const MAX_LANGUAGES = 20;
const MAX_SKILLS = 200;
const MAX_ALIASES = 10;
const MAX_CERTIFICATIONS = 20;

type ListName = 'education' | 'experience' | 'languages' | 'certifications';

/** Changes one of the profile's lists as it stands when the change runs; `clears` loses its messages and marks. */
function changeList<K extends ListName>(
  form: ProfileForm,
  name: K,
  clears: string | null,
  next: (list: AutofillProfile[K]) => AutofillProfile[K],
): void {
  form.dispatch({
    type: 'change',
    clears,
    recipe: (draft) => {
      const profile: AutofillProfile = { ...draft.profile };
      profile[name] = next(draft.profile[name]);
      return { ...draft, profile };
    },
  });
}

function newEducation(): AutofillEducation {
  return {
    id: newEntryId(),
    institution: { canonicalName: '', aliases: [] },
    degree: { level: 'bachelor', type: '', field: '' },
    minor: '',
    startDate: null,
    endDate: null,
    current: false,
    gpa: null,
    location: { city: '', region: '', country: null },
  };
}

function newExperience(): AutofillExperience {
  return {
    id: newEntryId(),
    company: '',
    title: '',
    location: { city: '', region: '', country: null },
    startDate: null,
    endDate: null,
    current: false,
    description: '',
  };
}

/** A place's three fields under `base` ("profile.experience.<id>.location"). */
function PlaceFields({ base }: { base: string }) {
  return (
    <div className="grid gap-5 sm:grid-cols-3">
      <TextField path={`${base}.city`} label="City" maxLength={100} />
      <RegionField path={`${base}.region`} countryPath={`${base}.country`} label="State or region" />
      <CountryField path={`${base}.country`} />
    </div>
  );
}

/** The GPA and its scale: no GPA until a value is typed, which starts on a 4-point scale. */
function GpaFields({ base, gpa }: { base: string; gpa: AutofillEducation['gpa'] }) {
  const form = useProfileForm();
  const key = `${base}.gpa`;
  const number = (text: string) => (text.trim() === '' || Number.isNaN(Number(text)) ? null : Number(text));
  return (
    <div className="grid grid-cols-2 gap-5">
      <Field label="GPA" error={form.error(`${key}.value`)} hint={hintOf(form, key, null)}>
        <Input
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          max={100}
          placeholder="3.8"
          value={gpa?.value ?? ''}
          disabled={form.busy}
          onChange={(event) => {
            const value = number(event.target.value);
            form.set(key, value === null ? null : { value, scale: gpa?.scale ?? 4 });
          }}
        />
      </Field>
      <Field label="Out of" error={form.error(`${key}.scale`)} hint={gpa ? undefined : 'Enter the GPA first.'}>
        <Input
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          max={100}
          placeholder="4"
          value={gpa && gpa.scale > 0 ? gpa.scale : ''}
          disabled={form.busy || !gpa}
          onChange={(event) => gpa && form.set(key, { value: gpa.value, scale: number(event.target.value) ?? 0 })}
        />
      </Field>
    </div>
  );
}

function EducationCard({ entry, position, count }: { entry: AutofillEducation; position: number; count: number }) {
  const form = useProfileForm();
  const base = `profile.education.${entry.id}`;
  const title = entry.institution.canonicalName.trim() || `School ${position + 1}`;
  return (
    <EntryCard
      title={title}
      position={position}
      count={count}
      onMove={(delta) => changeList(form, 'education', null, (list) => moved(list, entry.id, delta))}
      onRemove={() => changeList(form, 'education', base, (list) => list.filter((other) => other.id !== entry.id))}
    >
      <div className="flex flex-col gap-5">
        <TextField
          path={`${base}.institution.canonicalName`}
          label="School"
          required
          maxLength={200}
          hint="Its full official name, such as The University of Texas at Austin."
        />
        <ChipListField
          path={`${base}.institution.aliases`}
          label="Other names for this school"
          placeholder="Type a name and press Enter"
          max={MAX_ALIASES}
          maxLength={200}
          hint="Forms list schools in different ways; these help the extension find yours."
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <SelectField path={`${base}.degree.level`} label="Degree level" options={DEGREE_LEVEL_OPTIONS} />
          <TextField path={`${base}.degree.type`} label="Degree" maxLength={40} placeholder="B.S." />
          <TextField path={`${base}.degree.field`} label="Field of study" maxLength={150} placeholder="Computer Science" />
          <TextField path={`${base}.minor`} label="Minor" maxLength={150} />
          <MonthYearField path={`${base}.startDate`} label="Start" />
          <MonthYearField path={`${base}.endDate`} label={entry.current ? 'Expected graduation' : 'End'} />
        </div>
        <CheckboxField path={`${base}.current`} label="I'm still studying here" />
        <GpaFields base={base} gpa={entry.gpa} />
        <PlaceFields base={`${base}.location`} />
      </div>
    </EntryCard>
  );
}

export function EducationSection() {
  const form = useProfileForm();
  const list = form.state.draft.profile.education;
  return (
    <Section title="Education" description="Most recent first, as on your resume.">
      <div className="flex flex-col gap-4">
        {list.length === 0 && <p className="text-sm text-muted-foreground">No education yet.</p>}
        {list.map((entry, position) => (
          <EducationCard key={entry.id} entry={entry} position={position} count={list.length} />
        ))}
        <div>
          <AddButton
            label="Add education"
            full={list.length >= MAX_EDUCATION}
            onAdd={() => changeList(form, 'education', null, (current) => [...current, newEducation()])}
          />
        </div>
      </div>
    </Section>
  );
}

function ExperienceCard({ entry, position, count }: { entry: AutofillExperience; position: number; count: number }) {
  const form = useProfileForm();
  const base = `profile.experience.${entry.id}`;
  const title = [entry.title.trim(), entry.company.trim()].filter(Boolean).join(' at ') || `Position ${position + 1}`;
  return (
    <EntryCard
      title={title}
      position={position}
      count={count}
      onMove={(delta) => changeList(form, 'experience', null, (list) => moved(list, entry.id, delta))}
      onRemove={() => changeList(form, 'experience', base, (list) => list.filter((other) => other.id !== entry.id))}
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField path={`${base}.company`} label="Company" required maxLength={200} />
          <TextField path={`${base}.title`} label="Title" required maxLength={200} />
        </div>
        <PlaceFields base={`${base}.location`} />
        <div className="grid gap-5 sm:grid-cols-2">
          <MonthYearField path={`${base}.startDate`} label="Start" />
          <MonthYearField path={`${base}.endDate`} label="End" disabled={entry.current} />
        </div>
        <CheckboxField path={`${base}.current`} label="I currently work here" />
        <TextareaField path={`${base}.description`} label="Description" maxLength={4000} rows={5} />
      </div>
    </EntryCard>
  );
}

export function ExperienceSection() {
  const form = useProfileForm();
  const list = form.state.draft.profile.experience;
  return (
    <Section title="Experience" description="Most recent first. Forms that ask about each job get these.">
      <div className="flex flex-col gap-4">
        {list.length === 0 && <p className="text-sm text-muted-foreground">No experience yet.</p>}
        {list.map((entry, position) => (
          <ExperienceCard key={entry.id} entry={entry} position={position} count={list.length} />
        ))}
        <div>
          <AddButton
            label="Add experience"
            full={list.length >= MAX_EXPERIENCE}
            onAdd={() => changeList(form, 'experience', null, (current) => [...current, newExperience()])}
          />
        </div>
      </div>
    </Section>
  );
}

export function LanguagesSkillsSection() {
  const form = useProfileForm();
  const languages = form.state.draft.profile.languages;
  return (
    <Section title="Languages and skills">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3" role="group" aria-label="Languages">
          <p className="text-sm leading-5 font-medium text-foreground">Languages</p>
          {languages.map((row, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-3">
              <TextField path={`profile.languages.${index}.language`} label="Language" required maxLength={60} />
              <SelectField
                path={`profile.languages.${index}.proficiency`}
                label="Proficiency"
                options={LANGUAGE_PROFICIENCY_OPTIONS}
                emptyLabel="Not set"
                placeholder="Not set"
              />
              <IconButton
                label={`Remove ${row.language.trim() || 'this language'}`}
                tooltip="Remove"
                icon={<TrashIcon size={16} />}
                className="mt-6.5"
                disabled={form.busy}
                onClick={() =>
                  changeList(form, 'languages', 'profile.languages', (list) => list.filter((_, other) => other !== index))
                }
              />
            </div>
          ))}
          {form.isFromResume('profile.languages') && (
            <p className="text-[13px] leading-5">
              <FromResumeHint />
            </p>
          )}
          <div>
            <AddButton
              label="Add language"
              full={languages.length >= MAX_LANGUAGES}
              onAdd={() => changeList(form, 'languages', null, (list) => [...list, { language: '', proficiency: null }])}
            />
          </div>
        </div>
        <ChipListField
          path="profile.skills"
          label="Skills"
          placeholder="Type a skill and press Enter"
          max={MAX_SKILLS}
          maxLength={80}
        />
      </div>
    </Section>
  );
}

/** Snapshot round 2: the person's certifications ("Do you hold any industry related certifications?"). */
export function CertificationsSection() {
  const form = useProfileForm();
  const certifications = form.state.draft.profile.certifications;
  return (
    <Section
      title="Certifications"
      description="For forms that ask which certifications you hold."
    >
      <div className="flex flex-col gap-3" role="group" aria-label="Certifications">
        {certifications.map((row, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_100px_auto] items-start gap-3"
          >
            <TextField
              path={`profile.certifications.${index}.name`}
              label="Certification"
              required
              maxLength={150}
              placeholder="Certified Kubernetes Administrator"
            />
            <TextField path={`profile.certifications.${index}.issuer`} label="Issued by" maxLength={150} />
            <NumberField path={`profile.certifications.${index}.year`} label="Year" min={1950} max={2100} />
            <IconButton
              label={`Remove ${row.name.trim() || 'this certification'}`}
              tooltip="Remove"
              icon={<TrashIcon size={16} />}
              className="mt-6.5"
              disabled={form.busy}
              onClick={() =>
                changeList(form, 'certifications', 'profile.certifications', (list) =>
                  list.filter((_, other) => other !== index),
                )
              }
            />
          </div>
        ))}
        <div>
          <AddButton
            label="Add certification"
            full={certifications.length >= MAX_CERTIFICATIONS}
            onAdd={() =>
              changeList(form, 'certifications', null, (list) => [...list, { name: '', issuer: '', year: null }])
            }
          />
        </div>
      </div>
    </Section>
  );
}
