import {
  ENTRY_TOGGLES,
  HEADER_FIELDS,
  HEADER_PHOTO_ID_PATTERN,
  HEADER_PHOTO_SHAPES,
  MAX_CUSTOM_SECTION_TITLE_LENGTH,
  MAX_INTEREST_LENGTH,
  MAX_RESUME_CUSTOM_SECTIONS,
  MAX_RESUME_INTERESTS,
  MAX_RESUME_SECTION_ENTRIES,
  MAX_RESUME_SKILLS,
  MAX_RESUME_SOFT_SKILLS,
  MAX_SECTION_HEADING_LENGTH,
  MAX_SKILL_LENGTH,
  MAX_SOFT_SKILL_LENGTH,
  RESUME_TEMPLATES,
  sectionKindIn, // v33 ROLES
  type SectionWordings, // v33 ROLES
  completeLayout,
  customSectionRef,
  disableSection as layoutWithSectionOff,
  effectiveLayout,
  effectiveTemplateId,
  enableSection,
  escapeInline,
  escapeRichFields,
  formatPeriod,
  formatSingleDate,
  hiddenForNewEntry,
  isResumeTemplateId,
  isRichTextField,
  isSectionKind,
  languageLevelName,
  moveSectionBy,
  moveSectionTo as layoutWithSectionAt,
  newCustomSectionKey,
  newEntryId,
  normalizeDesign,
  normalizePeriod,
  normalizeSingleDate,
  parsePeriod,
  parseSectionRef,
  sanitizeHidden,
  sanitizeInline,
  setSectionHeading,
  setSectionOptions as layoutWithOptions,
  toPlainText,
  withPositionalEntryIds,
  type CustomSection,
  type DatePart,
  type EntryListKey,
  type HeaderField,
  type HeaderPhotoShape,
  type LayoutColumn,
  type LayoutItem,
  type PageSizeId,
  type Period,
  type RandomBytes,
  type ResumeDesign,
  type ResumeDocument,
  type ResumeHeader,
  type ResumeTemplateId,
  type SectionOptions,
  type SingleDate,
  type SkillCategoryGroup,
  type ToggleKind,
} from '@tailorit/shared/resume';
import {
  PLACEHOLDER_ENTRY_ID,
  bulletPath,
  chipListPath,
  chipPath,
  entryOfPath,
  entryPath,
  groupNamePath,
  hasBullets,
  hasPeriod,
  hasSingleDate,
  parseChipListPath,
  parseEntryListPath,
  parseFieldPath,
  retargetEntry,
  richListKeyOf,
  toggleKindOf,
  type Caret,
  type ChipList,
  type EntryList,
  type FieldTarget,
} from './paths';

// The on-page editor's changes to a resume document, as pure functions: each takes the document and returns the next
// one, never changing its input and sharing every part it did not change (a new bullet leaves every other list, and
// every other entry, the very same object), so a history of snapshots costs little and a field can tell whether its
// own value changed by identity. Nothing changed means the same document comes back. The document is the editor's:
// marked-up rich fields (markupVersion 1), a layout, stable entry ids. Text is stored as typed; the server's normalizer
// trims it when it is saved.

/** Enhancv's cap on the bullets of one entry; a change past it keeps the first ten. */
export const MAX_EDITOR_BULLETS = 10;
/** What a custom section is called until the person names it, and again when its title is cleared. */
export const DEFAULT_CUSTOM_SECTION_TITLE = 'Custom Section';

export interface ActionResult {
  document: ResumeDocument;
}

/** What writing to a field returns. */
export interface FieldResult extends ActionResult {
  /** The field's address now: a placeholder row written to is a real entry, with an id of its own. */
  path: string;
  /** Refused, or cut short: the list is full (ten bullets, fifty entries...). */
  capped?: true;
  /** Refused: the list already has that name. */
  duplicate?: true;
}

/** What a bullet edit returns. */
export interface BulletResult extends ActionResult {
  /** The entry's address now (a placeholder row edited is a real entry). */
  entry: string;
  /** Where the caret goes; null when nothing changed. */
  caret: Caret | null;
  capped?: true;
}

export interface EntryResult extends ActionResult {
  /** The new entry's address; null when none was added. */
  path: string | null;
  capped?: true;
}

export interface MoveResult extends ActionResult {
  /** Where the moved item is now and how many there are ("Moved up, 2 of 4"); index -1 when it was not found. */
  index: number;
  count: number;
}

export interface ChipResult extends ActionResult {
  /** The chip's address now; null when there is none (removed, refused). */
  path: string | null;
  duplicate?: true;
  capped?: true;
}

/** Where new ids come from (tests inject a seeded source). */
export interface ActionContext {
  random?: RandomBytes;
}

type Entry = { id?: string; hidden?: string[] } & Record<string, unknown>;

// ------------------------------------------------------------------------------------------------ copying

/** `owner` with `key` set; the same object when it already holds that value. */
function assign<T extends object>(owner: T, key: string, value: unknown): T {
  return Object.is((owner as Record<string, unknown>)[key], value) ? owner : ({ ...owner, [key]: value } as T);
}

/** `owner` without `key`; the same object when it has none. */
function omit<T extends object>(owner: T, key: string): T {
  if (!Object.hasOwn(owner, key)) return owner;
  const next = { ...owner } as Record<string, unknown>;
  delete next[key];
  return next as T;
}

function replaceAt<T>(list: readonly T[], at: number, value: T): T[] {
  const next = list.slice();
  next[at] = value;
  return next;
}

function insertAt<T>(list: readonly T[], at: number, ...values: T[]): T[] {
  return [...list.slice(0, at), ...values, ...list.slice(at)];
}

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, at) => Object.is(value, b[at]));

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** A whole number of places; anything else is none. */
const whole = (value: number) => (Number.isFinite(value) ? Math.trunc(value) : 0);
const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

// ------------------------------------------------------------------------------------------------ text

/** A one-line field as typed: line breaks become spaces; nothing is trimmed while the person types. */
const oneLine = (value: string) => value.replace(/\r\n?|\n/g, ' ');

/** Cut to `max` characters, never between the halves of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max;
  return text.slice(0, end);
}

/** A chip or a title as stored: trimmed, inner whitespace collapsed, cut to `max`. */
const tidy = (value: string, max: number) => cut(value.trim().replace(/\s+/g, ' '), max).trim();

/** The marker a pasted line starts with (a bullet glyph, "- ", "* "); a hyphen needs a space after it: "-5%" is text. */
const BULLET_MARKER = /^\s*(?:[\u2022\u25CF\u25AA\u25E6\u2023\u2219]\s*|[-*\u2013\u2014]\s+)/;

/** Pasted or written lines as bullets: split at line breaks, markers dropped, trimmed, blanks dropped, escaped. */
function bulletLines(lines: string | readonly string[]): string[] {
  const all = (typeof lines === 'string' ? [lines] : lines).flatMap((line) =>
    typeof line === 'string' ? line.split(/\r\n?|\n/) : [],
  );
  return all.map((line) => line.replace(BULLET_MARKER, '').trim()).filter(Boolean).map(escapeInline);
}

// ------------------------------------------------------------------------------------------------ entries

