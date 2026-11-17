import { cryptoRandomBytes, newHexKey, type RandomBytes } from './catalogue';

// Entry ids. Every entry of the on-page editor has a stable id (a drag, a toggle and a React key follow it, not its
// position). The editor mints random ones for new rows; a legacy document has none, and the server fills in positional
// ones that read the same every time (`withPositionalEntryIds`).

/** Safe in a class name, an attribute and a DOM box id (`e:<ref>:<id>`). */
export const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isEntryId(value: unknown): value is string {
  return typeof value === 'string' && ENTRY_ID_PATTERN.test(value);
}

/** An id for a new entry: "e-" and eight lowercase hex digits, drawn again while `taken` has it. */
export function newEntryId(random: RandomBytes = cryptoRandomBytes, taken: readonly string[] = []): string {
  return newHexKey('e-', random, taken);
}

/** The document keys of the eleven entry lists (a custom section's entries are separate). */
export const ENTRY_LIST_KEYS = [
  'experience',
  'strengths',
  'education',
  'certifications',
  'projects',
  'languages',
  'awards',
  'publications',
  'volunteering',
  'courses',
  'references',
] as const;
export type EntryListKey = (typeof ENTRY_LIST_KEYS)[number];

type WithId = { id?: string };

/** What `withPositionalEntryIds` reads: the entry lists and the custom sections of a resume document. */
type EntryLists = { [K in EntryListKey]?: readonly WithId[] } & {
  customSections?: readonly { key: string; entries: readonly WithId[] }[];
};

/** The longest prefix that still leaves room for "-" and a position inside `ENTRY_ID_PATTERN`. */
const MAX_PREFIX_LENGTH = 34;

/**
 * `entries` with every entry that lacks an id given `<prefix>-<index>`, or the next free position when that id is
 * taken in the list. The same array when every entry has one.
 */
function numbered<E extends WithId>(entries: readonly E[], prefix: string): readonly E[] {
  const taken = new Set<string>();
  for (const entry of entries) if (entry && typeof entry.id === 'string' && entry.id) taken.add(entry.id);
  let out: E[] | undefined;
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || entry.id) return;
    let at = index;
    while (taken.has(`${prefix}-${at}`)) at += 1;
    const id = `${prefix}-${at}`;
    taken.add(id);
    out ??= entries.slice();
    out[index] = { ...entry, id };
  });
  return out ?? entries;
}

/**
 * The document with an id on every entry that has none: `experience-0`, `education-1`, and for a custom section
 * `custom-<sectionKey>-<index>` (`custom-<index>` when the key is too long for an id). Deterministic, so reading the
 * same legacy document twice gives the same ids; an id already in use in its list is skipped. The very same object
 * comes back when every entry already has an id.
 */
export function withPositionalEntryIds<T extends EntryLists>(document: T): T {
  const patch: Record<string, unknown> = {};
  for (const key of ENTRY_LIST_KEYS) {
    const list = document[key];
    if (!Array.isArray(list)) continue;
    const next = numbered(list as readonly WithId[], key);
    if (next !== list) patch[key] = next;
  }
  const sections = document.customSections;
  if (Array.isArray(sections)) {
    let changed = false;
    const next = sections.map((section: { key: string; entries: readonly WithId[] }) => {
      if (!section || !Array.isArray(section.entries)) return section;
      const own = `custom-${section.key}`;
      const entries = numbered(section.entries, own.length <= MAX_PREFIX_LENGTH ? own : 'custom');
      if (entries === section.entries) return section;
      changed = true;
      return { ...section, entries };
    });
    if (changed) patch.customSections = next;
  }
  return Object.keys(patch).length > 0 ? ({ ...document, ...patch } as T) : document;
}
