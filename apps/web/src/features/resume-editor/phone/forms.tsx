'use client';

import { clsx } from 'clsx';
import { useId, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import type { RichView, TextView } from '@tailorit/resume-templates';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Field } from '@/components/ui/Field';
import { IconButton } from '@/components/ui/IconButton';
import { PlusIcon, TrashIcon } from '@/components/ui/icons';
import { CONTROL_SURFACE, Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useToast } from '@/components/ui/Toast';
import { DatePickerPopover, type DateTarget } from '../dates/DatePickerPopover';
import { ChipList } from '../parts';
import { FieldBridgeContext } from '../fields/bridge';
import { EDIT_SLOTS } from '../fields/fields';
import { PhotoDialog } from '../photo/PhotoDialog';
import { valueAt } from '../store/actions';
import { headingPath, retargetEntry } from '../store/paths';
import { YearsField } from '../toolbars/HeaderToolbar';
import { ChipAddForm } from '../toolbars/skillLibrary';
import { editView, entryTools, headerTools, sectionTools } from '../toolbars/tools';
import type { ToolbarCommands } from '../toolbars/useToolbarCommands';
import { dateTargetOf, type EditorSession } from '../workspace/useEditorSession';
import {
  chipGroupsOf,
  entryFormFields,
  entryViewOf,
  formTitle,
  headerFormFields,
  livePart,
  type ChipGroup,
  type FormField,
  type PhonePart,
} from './parts';
import { FullScreenForm } from './sheets';

// A part's full-screen form on a phone: every part of it the page shows, labelled, in the order it prints. Plain
// parts are text inputs, the description and the bullets the page's own rich fields (the same bridge, so Ctrl+B, I
// and U, Enter splitting a bullet and pasting work as on the page), dates the page's picker, a language's level its
// dots, and the entry's Settings at the bottom (its "Show ..." toggles, a role's Skills used; the header's toggles, its
// photo and the years of experience). Every change goes through the store as it is typed, so autosave, Undo and the
// live region work as on a desktop, and Done only closes the form.

const LABEL = 'text-sm leading-5 font-medium text-foreground';

/** A rich field drawn as a text box, its placeholder shown while it is empty. */
const RICH_BOX = clsx(
  CONTROL_SURFACE,
  'block min-h-9 w-full min-w-0 px-3 py-[7px] leading-5',
  'data-empty:before:pointer-events-none data-empty:before:text-subtle-foreground',
  'data-empty:before:content-[attr(data-placeholder)]',
);

/** What a plain field's keyboard and autofill should be on a phone. */
const INPUT_HINTS: Readonly<Record<string, Pick<ComponentPropsWithoutRef<'input'>, 'inputMode' | 'autoComplete'>>> = {
  name: { autoComplete: 'name' },
  email: { inputMode: 'email', autoComplete: 'email' },
  phone: { inputMode: 'tel', autoComplete: 'tel' },
  linkedin: { inputMode: 'url', autoComplete: 'url' },
  github: { inputMode: 'url', autoComplete: 'url' },
  portfolio: { inputMode: 'url', autoComplete: 'url' },
  link: { inputMode: 'url', autoComplete: 'url' },
};

interface FormProps {
  session: EditorSession;
  commands: ToolbarCommands;
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <p id={id} className={LABEL}>
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * A text input's value, written to the store at every key. The page draws each change in the background (the store
 * says it was typing), and an input held to that draw would take the key back until the draw lands, losing the keys
 * typed meanwhile: so the input shows what was typed at once, and takes the drawn `text` only when the draw holds the
 * store's own value at `path` (an Undo, a change made elsewhere), never a draw the typing has overtaken.
 */
function useTypedText(session: EditorSession, path: string, stored: unknown, text: string): [string, (value: string) => void] {
  const [shown, setShown] = useState(text);
  const [drawn, setDrawn] = useState({ path, text });
  if (drawn.path !== path || drawn.text !== text) {
    setDrawn({ path, text });
    if (Object.is(session.store.select(path), stored)) setShown(text);
  }
  const type = (value: string) => {
    setShown(value);
    session.store.setText(path, value);
  };
  return [shown, type];
}