const RANGE = () => ({ startDate: '', endDate: '' });
const BLANK_ENTRIES: Readonly<Record<ToggleKind, () => Record<string, unknown>>> = {
  experience: () => ({ title: '', company: '', ...RANGE(), location: '', description: '', achievements: [], skills: [] }),
  strengths: () => ({ title: '', description: '' }),
  education: () => ({ degree: '', institution: '', ...RANGE(), location: '' }),
  certifications: () => ({ name: '', issuer: '', date: '' }),
  projects: () => ({ name: '', role: '', ...RANGE(), link: '', description: '', achievements: [] }),
  languages: () => ({ language: '', proficiency: '' }),
  awards: () => ({ title: '', issuer: '', date: '', description: '' }),
  publications: () => ({ title: '', publisher: '', date: '', link: '', description: '' }),
  volunteering: () => ({ role: '', organization: '', ...RANGE(), location: '', description: '', achievements: [] }),
  courses: () => ({ name: '', institution: '', date: '' }),
  references: () => ({ name: '', title: '', company: '', email: '', phone: '' }),
  custom: () => ({ heading: '', subheading: '', ...RANGE(), location: '', description: '', achievements: [] }),
};

/** Optional properties: stored only while they hold something, as the normalizer stores them. */
const OPTIONAL_PROPS: ReadonlySet<string> = new Set(['gpa', 'expiryDate', 'credentialId']);

/** An empty entry of `kind` with the toggles of `neighbour` (the entry before it), or the kind's defaults. */
function newEntry(kind: ToggleKind, id: string, neighbour: Entry | undefined): Entry {
  return { id, hidden: hiddenForNewEntry(kind, neighbour), ...BLANK_ENTRIES[kind]() };
}

const idsOf = (entries: readonly Entry[]) => entries.flatMap((entry) => (entry.id ? [entry.id] : []));

/** The entries of `list`: [] for a list the document lacks, null for a custom section it does not have. */
function entriesIn(document: ResumeDocument, list: EntryList): readonly Entry[] | null {
  if (list.kind === 'custom') {
    const section = document.customSections?.find((candidate) => candidate.key === list.key);
    return section ? (section.entries as readonly Entry[]) : null;
  }
  const entries: unknown = document[list.kind];
  return Array.isArray(entries) ? (entries as readonly Entry[]) : [];
}

function withEntries(document: ResumeDocument, list: EntryList, entries: readonly Entry[]): ResumeDocument {
  if (list.kind !== 'custom') return assign(document, list.kind, entries);
  const sections = document.customSections ?? [];
  const at = sections.findIndex((section) => section.key === list.key);
  const section = sections[at];
  if (!section || section.entries === entries) return document;
  const next: CustomSection = { ...section, entries: entries as CustomSection['entries'] };
  return { ...document, customSections: replaceAt(sections, at, next) };
}

/**
 * Where the entry `id` is in `entries`, or -1. A row with no id (a document the server has not upgraded) answers to
 * the positional id the page draws it with, as `withPositionalEntryIds` gives it.
 */
function indexOfEntry(entries: readonly Entry[], list: EntryList, id: string): number {
  const at = entries.findIndex((entry) => entry.id === id);
  if (at >= 0 || entries.every((entry) => entry.id)) return at;
  const numbered =
    list.kind === 'custom'
      ? withPositionalEntryIds({ customSections: [{ key: list.key, entries }] }).customSections?.[0]?.entries
      : withPositionalEntryIds({ [list.kind]: entries } as { [K in EntryListKey]?: readonly Entry[] })[list.kind];
  return (numbered ?? []).findIndex((entry, index) => !entries[index]?.id && entry.id === id);
}

interface EntryWrite {
  document: ResumeDocument;
  /** The entry's id: a new one when the placeholder became an entry. */
  id: string;
  capped?: true;
}

/**
 * `change` applied to the entry `id` of `list`. For the placeholder id a new entry is made first (after the last one,
 * with its toggles) and kept only when `change` put something in it. A row reached by its positional id keeps that id.
 * Null when there is no such list or entry.
 */
function updateEntry(
  document: ResumeDocument,
  list: EntryList,
  id: string,
  change: (entry: Entry) => Entry,
  context: ActionContext,
): EntryWrite | null {
  const entries = entriesIn(document, list);
  if (!entries) return null;
  const at = indexOfEntry(entries, list, id);
  const entry = entries[at];
  if (entry) {
    const next = change(entry);
    if (next === entry) return { document, id };
    return { document: withEntries(document, list, replaceAt(entries, at, next.id ? next : { id, ...next })), id };
  }
  if (id !== PLACEHOLDER_ENTRY_ID) return null;
  const fresh = newEntry(toggleKindOf(list), newEntryId(context.random, idsOf(entries)), entries.at(-1));
  const next = change(fresh);
  if (next === fresh) return { document, id };
  if (entries.length >= MAX_RESUME_SECTION_ENTRIES) return { document, id, capped: true };
  return { document: withEntries(document, list, [...entries, next]), id: fresh.id as string };
}

/** A field write's result: the path re-targeted at the entry that now holds it. */
function written(write: EntryWrite | null, document: ResumeDocument, path: string): FieldResult {
  if (!write) return { document, path };
  return { document: write.document, path: retargetEntry(path, write.id), ...(write.capped ? { capped: true } : {}) };
}

const bulletsOf = (entry: Entry): readonly string[] =>
  Array.isArray(entry.achievements) ? (entry.achievements as string[]) : [];

/** Education's bullets are optional: none stored rather than an empty list. */
function withBullets(entry: Entry, kind: ToggleKind, bullets: readonly string[]): Entry {
  if (bullets.length === 0 && kind === 'education') return omit(entry, 'achievements');
  return assign(entry, 'achievements', bullets);
}

// ------------------------------------------------------------------------------------------------ fields

type EntryTarget = Extract<FieldTarget, { list: EntryList }>;

function writeEntryProp(
  document: ResumeDocument,
  target: EntryTarget,
  prop: string,
  path: string,
  value: string,
  context: ActionContext,
): FieldResult {
  const write = updateEntry(
    document,
    target.list,
    target.id,
    (entry) => (value === '' && OPTIONAL_PROPS.has(prop) ? omit(entry, prop) : assign(entry, prop, value)),
    context,
  );
  return written(write, document, path);
}

function writeBullet(
  document: ResumeDocument,
  target: Extract<FieldTarget, { type: 'bullet' }>,
  path: string,
  markup: string,
  context: ActionContext,
): FieldResult {
  const kind = toggleKindOf(target.list);
  let capped = false;
  const write = updateEntry(
    document,
    target.list,
    target.id,
    (entry) => {
      const bullets = bulletsOf(entry);
      if (target.index < bullets.length) {
        if (bullets[target.index] === markup) return entry;
        return withBullets(entry, kind, replaceAt(bullets, target.index, markup));
      }
      // Past the end only the next bullet can be written, and only with something in it (the empty bullet the page
      // shows in an entry with none is `achievements.0`).
      if (target.index > bullets.length || markup === '') return entry;
      if (bullets.length >= MAX_EDITOR_BULLETS) {
        capped = true;
        return entry;
      }
      return withBullets(entry, kind, [...bullets, markup]);
    },
    context,
  );
  const result = written(write, document, path);
  return capped ? { ...result, capped: true } : result;
}

