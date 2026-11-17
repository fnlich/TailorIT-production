import type { ResumeDocument } from '@tailorit/shared/resume';
import { headingBoxId, type EntryView, type RichView, type SectionView, type TextView } from '@tailorit/resume-templates';
import { PLACEHOLDER_ENTRY_ID, fieldLabel } from '../store/paths';
import { selectionOfEntry, selectionOfPath } from '../toolbars/selection';
import { editView, entryTools, sectionName, sectionTools } from '../toolbars/tools';
import type { FocusTarget } from '../toolbars/useToolbarCommands';

// The phone editor's parts of the page, worked out from the page's data attributes and the document alone (pure,
// node-tested): what a tap on a box is (the header, a section's title, its summary or skills, one entry), what its
// sheet offers, and which fields its full-screen form shows, in the order the page prints them.

export type PhonePart =
  | { type: 'header' }
  /** A section's title (or the copy of it a later page repeats). */
  | { type: 'title'; ref: string }
  /** The body of a section with no entries: the summary, the skills, the soft skills, the interests. */
  | { type: 'content'; ref: string }
  | {
      type: 'entry';
      ref: string;
      /** The entry list: `experience`, `customSections.<key>.entries`. */
      list: string;
      id: string;
      path: string;
      /** The row an empty section shows; it is not in the document until a field of it is written. */
      placeholder: boolean;
    };

/** What a box of the page says about itself (ResumeLayout's data attributes). */
export interface BoxAttributes {
  /** `data-rt-box`: `header`, `h:<ref>` for a title, another id for the rest; null for a title a later page repeats. */
  box: string | null;
  /** `data-rt-entry` of the box, or of one cell of a row. */
  entry: string | null;
  /** `data-rt-section` of the section the box is in. */
  section: string | null;
}

/** What tapping a box opens; null for a box that is no part (nothing to edit there). */
export function partOf({ box, entry, section }: BoxAttributes): PhonePart | null {
  if (box === 'header') return { type: 'header' };
  if (entry) {
    const selection = selectionOfEntry(entry);
    if (selection) {
      const { ref, list, id, path, placeholder } = selection;
      return { type: 'entry', ref, list, id, path, placeholder };
    }
  }
  if (!section) return null;
  if (box === null || box === headingBoxId(section)) return { type: 'title', ref: section };
  return { type: 'content', ref: section };
}

/** One string per part (the tap targets' `data-phone-part`). */
export function partKey(part: PhonePart): string {
  return part.type === 'header' ? 'header' : part.type === 'entry' ? `entry:${part.path}` : `${part.type}:${part.ref}`;
}

/** The part the toolbars' commands mean when they ask for the caret somewhere (a removal moving on, say). */
export function partOfFocus(target: FocusTarget): PhonePart | null {
  if (target.kind === 'section') return { type: 'title', ref: target.ref };
  const selection = target.kind === 'entry' ? selectionOfEntry(target.path) : selectionOfPath(target.path);
  if (!selection) return null;
  if (selection.type === 'header') return { type: 'header' };
  if (selection.type === 'section') return { type: 'title', ref: selection.ref };
  const { ref, list, id, path, placeholder } = selection;
  return { type: 'entry', ref, list, id, path, placeholder };
}

function sectionOf(document: ResumeDocument, ref: string): SectionView | undefined {
  return editView(document).sections.find((section) => section.ref === ref);
}

/** The entry at `path` as the page draws it (the empty row of a section with none too); null when it is not there. */
export function entryViewOf(document: ResumeDocument, path: string): EntryView | null {
  const selection = selectionOfEntry(path);
  const body = selection ? sectionOf(document, selection.ref)?.body : undefined;
  return body?.type === 'entries' ? (body.entries.find((entry) => entry.path === path) ?? null) : null;
}

/**
 * The part as it is now: the empty row of a section becomes a real entry once a field of it is written (the first and
 * only entry of its list), and a part that has left the page is null.
 */