/** A plain part: the stored text as typed (the page's view trims it), written to the store at every key. */
function TextField({ field, session }: { field: Extract<FormField, { type: 'text' }>; session: EditorSession }) {
  const stored = valueAt(session.document, field.path);
  const [value, type] = useTypedText(session, field.path, stored, typeof stored === 'string' ? stored : '');
  return (
    <Field label={field.label}>
      <Input
        value={value}
        placeholder={field.placeholder}
        onFocus={() => session.bridge.focusField(field.path)}
        onChange={(event) => type(event.target.value)}
        {...INPUT_HINTS[field.key]}
      />
    </Field>
  );
}

function RichField({ label, field }: { label: string; field: RichView }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <p id={id} className={LABEL}>
        {label}
      </p>
      <EDIT_SLOTS.RichText field={field} as="div" className={RICH_BOX} />
    </div>
  );
}

function BulletsField({ label, bullets, session }: { label: string; bullets: RichView[]; session: EditorSession }) {
  const id = useId();
  const last = bullets.at(-1);
  const lastMarkup = last ? valueAt(session.document, last.path) : undefined;
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <p id={id} className={LABEL}>
        {label}
      </p>
      <ul className="flex flex-col gap-2">
        {bullets.map((bullet, index) => (
          <li key={index} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-4 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
            <EDIT_SLOTS.RichText field={bullet} as="div" className={RICH_BOX} />
          </li>
        ))}
      </ul>
      <p className="text-[13px] leading-5 text-muted-foreground">Enter starts a new bullet.</p>
      {last && typeof lastMarkup === 'string' && lastMarkup.trim() !== '' ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            icon={<PlusIcon size={14} weight="bold" />}
            // Enter at the end of the last bullet: a new one after it, the caret in it.
            onClick={() => session.bridge.splitBullet(last.path, lastMarkup, '')}
          >
            Add bullet
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DateField({ field, onOpen }: { field: Extract<FormField, { type: 'date' }>; onOpen(anchor: HTMLElement): void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <p id={id} className={LABEL}>
        {field.label}
      </p>
      <button
        type="button"
        aria-label={`${field.label}: ${field.text || 'not set'}`}
        aria-haspopup="dialog"
        className={clsx(CONTROL_SURFACE, 'flex h-9 w-full items-center px-3 text-left')}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        {field.text ? field.text : <span className="text-subtle-foreground">{field.placeholder}</span>}
      </button>
    </div>
  );
}

function LevelField({ field }: { field: Extract<FormField, { type: 'level' }> }) {
  return (
    <div className="flex flex-col gap-2">
      <p className={LABEL}>{field.label}</p>
      <div
        className={clsx(
          '[&_.rt-level]:flex [&_.rt-level]:gap-3 [&_.rt-dot]:block [&_.rt-dot]:size-7 [&_.rt-dot]:rounded-full',
          '[&_.rt-dot]:bg-control-strong [&_.rt-dot.rt-dot-on]:bg-primary [&_.rt-dot]:outline-none',
          '[&_.rt-dot:focus-visible]:ring-2 [&_.rt-dot:focus-visible]:ring-primary [&_.rt-dot:focus-visible]:ring-offset-2',
        )}
      >
        <EDIT_SLOTS.Level path={field.path} value={field.value} />
      </div>
    </div>
  );
}

function EntryForm({ path, session, commands }: FormProps & { path: string }) {
  const document = session.document;
  const [date, setDate] = useState<DateTarget | null>(null);
  const entry = entryViewOf(document, path);
  const tools = entryTools(document, path);
  const roleSkills = tools?.roleSkills ?? null;
  if (!entry) return null;
  // The picker writes where the entry is now: the empty row becomes a real entry at its first write.
  const target = date ? { ...date, path: retargetEntry(date.path, entry.id) } : null;
  return (
    <div className="flex flex-col gap-5">
      {entryFormFields(entry).map((field) => {
        switch (field.type) {
          case 'text':
            return <TextField key={field.key} field={field} session={session} />;
          case 'date':
            return (
              <DateField
                key={field.key}
                field={field}
                onOpen={(anchor) => setDate(dateTargetOf(field.path, session.store.select(field.path), anchor))}
              />
            );
          case 'rich':
            return <RichField key={field.key} label={field.label} field={field.field} />;
          case 'bullets':
            return <BulletsField key={field.key} label={field.label} bullets={field.bullets} session={session} />;
          case 'level':
            return <LevelField key={field.key} field={field} />;
        }
      })}
      {tools && tools.toggles.length > 0 ? (
        <Group label="Fields">
          {tools.toggles.map((toggle) => (
            <Checkbox
              key={toggle.key}
              label={toggle.label}
              checked={toggle.shown}
              onCheckedChange={(shown) => commands.setEntryField(tools, toggle.key, shown)}
            />
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={tools.count < 2}
            onClick={() => commands.applyFieldsToSection(tools)}
          >
            Apply to all in this section
          </Button>
        </Group>
      ) : null}
      {tools && roleSkills ? (
        // A role's "Skills used", as in its Settings on the page.
        <Group label="Skills used">
          <p className="text-[13px] leading-5 text-muted-foreground">Not printed. Each skill also joins your Technical skills.</p>
          <ChipAddForm
            label="Add a skill used in this role"
            placeholder="e.g. Kubernetes"
            suggest
            onAdd={(text) => commands.addRoleSkill(tools, text)}
          />
          <ChipList
            label="Skills used in this role"
            items={roleSkills}
            onRemove={(skill) => commands.removeRoleSkill(tools, roleSkills.indexOf(skill))}
          />
        </Group>
      ) : null}
      <DatePickerPopover
        target={target}
        onPeriod={(at, period) => {
          session.date.onPeriod(at, period);
          setDate((current) => (current?.kind === 'range' ? { ...current, period } : current));
        }}
        onDate={(at, picked) => {
          session.date.onDate(at, picked);
          setDate((current) => (current?.kind === 'single' ? { ...current, date: picked ?? undefined } : current));
        }}
        onClose={() => setDate(null)}
      />
    </div>
  );
}

function HeaderForm({ session, commands }: FormProps) {
  const document = session.document;
  const tools = headerTools(document);
  const [photoOpen, setPhotoOpen] = useState(false);
  const photo = tools.photo;
  return (
    <div className="flex flex-col gap-5">
      {headerFormFields(document).map((field) =>
        field.type === 'text' ? <TextField key={field.key} field={field} session={session} /> : null,
      )}
      {photo ? (
        <Group label="Photo">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setPhotoOpen(true)}>
              {photo.present ? 'Replace photo' : 'Add photo'}
            </Button>
            {photo.present ? (
              <Button variant="ghost" size="sm" onClick={commands.hidePhoto}>
                Hide photo
              </Button>
            ) : null}
          </div>
          {photo.present ? (
            <SegmentedControl
              aria-label="Photo shape"
              size="sm"
              value={photo.shape}
              onValueChange={commands.setPhotoShape}
              items={[
                { value: 'round', label: 'Round' },
                { value: 'square', label: 'Square' },
              ]}
            />
          ) : null}
        </Group>
      ) : null}
      <Group label="Show">
        {tools.toggles.map((toggle) => (
          <Checkbox
            key={toggle.key}
            label={toggle.label}
            checked={toggle.shown}
            onCheckedChange={(shown) => commands.setHeaderField(toggle.key, toggle.label, shown)}
          />
        ))}
        <Checkbox label="Name in capitals" checked={tools.uppercaseName} onCheckedChange={commands.setUppercaseName} />
      </Group>
      <Group label="Years of experience">
        <YearsField years={tools.years} onChange={commands.setYears} />
        <p className="text-[13px] leading-5 text-muted-foreground">Not printed. Write with AI pitches your bullets to it.</p>
      </Group>
      <PhotoDialog open={photoOpen} onClose={() => setPhotoOpen(false)} onAccepted={session.photo.accept} />
    </div>
  );
}

/** A section's title; a blank one shows the template's name for it, as on the page. */
function TitleForm({ sectionRef, session }: { sectionRef: string; session: EditorSession }) {
  const path = headingPath(sectionRef);
  const heading = editView(session.document).sections.find((section) => section.ref === sectionRef)?.heading;
  if (!path || !heading) return null;
  return <TitleInput path={path} heading={heading} session={session} />;
}

function TitleInput({ path, heading, session }: { path: string; heading: TextView; session: EditorSession }) {
  const stored = valueAt(session.document, path);
  const [value, type] = useTypedText(session, path, stored, typeof stored === 'string' ? stored : heading.text);
  return (
    <Field label="Section title">
      <Input
        value={value}
        placeholder={heading.placeholder}
        onFocus={() => session.bridge.focusField(path)}
        onChange={(event) => type(event.target.value)}
      />
    </Field>
  );
}

/** One chip, renamed when it is committed (leaving it, or Enter), as the store wants a chip written. */
function ChipRow({ chip, noun, session }: { chip: TextView; noun: string; session: EditorSession }) {
  const toast = useToast();
  const [draft, setDraft] = useState(chip.text);
  const commit = () => {
    if (draft === chip.text) return;
    const result = session.store.renameChip(chip.path, draft);
    if (result.duplicate) {
      toast.info(`${draft.trim()} is already on the list`);
      setDraft(chip.text);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={noun}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
      />
      <IconButton
        label={`Remove ${chip.text}`}
        icon={<TrashIcon size={16} />}
        tooltip={false}
        onClick={() => {
          session.store.removeChip(chip.path);
          session.announce(`Removed ${chip.text}`);
        }}
      />
    </div>
  );
}

function ChipGroupFields({
  group,
  noun,
  suggest,
  session,
  commands,
}: FormProps & { group: ChipGroup; noun: string; suggest: boolean }) {
  const { name, group: index } = group;
  const stored = name ? valueAt(session.document, name.path) : undefined;
  return (
    <div className="flex flex-col gap-3">
      {name && index !== null ? (
        <Field label="Group name">
          <Input
            value={typeof stored === 'string' ? stored : ''}
            placeholder={name.placeholder}
            onFocus={() => session.bridge.focusField(name.path)}
            onChange={(event) => session.store.renameGroup(index, event.target.value)}
          />
        </Field>
      ) : null}
      {group.chips.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={name?.text ? `${name.text}: ${noun}s` : `${noun}s`}>
          {group.chips.map((chip) => (
            // A chip's text in its key: a rename or removal (which moves the ones after it) starts its row afresh.
            <li key={`${chip.path}:${chip.text}`}>
              <ChipRow chip={chip} noun={noun} session={session} />
            </li>
          ))}
        </ul>
      ) : null}
      <ChipAddForm
        label={name?.text ? `Add a ${noun.toLowerCase()} to ${name.text}` : `Add a ${noun.toLowerCase()}`}
        placeholder={noun === 'Interest' ? 'e.g. Chess' : 'e.g. TypeScript'}
        suggest={suggest}
        onAdd={(text) => commands.addChip(group.list, text)}
      />
    </div>
  );
}

/** The summary's text, or a skills, soft skills or interests section's chips (and the skill groups). */
function ContentForm({ sectionRef, session, commands }: FormProps & { sectionRef: string }) {
  const document = session.document;
  const body = editView(document).sections.find((section) => section.ref === sectionRef)?.body;
  if (body?.type === 'summary') return <RichField label="Summary" field={body.text} />;
  const noun = sectionTools(document, sectionRef)?.chipNoun || 'Skill';
  return (
    <div className="flex flex-col gap-6">
      {chipGroupsOf(document, sectionRef).map((group) => (
        <ChipGroupFields
          key={group.key}
          group={group}
          noun={noun}
          // Technical skills come with the skill library's suggestions, as on the page.
          suggest={sectionRef === 'skills'}
          session={session}
          commands={commands}
        />
      ))}
      {sectionRef === 'skills' ? (
        <div>
          <Button variant="outline" size="sm" icon={<PlusIcon size={14} weight="bold" />} onClick={commands.addGroup}>
            Add group
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface PartFormProps extends FormProps {
  part: PhonePart;
  open: boolean;
  onOpenChange(open: boolean): void;
  onClosed(): void;
}

/** The full-screen form of the part that was tapped (an empty row followed as it becomes an entry). */
export function PartForm({ part, open, onOpenChange, onClosed, session, commands }: PartFormProps) {
  const [title] = useState(() => formTitle(session.document, part));
  const live = livePart(session.document, part);
  let body: ReactNode;
  if (!live) body = <p className="text-sm text-muted-foreground">This part is no longer on the resume.</p>;
  else if (live.type === 'entry') body = <EntryForm path={live.path} session={session} commands={commands} />;
  else if (live.type === 'header') body = <HeaderForm session={session} commands={commands} />;
  else if (live.type === 'title') body = <TitleForm sectionRef={live.ref} session={session} />;
  else body = <ContentForm sectionRef={live.ref} session={session} commands={commands} />;
  return (
    <FullScreenForm open={open} onOpenChange={onOpenChange} onClosed={onClosed} title={title}>
      <FieldBridgeContext.Provider value={session.bridge}>{body}</FieldBridgeContext.Provider>
    </FullScreenForm>
  );
}