function writeCustomTitle(document: ResumeDocument, key: string, title: string): ResumeDocument {
  const sections = document.customSections ?? [];
  const at = sections.findIndex((section) => section.key === key);
  const section = sections[at];
  if (!section || section.title === title) return document;
  return { ...document, customSections: replaceAt(sections, at, { ...section, title }) };
}

/** A section title as typed (blank is kept while typing; `renameSection` tidies it and restores the default). */
function writeHeading(document: ResumeDocument, ref: string, value: string): ResumeDocument {
  const heading = cut(oneLine(value), MAX_SECTION_HEADING_LENGTH);
  return withLayout(
    document,
    layoutOf(document).map((item) => (item.ref === ref ? assign(item, 'heading', heading) : item)),
  );
}

/**
 * A plain field set to `value` as typed (a line break becomes a space). A rich field given plain text stores it
 * escaped; a date goes through `setDate`; a section title, a group name and a chip are written as their own actions
 * write them (a chip is renamed: trimmed and checked for a duplicate, so write it when it is committed, not per key).
 */
export function setText(
  document: ResumeDocument,
  path: string,
  value: string,
  context: ActionContext = {},
): FieldResult {
  const target = parseFieldPath(path);
  if (!target || typeof value !== 'string') return { document, path };
  switch (target.type) {
    case 'text':
      return {
        document: assign(document, target.field, target.field === 'summary' ? escapeInline(value) : oneLine(value)),
        path,
      };
    case 'contact':
      return { document: assign(document, 'contact', assign(document.contact, target.field, oneLine(value))), path };
    case 'entryField': {
      const rich = isRichTextField(richListKeyOf(target.list), target.prop);
      return writeEntryProp(document, target, target.prop, path, rich ? escapeInline(value) : oneLine(value), context);
    }
    case 'bullet':
      return writeBullet(document, target, path, escapeInline(value), context);
    case 'date':
      return setDate(document, path, value, context);
    case 'customTitle':
      return {
        document: writeCustomTitle(document, target.key, cut(oneLine(value), MAX_CUSTOM_SECTION_TITLE_LENGTH)),
        path,
      };
    case 'heading':
      return { document: writeHeading(document, target.kind, value), path };
    case 'groupName':
      return { document: renameGroup(document, target.group, value).document, path };
    case 'chip': {
      const result = renameChip(document, path, value);
      return { ...result, path: result.path ?? path };
    }
    default:
      return { document, path };
  }
}

/**
 * A rich field (the summary, a description, a bullet) set to `markup`, stored in canonical form (`sanitizeInline`).
 * A plain field given markup stores its words (`toPlainText`).
 */
export function setRich(
  document: ResumeDocument,
  path: string,
  markup: string,
  context: ActionContext = {},
): FieldResult {
  const target = parseFieldPath(path);
  if (!target || typeof markup !== 'string') return { document, path };
  if (target.type === 'text' && target.field === 'summary') {
    return { document: assign(document, 'summary', sanitizeInline(markup)), path };
  }
  if (target.type === 'entryField' && isRichTextField(richListKeyOf(target.list), target.prop)) {
    return writeEntryProp(document, target, target.prop, path, sanitizeInline(markup), context);
  }
  if (target.type === 'bullet') return writeBullet(document, target, path, sanitizeInline(markup), context);
  return setText(document, path, toPlainText(markup), context);
}

const samePart = (a: DatePart | undefined, b: DatePart | undefined) => a?.y === b?.y && a?.m === b?.m;

function samePeriod(a: Period | undefined, b: Period | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    samePart(a.from, b.from) &&
    samePart(a.to, b.to) &&
    a.ongoing === b.ongoing &&
    a.ongoingText === b.ongoingText &&
    a.raw?.start === b.raw?.start &&
    a.raw?.end === b.raw?.end
  );
}

/**
 * The period of an entry (the path of the entry or of its `period`): stored as picked, with `startDate` and `endDate`
 * rewritten as its canonical text. Null clears both ends.
 */
export function setPeriod(
  document: ResumeDocument,
  path: string,
  period: Period | null,
  context: ActionContext = {},
): FieldResult {
  const at = entryOfPath(path);
  if (!at || !hasPeriod(toggleKindOf(at.list))) return { document, path };
  const clean = period === null ? undefined : normalizePeriod(period);
  const dates = clean ? formatPeriod(clean) : { startDate: '', endDate: '' };
  const write = updateEntry(
    document,
    at.list,
    at.id,
    (entry) => {
      const next = assign(assign(entry, 'startDate', dates.startDate), 'endDate', dates.endDate);
      if (!clean) return omit(next, 'period');
      return samePeriod(entry.period as Period | undefined, clean) ? next : { ...next, period: clean };
    },
    context,
  );
  return written(write, document, path);
}

/** A single date (certification, award, publication, course): text as typed, or a picked date. Null clears it. */
export function setDate(
  document: ResumeDocument,
  path: string,
  value: string | SingleDate | null,
  context: ActionContext = {},
): FieldResult {
  const at = entryOfPath(path);
  if (!at || !hasSingleDate(toggleKindOf(at.list))) return { document, path };
  const text =
    typeof value === 'string' ? oneLine(value) : value ? formatSingleDate(normalizeSingleDate(value) ?? {}) : '';
  const write = updateEntry(document, at.list, at.id, (entry) => assign(entry, 'date', text), context);
  return written(write, document, path);
}

/** A language's dots, 1 to 5, or none. A new level resets the label to the level's name, as Enhancv does. */
export function setLevel(
  document: ResumeDocument,
  path: string,
  level: number | null,
  context: ActionContext = {},
): FieldResult {
  const at = entryOfPath(path);
  if (!at || at.list.kind !== 'languages') return { document, path };
  if (level !== null && !(Number.isInteger(level) && level >= 1 && level <= 5)) return { document, path };
  const write = updateEntry(
    document,
    at.list,
    at.id,
    (entry) => {
      if (level === null) return omit(entry, 'level');
      if (entry.level === level) return entry;
      return { ...entry, level, proficiency: languageLevelName(level) };
    },
    context,
  );
  return written(write, document, path);
}

// ------------------------------------------------------------------------------------------------ bullets

interface BulletChange {
  bullets?: readonly string[];
  caret?: { index: number; offset: number };
  capped?: boolean;
}

function editBullets(
  document: ResumeDocument,
  path: string,
  edit: (bullets: readonly string[]) => BulletChange | null,
  context: ActionContext,
): BulletResult {
  const at = entryOfPath(path);
  const kind = at && toggleKindOf(at.list);
  if (!at || !kind || !hasBullets(kind)) return { document, entry: path, caret: null };
  const box: { change?: BulletChange | null } = {};
  const write = updateEntry(
    document,
    at.list,
    at.id,
    (entry) => {
      box.change = edit(bulletsOf(entry));
      return box.change?.bullets ? withBullets(entry, kind, box.change.bullets) : entry;
    },
    context,
  );
  const entry = entryPath(at.list, write?.id ?? at.id);
  const change = box.change;
  const capped = change?.capped || write?.capped ? ({ capped: true } as const) : {};
  if (!write || write.document === document || !change?.caret) return { document, entry, caret: null, ...capped };
  const caret = { path: bulletPath(entry, change.caret.index), offset: change.caret.offset };
  return { document: write.document, entry, caret, ...capped };
}

