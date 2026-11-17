import {
  CUSTOM_SECTION_SPEC,
  ENTRY_TOGGLES,
  HEADER_TOGGLES,
  SECTION_KIND_BY_ID,
  SKILLS_LAYOUTS,
  TAG_BORDERS,
  effectiveLayout,
  isFieldShown,
  isHeaderFieldShown,
  parseSectionRef,
  withPositionalEntryIds,
  type EntryBulletsKind,
  type HeaderField,
  type HeaderPhotoShape,
  type ResumeDocument,
  type ToggleKind,
} from '@tailorit/shared/resume';
import { DEFAULT_CUSTOM_HEADING, DEFAULT_SECTION_HEADINGS, type ResumeView } from '@tailorit/resume-templates';
import { viewOf } from '../pages/views';
import { PLACEHOLDER_ENTRY_ID, entryOfPath, hasBullets, toggleKindOf } from '../store/paths';
import { selectionOfEntry } from './selection';

// What each toolbar offers, worked out from the document alone (pure, node-tested): an entry's moves, Write with AI
// and field toggles, a section's add buttons and settings, the header's toggles and photo. The names the toolbars
// read out ("Move Staff Engineer up") are the ones the page shows.

/** The edit view of a document, worked out once per document (the page and the toolbars ask for the same one). */
export function editView(document: ResumeDocument): ResumeView {
  return viewOf(document, 'edit');
}

type Entry = Record<string, unknown> & { id?: string };

/** The entries of a list as the page draws them (a legacy row answers to its positional id). */
function entriesOf(document: ResumeDocument, list: string): readonly Entry[] {
  const numbered = withPositionalEntryIds(document);
  if (list.startsWith('customSections.')) {
    const key = list.split('.')[1];
    return (numbered.customSections?.find((section) => section.key === key)?.entries ?? []) as readonly Entry[];
  }
  const entries: unknown = numbered[list as keyof ResumeDocument];
  return Array.isArray(entries) ? (entries as readonly Entry[]) : [];
}

/** The fields that name an entry of each kind, the main one first. */
const NAME_FIELDS: Readonly<Record<ToggleKind, readonly string[]>> = {
  experience: ['title', 'company'],
  strengths: ['title'],
  education: ['degree', 'institution'],
  certifications: ['name', 'issuer'],
  projects: ['name', 'role'],
  languages: ['language'],
  awards: ['title', 'issuer'],
  publications: ['title', 'publisher'],
  volunteering: ['role', 'organization'],
  courses: ['name', 'institution'],
  references: ['name', 'company'],
  custom: ['heading', 'subheading'],
};

const nounOf = (kind: ToggleKind) => (kind === 'custom' ? CUSTOM_SECTION_SPEC : SECTION_KIND_BY_ID[kind]).entryNoun;
const capitalised = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** What an entry is called: its title (a role, a degree), else "Experience 2"; "New experience" for the empty row. */
export function entryName(kind: ToggleKind, entry: object | undefined, index: number): string {
  const values = (entry ?? {}) as Record<string, unknown>;
  for (const field of NAME_FIELDS[kind]) {
    const value = values[field];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/<[^>]*>/g, '');
  }
  return index < 0 ? `New ${nounOf(kind)}` : `${capitalised(nounOf(kind))} ${index + 1}`;
}

/** What a section is called on the page: its own title, or the template's heading for its kind. */
export function sectionName(document: ResumeDocument, ref: string): string {
  const parsed = parseSectionRef(ref);
  if (!parsed) return 'Section';
  if (parsed.kind === 'custom') {
    return document.customSections?.find((section) => section.key === parsed.key)?.title.trim() || DEFAULT_CUSTOM_HEADING;
  }
  const heading = effectiveLayout(document).find((item) => item.ref === ref)?.heading?.trim();
  return heading || DEFAULT_SECTION_HEADINGS[parsed.kind];
}

// ------------------------------------------------------------------------------------------------ entries

export interface EntryToggleState {
  key: string;
  /** "Show company". */
  label: string;
  shown: boolean;
}