export function livePart(document: ResumeDocument, part: PhonePart): PhonePart | null {
  if (part.type === 'header') return part;
  if (part.type !== 'entry') return sectionOf(document, part.ref) ? part : null;
  if (entryViewOf(document, part.path)) return part;
  if (!part.placeholder) return null;
  const body = sectionOf(document, part.ref)?.body;
  const first = body?.type === 'entries' ? body.entries[0] : undefined;
  if (!first || first.placeholder) return null;
  return { ...part, id: first.id, path: first.path, placeholder: false };
}

/** The entry right after `afterId` in its list (the one "Add entry" has just put there), or null. */
export function entryAfter(document: ResumeDocument, ref: string, afterId: string): string | null {
  const body = sectionOf(document, ref)?.body;
  if (body?.type !== 'entries') return null;
  const at = body.entries.findIndex((entry) => entry.id === afterId);
  return at < 0 ? null : (body.entries[at + 1]?.path ?? null);
}

/** Where a section is among the sections on show in its column ("Move up" and "Move down"). */
export function sectionPlace(document: ResumeDocument, ref: string): { index: number; count: number } {
  const sections = editView(document).sections;
  const column = sections.find((section) => section.ref === ref)?.column;
  const shown = sections.filter((section) => section.column === column);
  return { index: shown.findIndex((section) => section.ref === ref), count: shown.length };
}

/** What a part's tap target is called. */
export function partLabel(document: ResumeDocument, part: PhonePart): string {
  if (part.type === 'header') return 'Header';
  const section = sectionName(document, part.ref);
  if (part.type === 'title') return `${section} section title`;
  if (part.type === 'content') return `${section} section`;
  return `${entryTools(document, part.path)?.name ?? section}, ${section}`;
}

// ------------------------------------------------------------------------------------------------ the sheet

export type SheetActionId = 'edit' | 'editTitle' | 'addEntry' | 'moveUp' | 'moveDown' | 'delete' | 'removeSection';

export interface SheetAction {
  id: SheetActionId;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
}

export interface PartSheet {
  title: string;
  description: string | null;
  actions: SheetAction[];
}

/** What a part's sheet offers; null for a part that is no longer on the page. */
export function sheetOf(document: ResumeDocument, part: PhonePart): PartSheet | null {
  if (part.type === 'header') return { title: 'Header', description: null, actions: [{ id: 'edit', label: 'Edit' }] };
  if (part.type === 'entry') {
    const tools = entryTools(document, part.path);
    if (!tools) return null;
    const actions: SheetAction[] = [
      { id: 'edit', label: 'Edit' },
      { id: 'moveUp', label: 'Move up', disabled: !tools.canMoveUp },
      { id: 'moveDown', label: 'Move down', disabled: !tools.canMoveDown },
    ];
    if (tools.canDelete) actions.push({ id: 'delete', label: 'Delete', destructive: true });
    return { title: tools.name, description: sectionName(document, part.ref), actions };
  }
  const tools = sectionTools(document, part.ref);
  if (!tools) return null;
  if (part.type === 'content') return { title: tools.name, description: null, actions: [{ id: 'edit', label: 'Edit' }] };
  const place = sectionPlace(document, part.ref);
  const actions: SheetAction[] = [{ id: 'editTitle', label: 'Edit title' }];
  if (tools.adds.includes('entry')) actions.push({ id: 'addEntry', label: 'Add entry' });
  actions.push(
    { id: 'moveUp', label: 'Move up', disabled: place.index <= 0 },
    { id: 'moveDown', label: 'Move down', disabled: place.index < 0 || place.index >= place.count - 1 },
    { id: 'removeSection', label: 'Remove section', destructive: true },
  );
  return { title: tools.name, description: 'Section title', actions };
}

// ------------------------------------------------------------------------------------------------ the forms

/** One field of a full-screen form. `key` stays the same while the empty row becomes an entry, so focus stays put. */
export type FormField =
  | { type: 'text'; key: string; path: string; label: string; placeholder: string }
  | { type: 'date'; key: string; path: string; label: string; placeholder: string; text: string }
  | { type: 'rich'; key: string; field: RichView; label: string }
  | { type: 'bullets'; key: string; bullets: RichView[]; label: string }
  | { type: 'level'; key: string; path: string; value: number | null; label: string };