/** The printed length of a bullet: where the caret sits at its end. */
const endOf = (markup: string | undefined) => toPlainText(markup ?? '').length;

/**
 * Enter in a bullet: `before` stays at `index` and `after` becomes the next bullet (both markup). In an entry with no
 * bullets, index 0 is the empty bullet the page shows. Refused at the cap.
 */
export function splitBullet(
  document: ResumeDocument,
  entry: string,
  index: number,
  before: string,
  after: string,
  context: ActionContext = {},
): BulletResult {
  return editBullets(
    document,
    entry,
    (bullets) => {
      const list = bullets.length === 0 ? [''] : bullets;
      if (!isIndex(index) || index >= list.length) return null;
      if (list.length >= MAX_EDITOR_BULLETS) return { capped: true };
      const halves = [sanitizeInline(before), sanitizeInline(after)];
      return {
        bullets: [...list.slice(0, index), ...halves, ...list.slice(index + 1)],
        caret: { index: index + 1, offset: 0 },
      };
    },
    context,
  );
}

/** Backspace at the start of a bullet: it joins the one before, with the caret where they meet. */
export function mergeBulletWithPrevious(
  document: ResumeDocument,
  entry: string,
  index: number,
  context: ActionContext = {},
): BulletResult {
  return editBullets(
    document,
    entry,
    (bullets) => {
      if (!isIndex(index) || index === 0 || index >= bullets.length) return null;
      const previous = bullets[index - 1] as string;
      const merged = sanitizeInline(previous + bullets[index]);
      return {
        bullets: [...bullets.slice(0, index - 1), merged, ...bullets.slice(index + 1)],
        caret: { index: index - 1, offset: endOf(previous) },
      };
    },
    context,
  );
}

/** A bullet removed; the caret goes to the end of the one before (or the start of the first). */
export function removeBullet(
  document: ResumeDocument,
  entry: string,
  index: number,
  context: ActionContext = {},
): BulletResult {
  return editBullets(
    document,
    entry,
    (bullets) => {
      if (!isIndex(index) || index >= bullets.length) return null;
      const next = bullets.filter((_, at) => at !== index);
      const focus = Math.max(0, index - 1);
      return { bullets: next, caret: { index: focus, offset: index > 0 ? endOf(next[focus]) : 0 } };
    },
    context,
  );
}

/**
 * Pasted lines as new bullets at `index` (each line plain text: markers dropped, escaped). Only as many as the cap
 * leaves room for are added; the bullets already there are never dropped.
 */
export function insertBullets(
  document: ResumeDocument,
  entry: string,
  index: number,
  lines: string | readonly string[],
  context: ActionContext = {},
): BulletResult {
  return editBullets(
    document,
    entry,
    (bullets) => {
      const incoming = bulletLines(lines);
      if (incoming.length === 0) return null;
      const room = MAX_EDITOR_BULLETS - bullets.length;
      if (room <= 0) return { capped: true };
      const kept = incoming.slice(0, room);
      const at = clamp(whole(index), 0, bullets.length);
      return {
        bullets: insertAt(bullets, at, ...kept),
        caret: { index: at + kept.length - 1, offset: endOf(kept.at(-1)) },
        capped: kept.length < incoming.length,
      };
    },
    context,
  );
}

/** Every bullet replaced by `lines` (Write with AI's result: plain text, escaped), the first ten kept. */
export function replaceBullets(
  document: ResumeDocument,
  entry: string,
  lines: string | readonly string[],
  context: ActionContext = {},
): BulletResult {
  return editBullets(
    document,
    entry,
    (bullets) => {
      const incoming = bulletLines(lines);
      const kept = incoming.slice(0, MAX_EDITOR_BULLETS);
      const capped = kept.length < incoming.length;
      if (sameList(kept, bullets)) return { capped };
      const last = Math.max(0, kept.length - 1);
      return { bullets: kept, caret: { index: last, offset: endOf(kept[last]) }, capped };
    },
    context,
  );
}

// ------------------------------------------------------------------------------------------------ entries

/**
 * A new, empty entry after `afterId` with that entry's toggles; with null, first in the list, with the toggles of the
 * entry it goes before. After the placeholder row the row becomes a real entry first and the new one follows it.
 */
export function insertEntryAfter(
  document: ResumeDocument,
  listPath: string,
  afterId: string | null,
  context: ActionContext = {},
): EntryResult {
  const list = parseEntryListPath(listPath);
  const entries = list && entriesIn(document, list);
  if (!list || !entries) return { document, path: null };
  const kind = toggleKindOf(list);
  let rows = entries;
  let after = -1;
  if (afterId === PLACEHOLDER_ENTRY_ID && indexOfEntry(entries, list, afterId) < 0) {
    if (entries.length === 0) rows = [newEntry(kind, newEntryId(context.random), undefined)];
    after = rows.length - 1;
  } else if (afterId !== null) {
    after = indexOfEntry(entries, list, afterId);
    if (after < 0) return { document, path: null };
  }
  if (rows.length >= MAX_RESUME_SECTION_ENTRIES) return { document, path: null, capped: true };
  const entry = newEntry(kind, newEntryId(context.random, idsOf(rows)), after >= 0 ? rows[after] : rows[0]);
  const next = insertAt(rows, after + 1, entry);
  return { document: withEntries(document, list, next), path: entryPath(list, entry.id as string) };
}

/** An entry removed. The section stays, even when it was the last entry; `emptied` says the list is empty now. */
export function removeEntry(
  document: ResumeDocument,
  listPath: string,
  id: string,
): ActionResult & { emptied: boolean } {
  const list = parseEntryListPath(listPath);
  const entries = list && entriesIn(document, list);
  if (!list || !entries) return { document, emptied: false };
  const at = indexOfEntry(entries, list, id);
  if (at < 0) return { document, emptied: entries.length === 0 };
  const rest = entries.filter((_, index) => index !== at);
  return { document: withEntries(document, list, rest), emptied: rest.length === 0 };
}

function moveEntryAt(
  document: ResumeDocument,
  listPath: string,
  id: string,
  target: (from: number) => number,
): MoveResult {
  const list = parseEntryListPath(listPath);
  const entries = list && entriesIn(document, list);
  if (!list || !entries) return { document, index: -1, count: 0 };
  const from = indexOfEntry(entries, list, id);
  if (from < 0) return { document, index: -1, count: entries.length };
  const to = clamp(whole(target(from)), 0, entries.length - 1);
  if (to === from) return { document, index: from, count: entries.length };
  return { document: withEntries(document, list, moved(entries, from, to)), index: to, count: entries.length };
}

/** An entry moved `delta` places (negative is up), held at the ends. */
export function moveEntry(document: ResumeDocument, listPath: string, id: string, delta: number): MoveResult {
  return moveEntryAt(document, listPath, id, (from) => from + whole(delta));
}

