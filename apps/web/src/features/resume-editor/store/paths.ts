import {
  CUSTOM_SECTION_SPEC,
  ENTRY_LIST_KEYS,
  SECTION_KIND_BY_ID,
  isCustomSectionKey,
  isEntryId,
  isSectionKind,
  type EntryListKey,
  type HeaderField,
  type SectionKind,
  type ToggleKind,
} from '@tailorit/shared/resume';

// The addresses of the fields on the editor's page. The template package's view (model/view.ts) gives every field it
// draws a dotted path into the document; the store reads and writes through the same paths, so a field component
// needs nothing but its path. Entries are addressed by id, never by position, so a field follows its entry through a
// move. The empty row a section shows when it has no entries has the id `new`: writing to it makes a real entry.

/** The id of the row an empty section shows; it is not in the document. */
export const PLACEHOLDER_ENTRY_ID = 'new';

/** Where the caret is: a field's path and a character offset in its printed text. */
export interface Caret {
  path: string;
  offset: number;
}

export type ContactField = Exclude<HeaderField, 'title'>;
export const CONTACT_FIELDS: readonly ContactField[] = ['phone', 'email', 'linkedin', 'github', 'portfolio', 'location'];

/** One of the eleven entry lists, or the entries of one custom section. */
export type EntryList = { kind: EntryListKey } | { kind: 'custom'; key: string };

/** A list of chips: the technical skills, one group's, the soft skills, the interests, or a role's "Skills used". */
export type ChipList =
  | { kind: 'skills' }
  | { kind: 'softSkills' }
  | { kind: 'interests' }
  | { kind: 'group'; group: number }
  | { kind: 'roleSkills'; id: string };

/** What a path points at. */
export type FieldTarget =
  | { type: 'text'; field: 'name' | 'title' | 'summary' }
  | { type: 'contact'; field: ContactField }
  | { type: 'entry'; list: EntryList; id: string }
  | { type: 'entryField'; list: EntryList; id: string; prop: string }
  | { type: 'bullet'; list: EntryList; id: string; index: number }
  | { type: 'period'; list: EntryList; id: string }
  | { type: 'date'; list: EntryList; id: string }
  | { type: 'customTitle'; key: string }
  | { type: 'heading'; kind: SectionKind }
  | { type: 'groupName'; group: number }
  | { type: 'chip'; list: ChipList; index: number };

/** The text properties of each kind's entries that a path may name (dates, bullets and chips have their own forms). */
export const ENTRY_TEXT_PROPS: Readonly<Record<ToggleKind, readonly string[]>> = {
  experience: ['title', 'company', 'location', 'description'],
  strengths: ['title', 'description'],
  education: ['degree', 'institution', 'location', 'gpa'],
  certifications: ['name', 'issuer', 'expiryDate', 'credentialId'],
  projects: ['name', 'role', 'link', 'description'],
  languages: ['language', 'proficiency'],
  awards: ['title', 'issuer', 'description'],
  publications: ['title', 'publisher', 'link', 'description'],
  volunteering: ['role', 'organization', 'location', 'description'],
  courses: ['name', 'institution'],
  references: ['name', 'title', 'company', 'email', 'phone'],
  custom: ['heading', 'subheading', 'location', 'description'],
};

/** Kinds whose entries carry bullets, a period (start and end), or one date. */
const BULLET_KINDS: ReadonlySet<ToggleKind> = new Set(['experience', 'education', 'projects', 'volunteering', 'custom']);
const PERIOD_KINDS: ReadonlySet<ToggleKind> = BULLET_KINDS;
const DATE_KINDS: ReadonlySet<ToggleKind> = new Set(['certifications', 'awards', 'publications', 'courses']);

export const hasBullets = (kind: ToggleKind) => BULLET_KINDS.has(kind);
export const hasPeriod = (kind: ToggleKind) => PERIOD_KINDS.has(kind);
export const hasSingleDate = (kind: ToggleKind) => DATE_KINDS.has(kind);

export function toggleKindOf(list: EntryList): ToggleKind {
  return list.kind === 'custom' ? 'custom' : list.kind;
}

/** The key `RICH_TEXT_FIELDS` names the list by. */
export function richListKeyOf(list: EntryList): string {
  return list.kind === 'custom' ? 'customSections.entries' : list.kind;
}