const textField = (key: string, view: TextView): FormField => ({
  type: 'text',
  key,
  path: view.path,
  label: fieldLabel(view.path) || view.placeholder,
  placeholder: view.placeholder,
});

/** The fields of an entry that it shows, in the order the page prints them. */
export function entryFormFields(entry: EntryView): FormField[] {
  const out: FormField[] = [];
  if (entry.title) out.push(textField('title', entry.title));
  if (entry.level) {
    // A language: its name, the proficiency label, then the dots.
    if (entry.level.label) out.push(textField('levelLabel', entry.level.label));
    out.push({ type: 'level', key: 'level', path: entry.path, value: entry.level.value, label: 'Level' });
  }
  if (entry.subtitle) out.push(textField('subtitle', entry.subtitle));
  if (entry.date) {
    const { path, text, placeholder } = entry.date;
    out.push({ type: 'date', key: 'date', path, text, placeholder, label: fieldLabel(path) || placeholder });
  }
  if (entry.location) out.push(textField('location', entry.location));
  if (entry.link) out.push(textField('link', entry.link));
  for (const detail of entry.details) out.push(textField(`detail:${detail.path.split('.').at(-1)}`, detail));
  if (entry.description) {
    const label = fieldLabel(entry.description.path) || entry.description.placeholder;
    out.push({ type: 'rich', key: 'description', field: entry.description, label });
  }
  if (entry.bullets.length > 0) out.push({ type: 'bullets', key: 'bullets', bullets: entry.bullets, label: 'Bullets' });
  return out;
}

/** The header's fields that it shows: the name, the title, then each contact in the order it prints. */
export function headerFormFields(document: ResumeDocument): FormField[] {
  const header = editView(document).header;
  const out = [textField('name', header.name)];
  if (header.title) out.push(textField('title', header.title));
  for (const contact of header.contacts) out.push(textField(contact.field, contact));
  return out;
}

/** One list of chips in a content form: a skill group (its name too, when names show), or a chip section's list. */
export interface ChipGroup {
  key: string;
  /** The skill group's index; null for the skills in no group and for soft skills and interests. */
  group: number | null;
  name: TextView | null;
  /** Where a new chip goes: `skills`, `skillCategories.<n>.skills`, `softSkills`, `interests`. */
  list: string;
  /** Without the empty chip a list with none shows. */
  chips: TextView[];
}

/** The chip lists of a skills, soft skills or interests section, as the page draws them; [] for any other. */
export function chipGroupsOf(document: ResumeDocument, ref: string): ChipGroup[] {
  const body = sectionOf(document, ref)?.body;
  const real = (chips: readonly TextView[]) => chips.filter((chip) => chip.text !== '');
  if (body?.type === 'chips') return [{ key: ref, group: null, name: null, list: ref, chips: real(body.chips) }];
  if (body?.type !== 'skills') return [];
  return body.groups.map((group, index) => {
    const match = group.name ? /^skillCategories\.(\d+)\.category$/.exec(group.name.path) : null;
    const at = match ? Number(match[1]) : null;
    return {
      key: at === null ? `loose:${index}` : `group:${at}`,
      group: at,
      name: group.name,
      list: at === null ? 'skills' : `skillCategories.${at}.skills`,
      chips: real(group.skills),
    };
  });
}

/** What a full-screen form is called (it keeps the name while its fields change). */
export function formTitle(document: ResumeDocument, part: PhonePart): string {
  if (part.type === 'header') return 'Edit header';
  if (part.type === 'title') return 'Edit section title';
  if (part.type === 'content') return `Edit ${sectionName(document, part.ref)}`;
  return `Edit ${entryTools(document, part.path)?.noun ?? 'entry'}`;
}

/** The empty row's path in a list (`experience.new`). */
export const placeholderPath = (list: string) => `${list}.${PLACEHOLDER_ENTRY_ID}`;