/** An entry dropped at `index` of its list (counted with it taken out). */
export function moveEntryTo(document: ResumeDocument, listPath: string, id: string, index: number): MoveResult {
  return moveEntryAt(document, listPath, id, () => index);
}

/** The toggle keys an entry hides (unknown keys dropped, in Settings' order). */
export function setEntryHidden(
  document: ResumeDocument,
  path: string,
  hidden: readonly string[],
  context: ActionContext = {},
): FieldResult {
  const at = entryOfPath(path);
  if (!at) return { document, path };
  const clean = sanitizeHidden(toggleKindOf(at.list), hidden) ?? [];
  const write = updateEntry(
    document,
    at.list,
    at.id,
    (entry) => (Array.isArray(entry.hidden) && sameList(entry.hidden, clean) ? entry : { ...entry, hidden: clean }),
    context,
  );
  return written(write, document, path);
}

/** "Apply to all in this section": every entry of the list hides `hidden`. */
export function applyHiddenToSection(
  document: ResumeDocument,
  listPath: string,
  hidden: readonly string[],
): ActionResult {
  const list = parseEntryListPath(listPath);
  const entries = list && entriesIn(document, list);
  if (!list || !entries) return { document };
  const clean = sanitizeHidden(toggleKindOf(list), hidden) ?? [];
  const next = entries.map((entry) =>
    Array.isArray(entry.hidden) && sameList(entry.hidden, clean) ? entry : { ...entry, hidden: clean },
  );
  return sameList(next, entries) ? { document } : { document: withEntries(document, list, next) };
}

// ------------------------------------------------------------------------------------------------ header

function withHeader(document: ResumeDocument, change: (header: ResumeHeader) => ResumeHeader): ResumeDocument {
  const header = document.header ?? { hidden: [] };
  const next = change(header);
  return next === header ? document : { ...document, header: next };
}

/** One detail under the name shown or hidden. */
export function setHeaderHidden(document: ResumeDocument, field: HeaderField, hidden: boolean): ActionResult {
  if (!(HEADER_FIELDS as readonly string[]).includes(field)) return { document };
  return {
    document: withHeader(document, (header) => {
      if (header.hidden.includes(field) === hidden) return header;
      const listed = hidden ? [...header.hidden, field] : header.hidden.filter((key) => key !== field);
      return { ...header, hidden: HEADER_FIELDS.filter((key) => listed.includes(key)) };
    }),
  };
}

/** The name in capitals, or not; null goes back to the template's own choice. */
export function setUppercaseName(document: ResumeDocument, uppercase: boolean | null): ActionResult {
  return {
    document: withHeader(document, (header) =>
      uppercase === null ? omit(header, 'uppercaseName') : assign(header, 'uppercaseName', uppercase),
    ),
  };
}

/**
 * The years of experience (not printed; Write with AI pitches the bullets to them, and the resume's reading counts
 * them): 0 to 80, to one decimal, as the normalizer keeps them. Null clears them; any other number changes nothing.
 */
export function setYearsOfExperience(document: ResumeDocument, years: number | null): ActionResult {
  if (years === null) {
    return { document: document.totalYearsExperience === undefined ? document : omit(document, 'totalYearsExperience') };
  }
  if (!Number.isFinite(years) || years < 0 || years > 80) return { document };
  const rounded = Math.round(years * 10) / 10;
  return { document: document.totalYearsExperience === rounded ? document : assign(document, 'totalYearsExperience', rounded) };
}

const isShape = (value: unknown): value is HeaderPhotoShape =>
  (HEADER_PHOTO_SHAPES as readonly unknown[]).includes(value);

/** The header photo (one of the account's photos, round or square), or none. */
export function setPhoto(
  document: ResumeDocument,
  photo: { photoId: string; shape: HeaderPhotoShape } | null,
): ActionResult {
  if (photo === null) return { document: withHeader(document, (header) => omit(header, 'photo')) };
  if (!HEADER_PHOTO_ID_PATTERN.test(photo.photoId) || !isShape(photo.shape)) return { document };
  return {
    document: withHeader(document, (header) =>
      header.photo?.photoId === photo.photoId && header.photo.shape === photo.shape
        ? header
        : { ...header, photo: { photoId: photo.photoId, shape: photo.shape } },
    ),
  };
}

export function setPhotoShape(document: ResumeDocument, shape: HeaderPhotoShape): ActionResult {
  const photo = document.header?.photo;
  if (!photo || !isShape(shape) || photo.shape === shape) return { document };
  return { document: withHeader(document, (header) => ({ ...header, photo: { ...photo, shape } })) };
}

// ------------------------------------------------------------------------------------------------ chips

const CHIP_LIMITS: Readonly<Record<ChipList['kind'], { max: number; length: number }>> = {
  skills: { max: MAX_RESUME_SKILLS, length: MAX_SKILL_LENGTH },
  group: { max: MAX_RESUME_SKILLS, length: MAX_SKILL_LENGTH },
  softSkills: { max: MAX_RESUME_SOFT_SKILLS, length: MAX_SOFT_SKILL_LENGTH },
  interests: { max: MAX_RESUME_INTERESTS, length: MAX_INTEREST_LENGTH },
  roleSkills: { max: MAX_RESUME_SOFT_SKILLS, length: MAX_SKILL_LENGTH },
};

const fold = (name: string) => name.toLowerCase();
const isTechnical = (list: ChipList) => list.kind === 'skills' || list.kind === 'group';
const groupsOf = (document: ResumeDocument): readonly SkillCategoryGroup[] => document.skillCategories ?? [];

function chipsOf(document: ResumeDocument, list: ChipList): readonly string[] | null {
  switch (list.kind) {
    case 'skills':
      return document.skills;
    case 'softSkills':
      return document.softSkills ?? [];
    case 'interests':
      return document.interests ?? [];
    case 'group':
      return groupsOf(document)[list.group]?.skills ?? null;
    case 'roleSkills': {
      const entries = document.experience as readonly Entry[];
      const entry = entries[indexOfEntry(entries, { kind: 'experience' }, list.id)];
      return entry ? ((entry.skills as string[] | undefined) ?? []) : null;
    }
  }
}

/** The groups as given; none stored rather than an empty list. */
function withGroups(document: ResumeDocument, groups: readonly SkillCategoryGroup[]): ResumeDocument {
  return groups.length === 0 ? omit(document, 'skillCategories') : assign(document, 'skillCategories', groups);
}

/** One list's chips written back as given; the technical-skill actions keep `skills` and the groups together. */
function withChips(document: ResumeDocument, list: ChipList, chips: readonly string[]): ResumeDocument {
  switch (list.kind) {
    case 'softSkills':
    case 'interests':
    case 'skills':
      return assign(document, list.kind, chips);
    case 'group': {
      const groups = groupsOf(document);
      const group = groups[list.group];
      return group ? withGroups(document, replaceAt(groups, list.group, { ...group, skills: [...chips] })) : document;
    }
    case 'roleSkills':
      return (
        updateEntry(document, { kind: 'experience' }, list.id, (entry) => assign(entry, 'skills', chips), {})?.document ??
        document
      );
  }
}