/** Longer than any path the page draws; anything longer is not one. */
const MAX_PATH_LENGTH = 200;
const INDEX = /^(?:0|[1-9]\d{0,3})$/;
const LIST_KEYS: ReadonlySet<string> = new Set(ENTRY_LIST_KEYS);

function index(segment: string | undefined): number | null {
  return segment !== undefined && INDEX.test(segment) ? Number(segment) : null;
}

/** The part of a path after the list: `<id>`, `<id>.<prop>`, `<id>.achievements.<n>`, `<id>.skills.<n>`. */
function parseInEntry(list: EntryList, rest: readonly string[]): FieldTarget | null {
  const [id, prop, extra, ...more] = rest;
  if (!isEntryId(id) || more.length > 0) return null;
  if (prop === undefined) return { type: 'entry', list, id };
  const kind = toggleKindOf(list);
  if (extra !== undefined) {
    const at = index(extra);
    if (at === null) return null;
    if (prop === 'achievements' && hasBullets(kind)) return { type: 'bullet', list, id, index: at };
    if (prop === 'skills' && kind === 'experience') return { type: 'chip', list: { kind: 'roleSkills', id }, index: at };
    return null;
  }
  if (prop === 'period') return hasPeriod(kind) ? { type: 'period', list, id } : null;
  if (prop === 'date') return hasSingleDate(kind) ? { type: 'date', list, id } : null;
  return ENTRY_TEXT_PROPS[kind].includes(prop) ? { type: 'entryField', list, id, prop } : null;
}

/** What `path` points at, or null for anything that is not a path the page draws (or could draw). Never throws. */
export function parseFieldPath(path: unknown): FieldTarget | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  const [head, ...rest] = path.split('.');
  switch (head) {
    case 'name':
    case 'title':
    case 'summary':
      return rest.length === 0 ? { type: 'text', field: head } : null;
    case 'contact': {
      const field = CONTACT_FIELDS.find((candidate) => candidate === rest[0]);
      return field && rest.length === 1 ? { type: 'contact', field } : null;
    }
    case 'layout':
      return rest.length === 2 && isSectionKind(rest[0]) && rest[1] === 'heading'
        ? { type: 'heading', kind: rest[0] }
        : null;
    case 'customSections': {
      const [key, part, ...tail] = rest;
      if (!isCustomSectionKey(key)) return null;
      if (part === 'title') return tail.length === 0 ? { type: 'customTitle', key } : null;
      return part === 'entries' ? parseInEntry({ kind: 'custom', key }, tail) : null;
    }
    case 'skills':
    case 'softSkills':
    case 'interests': {
      const at = index(rest[0]);
      return at !== null && rest.length === 1 ? { type: 'chip', list: { kind: head }, index: at } : null;
    }
    case 'skillCategories': {
      const group = index(rest[0]);
      if (group === null) return null;
      if (rest[1] === 'category' && rest.length === 2) return { type: 'groupName', group };
      const at = index(rest[2]);
      return rest[1] === 'skills' && at !== null && rest.length === 3
        ? { type: 'chip', list: { kind: 'group', group }, index: at }
        : null;
    }
    default:
      return head !== undefined && LIST_KEYS.has(head) ? parseInEntry({ kind: head as EntryListKey }, rest) : null;
  }
}

// ------------------------------------------------------------------------------------------------ building paths

/** `experience`, or `customSections.<key>.entries`. */
export function entryListPath(list: EntryList): string {
  return list.kind === 'custom' ? `customSections.${list.key}.entries` : list.kind;
}

export function parseEntryListPath(path: unknown): EntryList | null {
  if (typeof path !== 'string') return null;
  if (LIST_KEYS.has(path)) return { kind: path as EntryListKey };
  const [head, key, part, ...rest] = path.split('.');
  return head === 'customSections' && isCustomSectionKey(key) && part === 'entries' && rest.length === 0
    ? { kind: 'custom', key }
    : null;
}

export function entryPath(list: EntryList, id: string): string {
  return `${entryListPath(list)}.${id}`;
}

export function fieldPath(entry: string, prop: string): string {
  return `${entry}.${prop}`;
}

export function bulletPath(entry: string, at: number): string {
  return `${entry}.achievements.${at}`;
}