export interface EntryTools {
  path: string;
  list: string;
  id: string;
  /** The section it is in. */
  ref: string;
  kind: ToggleKind;
  name: string;
  /** "experience", "volunteering role". */
  noun: string;
  placeholder: boolean;
  /** Its place in the list and the list's length (-1 and 0 for the empty row). */
  index: number;
  count: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Write with AI's kind (Experience, Projects and Volunteering only). */
  ai: EntryBulletsKind | null;
  bullets: readonly string[];
  /** Settings: one checkbox per toggle ([] for the empty row and for a kind with none, such as Languages). */
  toggles: readonly EntryToggleState[];
  /** The keys it hides now, in Settings' order (what "Apply to all in this section" copies). */
  hidden: readonly string[];
  /** A role's "Skills used" (not printed); null for every other entry and for the empty row. */
  roleSkills: readonly string[] | null;
  canDelete: boolean;
}

/** The entry toolbar for the entry at `path`; null for a path that names no entry the page could show. */
export function entryTools(document: ResumeDocument, path: string): EntryTools | null {
  const selection = selectionOfEntry(path);
  const target = entryOfPath(path);
  if (!selection || !target) return null;
  const kind = toggleKindOf(target.list);
  const entries = entriesOf(document, selection.list);
  const index = entries.findIndex((entry) => entry.id === selection.id);
  const placeholder = index < 0 && selection.id === PLACEHOLDER_ENTRY_ID;
  if (index < 0 && !placeholder) return null;
  const entry = entries[index];
  const toggles = placeholder
    ? []
    : ENTRY_TOGGLES[kind].map((toggle) => ({
        key: toggle.key,
        label: toggle.label,
        shown: isFieldShown(kind, entry ?? {}, toggle.key),
      }));
  const ai = kind === 'custom' ? null : (SECTION_KIND_BY_ID[kind].aiKind ?? null);
  const bullets = Array.isArray(entry?.achievements)
    ? (entry.achievements as unknown[]).filter((line): line is string => typeof line === 'string')
    : [];
  return {
    path,
    list: selection.list,
    id: selection.id,
    ref: selection.ref,
    kind,
    name: entryName(kind, entry, placeholder ? -1 : index),
    noun: nounOf(kind),
    placeholder,
    index,
    count: entries.length,
    canMoveUp: !placeholder && index > 0,
    canMoveDown: !placeholder && index < entries.length - 1,
    ai: placeholder ? null : ai,
    bullets,
    toggles,
    hidden: toggles.filter((toggle) => !toggle.shown).map((toggle) => toggle.key),
    roleSkills:
      kind === 'experience' && !placeholder
        ? (Array.isArray(entry?.skills) ? (entry.skills as unknown[]) : []).filter((skill): skill is string => typeof skill === 'string')
        : null,
    canDelete: !placeholder,
  };
}

// ------------------------------------------------------------------------------------------------ sections

/** One control of a section's Settings, with its value as the page draws it now. */
export type SectionSetting =
  | {
      key: 'skillsLayout';
      type: 'choice';
      label: string;
      value: SkillsLayout;
      choices: ReadonlyArray<{ value: SkillsLayout; label: string }>;
    }
  | {
      key: 'tagBorder';
      type: 'choice';
      label: string;
      value: TagBorder;
      choices: ReadonlyArray<{ value: TagBorder; label: string }>;
    }
  | { key: 'showGroupNames' | 'showBulletMarker' | 'showProficiency' | 'showLevel'; type: 'flag'; label: string; value: boolean };

type SkillsLayout = (typeof SKILLS_LAYOUTS)[number];
type TagBorder = (typeof TAG_BORDERS)[number];

export type SectionAdd = 'entry' | 'skill' | 'group' | 'chip';

export interface SectionTools {
  ref: string;
  kind: string;
  name: string;
  /** The entry list behind it (null for the summary and the chip sections). */
  list: string | null;
  /** The last entry, which "+ Entry" adds after; null when the section shows only its empty row. */
  lastId: string | null;
  /** The add buttons, in order. */
  adds: readonly SectionAdd[];
  /** Where "+ Skill" adds a chip of a chip section (`softSkills`, `interests`). */
  chipList: 'softSkills' | 'interests' | null;
  /** "Skill", "Interest": what one chip is called. */
  chipNoun: string;
  /** Settings of this section only (Uppercase titles applies to the whole resume and is always offered). */
  settings: readonly SectionSetting[];
  uppercaseTitles: boolean;
}