/** Every group with `name` taken out (but group `keep`); the same list when no group had it. */
function groupsWithout(groups: readonly SkillCategoryGroup[], name: string, keep = -1): readonly SkillCategoryGroup[] {
  let out: SkillCategoryGroup[] | undefined;
  groups.forEach((group, at) => {
    if (at === keep || !group.skills.some((skill) => fold(skill) === fold(name))) return;
    out ??= groups.slice();
    out[at] = { ...group, skills: group.skills.filter((skill) => fold(skill) !== fold(name)) };
  });
  return out ?? groups;
}

/** Every group with `from` spelt `to`; the same list when no group had it. */
function groupsRenamed(groups: readonly SkillCategoryGroup[], from: string, to: string): readonly SkillCategoryGroup[] {
  let out: SkillCategoryGroup[] | undefined;
  groups.forEach((group, at) => {
    if (!group.skills.some((skill) => fold(skill) === fold(from))) return;
    out ??= groups.slice();
    out[at] = { ...group, skills: group.skills.map((skill) => (fold(skill) === fold(from) ? to : skill)) };
  });
  return out ?? groups;
}

/** A skill into group `group` at `at`. One already listed moves out of any other group; a new one joins `skills`. */
function addToGroup(document: ResumeDocument, group: number, name: string, at: number): ChipResult {
  const groups = groupsOf(document);
  const target = groups[group];
  if (!target) return { document, path: null };
  if (target.skills.some((skill) => fold(skill) === fold(name))) return { document, path: null, duplicate: true };
  const held = document.skills.find((skill) => fold(skill) === fold(name));
  if (!held && document.skills.length >= MAX_RESUME_SKILLS) return { document, path: null, capped: true };
  const skills = held ? document.skills : [...document.skills, name];
  const position = clamp(at, 0, target.skills.length);
  const others = groupsWithout(groups, name, group);
  const next = replaceAt(others, group, { ...target, skills: insertAt(target.skills, position, held ?? name) });
  return {
    document: withGroups(assign(document, 'skills', skills), next),
    path: chipPath({ kind: 'group', group }, position),
  };
}

/**
 * A chip added to the list at `listPath` (`skills`, `softSkills`, `interests`, `skillCategories.<n>.skills`,
 * `experience.<id>.skills`), at `index` or at the end: trimmed, refused when blank, when the list has it in any case,
 * or when it is full. Technical skills are one list: a skill added to a group is also in `skills`, and a skill can be
 * in one group only.
 */
export function addChip(document: ResumeDocument, listPath: string, name: string, index?: number): ChipResult {
  const list = parseChipListPath(listPath);
  const chips = list && chipsOf(document, list);
  if (!list || !chips || typeof name !== 'string') return { document, path: null };
  const limits = CHIP_LIMITS[list.kind];
  const clean = tidy(name, limits.length);
  if (!clean) return { document, path: null };
  const at = index === undefined ? chips.length : clamp(whole(index), 0, chips.length);
  if (list.kind === 'group') return addToGroup(document, list.group, clean, at);
  if (chips.some((chip) => fold(chip) === fold(clean))) return { document, path: null, duplicate: true };
  if (chips.length >= limits.max) return { document, path: null, capped: true };
  return { document: withChips(document, list, insertAt(chips, at, clean)), path: chipPath(list, at) };
}

/** A chip taken off. A technical skill leaves the resume: `skills` and every group. */
export function removeChip(document: ResumeDocument, path: string): ChipResult {
  const target = parseFieldPath(path);
  if (target?.type !== 'chip') return { document, path: null };
  const chips = chipsOf(document, target.list);
  const name = chips?.[target.index];
  if (!chips || name === undefined) return { document, path: null };
  if (!isTechnical(target.list)) {
    return { document: withChips(document, target.list, chips.filter((_, at) => at !== target.index)), path: null };
  }
  const skills = document.skills.filter((skill) => fold(skill) !== fold(name));
  const groups = groupsWithout(groupsOf(document), name);
  const base = skills.length === document.skills.length ? document : { ...document, skills };
  return { document: withGroups(base, groups), path: null };
}

/**
 * A chip renamed (when it is committed: Enter or leaving it): trimmed and collapsed; blank removes it; a name the list
 * already has (in any case) is refused. A technical skill is renamed in `skills` and in its group. The empty chip a
 * list with none shows (index = length) adds one.
 */
export function renameChip(document: ResumeDocument, path: string, name: string): ChipResult {
  const target = parseFieldPath(path);
  if (target?.type !== 'chip' || typeof name !== 'string') return { document, path: null };
  const { list, index } = target;
  const chips = chipsOf(document, list);
  if (!chips) return { document, path: null };
  const clean = tidy(name, CHIP_LIMITS[list.kind].length);
  if (index === chips.length) return clean ? addChip(document, chipListPath(list), clean) : { document, path: null };
  const current = chips[index];
  if (current === undefined) return { document, path: null };
  if (!clean) return removeChip(document, path);
  if (clean === current) return { document, path };
  if (!isTechnical(list)) {
    if (chips.some((chip, at) => at !== index && fold(chip) === fold(clean))) return { document, path, duplicate: true };
    return { document: withChips(document, list, replaceAt(chips, index, clean)), path };
  }
  const taken = document.skills.some((skill) => fold(skill) === fold(clean) && fold(skill) !== fold(current));
  if (taken) return { document, path, duplicate: true };
  const listed = document.skills.some((skill) => fold(skill) === fold(current));
  const skills = listed
    ? document.skills.map((skill) => (fold(skill) === fold(current) ? clean : skill))
    : [...document.skills, clean];
  return { document: withGroups({ ...document, skills }, groupsRenamed(groupsOf(document), current, clean)), path };
}

/** A chip moved inside its list, from `from` to `to`. */
export function moveChip(document: ResumeDocument, listPath: string, from: number, to: number): ChipResult {
  const list = parseChipListPath(listPath);
  const chips = list && chipsOf(document, list);
  if (!list || !chips || !isIndex(from) || from >= chips.length) return { document, path: null };
  const at = clamp(whole(to), 0, chips.length - 1);
  if (at === from) return { document, path: chipPath(list, from) };
  return { document: withChips(document, list, moved(chips, from, at)), path: chipPath(list, at) };
}

/**
 * A technical skill dragged from one group to another (null: the skills in no group, addressed `skills.<n>`).
 * `toIndex` counts the chips of the target as the page shows them; for null, the skills in no group.
 */