/** The entry a path is in (the entry's own path for an entry path); null for a path outside the entry lists. */
export function entryPathOf(path: string): string | null {
  const entry = entryOfPath(path);
  return entry ? entryPath(entry.list, entry.id) : null;
}

/** The entry a path names, as list and id, for a path anywhere inside an entry. */
export function entryOfPath(path: string): { list: EntryList; id: string } | null {
  const target = parseFieldPath(path);
  if (!target) return null;
  if (target.type === 'chip' && target.list.kind === 'roleSkills') {
    return { list: { kind: 'experience' }, id: target.list.id };
  }
  return 'id' in target ? { list: target.list, id: target.id } : null;
}

/** `path` with the entry it is in moved to `id` (a placeholder row that became a real entry). */
export function retargetEntry(path: string, id: string): string {
  const entry = entryOfPath(path);
  if (!entry || entry.id === id) return path;
  const from = entryPath(entry.list, entry.id);
  return `${entryPath(entry.list, id)}${path.slice(from.length)}`;
}

export function chipListPath(list: ChipList): string {
  switch (list.kind) {
    case 'group':
      return `skillCategories.${list.group}.skills`;
    case 'roleSkills':
      return `experience.${list.id}.skills`;
    default:
      return list.kind;
  }
}

export function parseChipListPath(path: unknown): ChipList | null {
  if (typeof path !== 'string') return null;
  const target = parseFieldPath(`${path}.0`);
  return target?.type === 'chip' ? target.list : null;
}

export function chipPath(list: ChipList, at: number): string {
  return `${chipListPath(list)}.${at}`;
}

export function groupNamePath(group: number): string {
  return `skillCategories.${group}.category`;
}

/** Where a section's title is typed: `layout.<kind>.heading`, or a custom section's own title. */
export function headingPath(ref: string): string | null {
  if (isSectionKind(ref)) return `layout.${ref}.heading`;
  const key = ref.startsWith('custom:') ? ref.slice('custom:'.length) : '';
  return isCustomSectionKey(key) ? `customSections.${key}.title` : null;
}

// ------------------------------------------------------------------------------------------------ labels

const TOP_LABELS = { name: 'Name', title: 'Title', summary: 'Summary' } as const;
const CONTACT_LABELS: Readonly<Record<ContactField, string>> = {
  phone: 'Phone',
  email: 'Email',
  linkedin: 'LinkedIn',
  github: 'GitHub',
  portfolio: 'Portfolio',
  location: 'Location',
};
/** Properties the catalogue's field lists leave out. */
const PROP_LABELS: Readonly<Record<string, string>> = {
  description: 'Description',
  location: 'Location',
  gpa: 'GPA',
  expiryDate: 'Expiry date',
  credentialId: 'Credential ID',
};
const CHIP_LABELS: Readonly<Record<ChipList['kind'], string>> = {
  skills: 'Skill',
  group: 'Skill',
  softSkills: 'Soft skill',
  interests: 'Interest',
  roleSkills: 'Skills used',
};

function propLabel(kind: ToggleKind, prop: string): string {
  const fields = kind === 'custom' ? CUSTOM_SECTION_SPEC.fields : SECTION_KIND_BY_ID[kind].fields;
  return fields.find((field) => field.name === prop)?.label ?? PROP_LABELS[prop] ?? prop;
}

/** What a field is called in history and the live region ("typing in Job title"); '' for a path that is no field. */
export function fieldLabel(path: string): string {
  const target = parseFieldPath(path);
  if (!target) return '';
  switch (target.type) {
    case 'text':
      return TOP_LABELS[target.field];
    case 'contact':
      return CONTACT_LABELS[target.field];
    case 'entry': {
      const kind = toggleKindOf(target.list);
      return kind === 'custom' ? CUSTOM_SECTION_SPEC.entryNoun : SECTION_KIND_BY_ID[kind].entryNoun;
    }
    case 'entryField':
      return propLabel(toggleKindOf(target.list), target.prop);
    case 'bullet':
      return 'Bullet';
    case 'period':
      return 'Date period';
    case 'date':
      return 'Date';
    case 'customTitle':
    case 'heading':
      return 'Section title';
    case 'groupName':
      return 'Group name';
    case 'chip':
      return CHIP_LABELS[target.list.kind];
  }
}