const SKILL_LAYOUT_CHOICES = [
  { value: 'tags', label: 'Tags' },
  { value: 'list', label: 'List' },
  { value: 'bullets', label: 'Bullets' },
] as const;
const TAG_BORDER_CHOICES = [
  { value: 'box', label: 'Box' },
  { value: 'underline', label: 'Underline' },
] as const;

/** The section toolbar of `ref`; null for a ref the document does not show. */
export function sectionTools(document: ResumeDocument, ref: string): SectionTools | null {
  const parsed = parseSectionRef(ref);
  const view = editView(document);
  const section = view.sections.find((candidate) => candidate.ref === ref);
  if (!parsed || !section) return null;
  const options = section.options;
  const base = { ref, kind: parsed.kind, name: sectionName(document, ref), uppercaseTitles: view.design.uppercaseHeadings };
  const marker = { key: 'showBulletMarker', type: 'flag', label: 'Show bullet markers', value: options.showBulletMarker ?? true } as const;

  if (parsed.kind === 'skills') {
    const layout = options.skillsLayout ?? 'tags';
    const groups = document.skillCategories ?? [];
    const settings: SectionSetting[] = [
      { key: 'skillsLayout', type: 'choice', label: 'Layout', value: layout, choices: SKILL_LAYOUT_CHOICES },
      { key: 'showGroupNames', type: 'flag', label: 'Show group names', value: options.showGroupNames ?? groups.length > 0 },
    ];
    if (layout === 'tags') {
      settings.push({ key: 'tagBorder', type: 'choice', label: 'Tag style', value: options.tagBorder ?? 'underline', choices: TAG_BORDER_CHOICES });
    }
    if (layout === 'bullets') settings.push(marker);
    return { ...base, list: null, lastId: null, adds: ['skill', 'group'], chipList: null, chipNoun: 'Skill', settings };
  }
  if (parsed.kind === 'softSkills' || parsed.kind === 'interests') {
    const chipNoun = parsed.kind === 'interests' ? 'Interest' : 'Skill';
    const settings: SectionSetting[] = [
      { key: 'tagBorder', type: 'choice', label: 'Tag style', value: options.tagBorder ?? 'underline', choices: TAG_BORDER_CHOICES },
    ];
    return { ...base, list: null, lastId: null, adds: ['chip'], chipList: parsed.kind, chipNoun, settings };
  }
  if (parsed.kind === 'summary') {
    return { ...base, list: null, lastId: null, adds: [], chipList: null, chipNoun: '', settings: [] };
  }

  const list = parsed.kind === 'custom' ? `customSections.${parsed.key}.entries` : parsed.kind;
  const entries = entriesOf(document, list);
  const kind: ToggleKind = parsed.kind === 'custom' ? 'custom' : (parsed.kind as ToggleKind);
  const settings: SectionSetting[] = [];
  if (kind === 'languages') {
    settings.push(
      { key: 'showProficiency', type: 'flag', label: 'Show proficiency label', value: options.showProficiency ?? true },
      { key: 'showLevel', type: 'flag', label: 'Show level dots', value: options.showLevel ?? true },
    );
  } else if (hasBullets(kind)) {
    settings.push(marker);
  }
  return {
    ...base,
    list,
    lastId: entries.at(-1)?.id ?? null,
    adds: ['entry'],
    chipList: null,
    chipNoun: '',
    settings,
  };
}

// ------------------------------------------------------------------------------------------------ header

export interface HeaderTools {
  toggles: ReadonlyArray<{ key: HeaderField; label: string; shown: boolean }>;
  uppercaseName: boolean;
  /** Null when the template prints no photo. */
  photo: { present: boolean; shape: HeaderPhotoShape } | null;
  /** The years of experience (not printed); null when none are given. */
  years: number | null;
}

export function headerTools(document: ResumeDocument): HeaderTools {
  const view = editView(document);
  const photo = document.header?.photo;
  return {
    toggles: HEADER_TOGGLES.map((toggle) => ({ ...toggle, shown: isHeaderFieldShown(document.header, toggle.key) })),
    uppercaseName: view.header.uppercaseName,
    photo: view.spec.supportsPhoto ? { present: Boolean(photo), shape: photo?.shape ?? 'round' } : null,
    years: document.totalYearsExperience ?? null,
  };
}