export function moveChipToGroup(
  document: ResumeDocument,
  fromGroup: number | null,
  index: number,
  toGroup: number | null,
  toIndex: number,
): ChipResult {
  const groups = groupsOf(document);
  const source = fromGroup === null ? document.skills : groups[fromGroup]?.skills;
  const name = isIndex(index) ? source?.[index] : undefined;
  if (name === undefined) return { document, path: null };
  if (fromGroup !== null && fromGroup === toGroup) {
    return moveChip(document, chipListPath({ kind: 'group', group: fromGroup }), index, toIndex);
  }
  const others = groupsWithout(groups, name);
  const listed = document.skills.some((skill) => fold(skill) === fold(name));
  if (toGroup !== null) {
    const target = others[toGroup];
    if (!target) return { document, path: null };
    const at = clamp(whole(toIndex), 0, target.skills.length);
    const next = replaceAt(others, toGroup, { ...target, skills: insertAt(target.skills, at, name) });
    const skills = listed ? document.skills : [...document.skills, name];
    return {
      document: withGroups(assign(document, 'skills', skills), next),
      path: chipPath({ kind: 'group', group: toGroup }, at),
    };
  }
  // Into the skills in no group: placed before the one that is now at `toIndex` among them.
  const grouped = new Set(others.flatMap((group) => group.skills.map(fold)));
  const rest = document.skills.filter((skill) => fold(skill) !== fold(name));
  const loose = rest.filter((skill) => !grouped.has(fold(skill)));
  const before = loose[clamp(whole(toIndex), 0, loose.length)];
  const at = before === undefined ? rest.length : rest.indexOf(before);
  const skills = insertAt(rest, at, name);
  const base = sameList(skills, document.skills) ? document : { ...document, skills };
  return { document: withGroups(base, others), path: `skills.${at}` };
}

/** A new, empty group of technical skills at the end. A second group turns the group names on. */
export function addGroup(document: ResumeDocument, name = ''): ActionResult & { group: number; path: string } {
  const groups = [...groupsOf(document), { category: oneLine(name), skills: [] }];
  let next = withGroups(document, groups);
  if (groups.length >= 2) next = setSectionOptions(next, 'skills', { showGroupNames: true }).document;
  return { document: next, group: groups.length - 1, path: groupNamePath(groups.length - 1) };
}

/** A group's name as typed. */
export function renameGroup(document: ResumeDocument, group: number, name: string): ActionResult {
  const groups = groupsOf(document);
  const target = groups[group];
  const category = typeof name === 'string' ? oneLine(name) : '';
  if (!target || target.category === category) return { document };
  return { document: withGroups(document, replaceAt(groups, group, { ...target, category })) };
}

/** A group removed; its skills stay on the resume, in no group. */
export function removeGroup(document: ResumeDocument, group: number): ActionResult {
  const groups = groupsOf(document);
  if (!groups[group]) return { document };
  return { document: withGroups(document, groups.filter((_, at) => at !== group)) };
}

// ------------------------------------------------------------------------------------------------ sections

/** The document's layout, complete; worked out from the old model for a document that has none. */
function layoutOf(document: ResumeDocument): LayoutItem[] {
  const keys = (document.customSections ?? []).map((section) => section.key);
  return Array.isArray(document.layout) ? completeLayout(document.layout, keys) : effectiveLayout(document);
}

const specOf = (document: ResumeDocument) => RESUME_TEMPLATES[effectiveTemplateId(document)];

function sameOptions(a: SectionOptions | undefined, b: SectionOptions | undefined): boolean {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]) as Set<keyof SectionOptions>;
  return [...keys].every((key) => a?.[key] === b?.[key]);
}

const sameItem = (a: LayoutItem, b: LayoutItem) =>
  a.ref === b.ref &&
  a.column === b.column &&
  a.enabled === b.enabled &&
  a.heading === b.heading &&
  Object.hasOwn(a, 'heading') === Object.hasOwn(b, 'heading') &&
  sameOptions(a.options, b.options);

/** `next` as the layout, each item that did not change kept as the very object it was; the document when none did. */
function withLayout(document: ResumeDocument, next: readonly LayoutItem[]): ResumeDocument {
  const current = document.layout ?? [];
  const items = next.map((item) => current.find((old) => sameItem(old, item)) ?? item);
  if (document.layout && sameList(items, current)) return document;
  return { ...document, layout: items };
}

/** Whether `ref` names a section this document can show: a kind, or one of its custom sections. */
function knownRef(document: ResumeDocument, ref: string): boolean {
  const parsed = parseSectionRef(ref);
  if (!parsed) return false;
  return parsed.kind !== 'custom' || (document.customSections ?? []).some((section) => section.key === parsed.key);
}

/**
 * A section switched on: Summary first, else after `afterRef` (the section whose + was used) or at the end of the
 * shorter column. Its content was never cleared, so adding it again brings it back.
 */
export function addSection(document: ResumeDocument, ref: string, options: { afterRef?: string } = {}): ActionResult {
  if (!knownRef(document, ref)) return { document };
  return { document: withLayout(document, enableSection(layoutOf(document), ref, specOf(document), options)) };
}

/** A section switched off; its content, title and settings stay. */
export function disableSection(document: ResumeDocument, ref: string): ActionResult {
  if (!knownRef(document, ref)) return { document };
  return { document: withLayout(document, layoutWithSectionOff(layoutOf(document), ref)) };
}

/**
 * A section's title committed: tidied, cut to its limit. Null or blank goes back to the default: the kind's own name
 * (no heading stored), or "Custom Section" for a custom section.
 */
export function renameSection(document: ResumeDocument, ref: string, heading: string | null): ActionResult {
  const parsed = parseSectionRef(ref);
  if (!parsed || !knownRef(document, ref)) return { document };
  if (parsed.kind === 'custom') {
    const title = tidy(heading ?? '', MAX_CUSTOM_SECTION_TITLE_LENGTH) || DEFAULT_CUSTOM_SECTION_TITLE;
    return { document: writeCustomTitle(document, parsed.key, title) };
  }
  return { document: withLayout(document, setSectionHeading(layoutOf(document), ref, heading ?? undefined)) };
}

function sectionPosition(document: ResumeDocument, ref: string): { index: number; count: number } {
  const spec = specOf(document);
  const layout = layoutOf(document);
  const item = layout.find((candidate) => candidate.ref === ref);
  const column = spec.columns === 1 ? null : item?.column;
  const shown = layout.filter((candidate) => candidate.enabled && (column === null || candidate.column === column));
  return { index: shown.findIndex((candidate) => candidate.ref === ref), count: shown.length };
}

/** A section moved `delta` places up (negative) or down in its column. */
export function moveSection(document: ResumeDocument, ref: string, delta: number): MoveResult {
  const next = withLayout(document, moveSectionBy(layoutOf(document), ref, delta, specOf(document)));
  return { document: next, ...sectionPosition(next, ref) };
}

/** A section dropped into a column at `index` among the sections on show there. */
export function moveSectionTo(
  document: ResumeDocument,
  ref: string,
  target: { column: LayoutColumn; index: number },
): MoveResult {
  const next = withLayout(document, layoutWithSectionAt(layoutOf(document), ref, target, specOf(document)));
  return { document: next, ...sectionPosition(next, ref) };
}

/** A section's settings with `patch` over them (`undefined` goes back to the template's default). */
export function setSectionOptions(document: ResumeDocument, ref: string, patch: SectionOptions): ActionResult {
  if (!knownRef(document, ref)) return { document };
  return { document: withLayout(document, layoutWithOptions(layoutOf(document), ref, patch)) };
}

/**
 * A new custom section, switched on where `addSection` would put it. With `fields` (the toggle keys it shows:
 * subheading, period, location, description, bullets) it starts with one empty entry hiding the others, which every
 * new entry then copies; without, it starts with none.
 */
export function addCustomSection(
  document: ResumeDocument,
  title: string,
  options: { fields?: readonly string[]; afterRef?: string } = {},
  context: ActionContext = {},
): ActionResult & { ref: string | null; path: string | null; capped?: true } {
  const sections = document.customSections ?? [];
  if (sections.length >= MAX_RESUME_CUSTOM_SECTIONS) return { document, ref: null, path: null, capped: true };
  const keys = sections.map((section) => section.key);
  const key = newCustomSectionKey(context.random, keys);
  const fields = options.fields;
  const entries: Entry[] = fields
    ? [
        {
          id: newEntryId(context.random),
          hidden: ENTRY_TOGGLES.custom.filter((toggle) => !fields.includes(toggle.key)).map((toggle) => toggle.key),
          ...BLANK_ENTRIES.custom(),
        },
      ]
    : [];
  const section = {
    key,
    title: tidy(typeof title === 'string' ? title : '', MAX_CUSTOM_SECTION_TITLE_LENGTH) || DEFAULT_CUSTOM_SECTION_TITLE,
    entries,
  } as CustomSection;
  const ref = customSectionRef(key);
  const layout = enableSection(completeLayout(layoutOf(document), [...keys, key]), ref, specOf(document), {
    afterRef: options.afterRef,
  });
  const next = withLayout({ ...document, customSections: [...sections, section] }, layout);
  return { document: next, ref, path: `customSections.${key}.title` };
}

/**
 * What the live region and history call a section: its title, or the catalogue's name for it (v33 ROLES: in the
 * resume's field's words, `wordings`, when given: "Skills" for a nurse's resume).
 */
export function sectionLabel(document: ResumeDocument, ref: string, wordings?: SectionWordings | null): string {
  const parsed = parseSectionRef(ref);
  if (!parsed) return 'Section';
  if (parsed.kind === 'custom') {
    const title = document.customSections?.find((section) => section.key === parsed.key)?.title.trim();
    return title || DEFAULT_CUSTOM_SECTION_TITLE;
  }
  return document.layout?.find((item) => item.ref === ref)?.heading?.trim() || sectionKindIn(parsed.kind, wordings).label;
}

// ------------------------------------------------------------------------------------------------ template, design

/**
 * Another template; the content is kept. On one column Summary moves to the top. Onto two columns from a layout with
 * nothing in the side column (one made on a one-column template), the sections take the template's default columns.
 */
export function setTemplate(document: ResumeDocument, templateId: ResumeTemplateId): ActionResult {
  if (!isResumeTemplateId(templateId) || document.templateId === templateId) return { document };
  const spec = RESUME_TEMPLATES[templateId];
  let layout = layoutOf(document);
  if (spec.columns === 1) {
    const summary = layout.find((item) => item.ref === 'summary');
    if (summary) layout = [summary, ...layout.filter((item) => item !== summary)];
  } else if (!layout.some((item) => item.column === 'side')) {
    layout = layout.map((item) => {
      const column = isSectionKind(item.ref) ? (spec.defaultPlacement[item.ref] ?? 'main') : 'main';
      return column === item.column ? item : { ...item, column };
    });
  }
  return { document: withLayout({ ...document, templateId }, layout) };
}

/** A Design & Font change: a value per control, null for the template's own. */
export type DesignPatch = { [K in keyof ResumeDesign]?: ResumeDesign[K] | null };

function sameDesign(a: ResumeDesign, b: ResumeDesign): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ResumeDesign>;
  return [...keys].every((key) =>
    key === 'colors'
      ? a.colors?.primary === b.colors?.primary && a.colors?.secondary === b.colors?.secondary
      : a[key] === b[key],
  );
}

/** The design with `patch` over it, through `normalizeDesign` (a value it cannot read keeps the current one). */
export function setDesign(document: ResumeDocument, patch: DesignPatch): ActionResult {
  const next = normalizeDesign(patch, document.design);
  return sameDesign(document.design ?? {}, next) ? { document } : { document: { ...document, design: next } };
}

export function setPageSize(document: ResumeDocument, pageSize: PageSizeId): ActionResult {
  return setDesign(document, { pageSize });
}

/** Section titles in capitals (AA) or as written (Aa); null for the template's own. */
export function setUppercaseHeadings(document: ResumeDocument, uppercase: boolean | null): ActionResult {
  return setDesign(document, { uppercaseHeadings: uppercase });
}

// ------------------------------------------------------------------------------------------------ loading, reading

/**
 * A document as the editor holds it. The server sends editor documents (ids on every entry, a layout, markup); for
 * one that is not, the rich fields are escaped and marked up, and the template and layout it draws with are stored.
 * Entries without an id keep none: they answer to their positional ids until they are written to.
 */
export function loadDocument(document: ResumeDocument): ActionResult {
  let next = document;
  if (next.markupVersion !== 1) next = { ...escapeRichFields(next), markupVersion: 1 };
  if (!next.templateId) next = { ...next, templateId: effectiveTemplateId(next) };
  if (!Array.isArray(next.layout)) next = { ...next, layout: effectiveLayout(next) };
  return { document: next };
}

/** Periods worked out from date strings, by the strings: the same strings give the very same object. */
const derivedPeriods = new Map<string, Period>();
const MAX_DERIVED_PERIODS = 500;

/** The period an entry stores, or the one its date strings say. */
function periodOf(entry: Entry): Period {
  if (entry.period) return entry.period as Period;
  const start = typeof entry.startDate === 'string' ? entry.startDate : '';
  const end = typeof entry.endDate === 'string' ? entry.endDate : '';
  const key = JSON.stringify([start, end]);
  let period = derivedPeriods.get(key);
  if (!period) {
    if (derivedPeriods.size >= MAX_DERIVED_PERIODS) derivedPeriods.clear();
    period = parsePeriod(start, end);
    derivedPeriods.set(key, period);
  }
  return period;
}

/**
 * The value at `path`: a string for a text field, bullet, chip or name; the entry for an entry path; a Period for a
 * period; the stored heading (undefined: the default) for a section title. Undefined when the document holds nothing
 * there (a placeholder row, the empty bullet or chip). Unchanged parts come back as the very same values.
 */
export function valueAt(document: ResumeDocument, path: string): unknown {
  const target = parseFieldPath(path);
  if (!target) return undefined;
  switch (target.type) {
    case 'text':
      return document[target.field];
    case 'contact':
      return document.contact[target.field];
    case 'customTitle':
      return document.customSections?.find((section) => section.key === target.key)?.title;
    case 'heading':
      return document.layout?.find((item) => item.ref === target.kind)?.heading;
    case 'groupName':
      return groupsOf(document)[target.group]?.category;
    case 'chip':
      return chipsOf(document, target.list)?.[target.index];
  }
  const entries = entriesIn(document, target.list);
  const entry = entries ? entries[indexOfEntry(entries, target.list, target.id)] : undefined;
  if (!entry) return undefined;
  switch (target.type) {
    case 'entry':
      return entry;
    case 'entryField':
      return entry[target.prop];
    case 'bullet':
      return bulletsOf(entry)[target.index];
    case 'period':
      return periodOf(entry);
    case 'date':
      return entry.date;
  }
}
