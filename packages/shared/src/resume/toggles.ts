// The per-entry field toggles of the resume editor (Enhancv's entry Settings) and the header's. An entry stores the
// keys it hides in `hidden`; a legacy entry stores none and shows what it has. A new entry starts with the toggles of
// the entry before it, as in Enhancv.

export interface EntryToggle {
  /** What `hidden` stores. */
  key: string;
  /** The Settings checkbox's label. */
  label: string;
  /** The entry properties it controls. */
  fields: readonly string[];
  /** Shown while the entry has no `hidden` list and no content in `fields`. */
  defaultOn: boolean;
}

export type ToggleKind =
  | 'experience'
  | 'strengths'
  | 'education'
  | 'certifications'
  | 'projects'
  | 'volunteering'
  | 'awards'
  | 'publications'
  | 'courses'
  | 'languages'
  | 'references'
  | 'custom';

const on = (key: string, label: string, fields: readonly string[] = [key]): EntryToggle => ({
  key,
  label: `Show ${label}`,
  fields,
  defaultOn: true,
});
const off = (key: string, label: string, fields: readonly string[] = [key]): EntryToggle => ({
  key,
  label: `Show ${label}`,
  fields,
  defaultOn: false,
});

const PERIOD = ['startDate', 'endDate'] as const;
const BULLETS = ['achievements'] as const;

/** Each kind's toggles in the order Settings lists them. A kind's name field (company, degree...) has none. */
export const ENTRY_TOGGLES: Readonly<Record<ToggleKind, readonly EntryToggle[]>> = {
  experience: [
    on('title', 'title'),
    on('company', 'company'),
    on('period', 'period', PERIOD),
    on('location', 'location'),
    on('description', 'description'),
    on('bullets', 'bullets', BULLETS),
  ],
  strengths: [on('title', 'title'), on('description', 'description')],
  education: [
    on('degree', 'degree'),
    on('institution', 'institution'),
    on('period', 'period', PERIOD),
    off('location', 'location'),
    off('gpa', 'GPA'),
    off('bullets', 'bullets', BULLETS),
  ],
  certifications: [
    on('issuer', 'issuer'),
    on('date', 'date'),
    off('expiry', 'expiry date', ['expiryDate']),
    off('credentialId', 'credential ID'),
  ],
  projects: [
    on('role', 'role'),
    on('period', 'period', PERIOD),
    on('link', 'link'),
    on('description', 'description'),
    on('bullets', 'bullets', BULLETS),
  ],
  volunteering: [
    on('organization', 'organization'),
    on('period', 'period', PERIOD),
    off('location', 'location'),
    on('description', 'description'),
    off('bullets', 'bullets', BULLETS),
  ],
  awards: [on('issuer', 'issuer'), on('date', 'date'), on('description', 'description')],
  publications: [on('publisher', 'publisher'), on('date', 'date'), on('link', 'link'), on('description', 'description')],
  courses: [on('institution', 'institution'), on('date', 'date')],
  // The proficiency label and the dots are options of the whole section, not toggles of one entry.
  languages: [],
  references: [on('title', 'title'), on('company', 'company'), on('email', 'email'), on('phone', 'phone')],
  custom: [
    on('subheading', 'subheading'),
    on('period', 'period', PERIOD),
    on('location', 'location'),
    on('description', 'description'),
    on('bullets', 'bullets', BULLETS),
  ],
};

export function togglesOf(kind: ToggleKind): readonly EntryToggle[] {
  return ENTRY_TOGGLES[kind];
}

/** The keys a new entry hides when there is no entry before it to copy: the toggles that are off by default. */
export function defaultHidden(kind: ToggleKind): string[] {
  return ENTRY_TOGGLES[kind].filter((toggle) => !toggle.defaultOn).map((toggle) => toggle.key);
}

type Hideable = { hidden?: readonly string[] };

function hasContent(entry: object, fields: readonly string[]): boolean {
  const values = entry as Record<string, unknown>;
  return fields.some((field) => {
    const value = values[field];
    if (typeof value === 'string') return value.trim() !== '';
    return Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim() !== '');
  });
}

/**
 * Whether the entry prints the field `key` stands for. A `hidden` list is the whole story: shown unless listed. With
 * none (a legacy entry, or one not yet toggled) a field is shown when its toggle is on by default or the entry has
 * something in it. A key that is no toggle of the kind is not switchable, so it is shown.
 */
export function isFieldShown(kind: ToggleKind, entry: object, key: string): boolean {
  const toggle = ENTRY_TOGGLES[kind].find((candidate) => candidate.key === key);
  if (!toggle) return true;
  const hidden = (entry as Hideable).hidden;
  if (Array.isArray(hidden)) return !hidden.includes(key);
  return toggle.defaultOn || hasContent(entry, toggle.fields);
}

/** The `hidden` list of an entry added after `previous`: a copy of its list, or the kind's defaults. */
export function hiddenForNewEntry(kind: ToggleKind, previous?: Hideable | null): string[] {
  const copied = sanitizeHidden(kind, previous?.hidden);
  return copied ?? defaultHidden(kind);
}

/** A `hidden` list from untrusted input: the kind's toggle keys once each, in table order; undefined when it is no list. */
export function sanitizeHidden(kind: ToggleKind, value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return ENTRY_TOGGLES[kind].filter((toggle) => value.includes(toggle.key)).map((toggle) => toggle.key);
}

// ------------------------------------------------------------------------------------------------------ header

/** The details under the name that Header Settings can hide. */
export const HEADER_FIELDS = ['title', 'phone', 'email', 'location', 'linkedin', 'github', 'portfolio'] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];

export const HEADER_TOGGLES: readonly { key: HeaderField; label: string }[] = [
  { key: 'title', label: 'Show title' },
  { key: 'phone', label: 'Show phone' },
  { key: 'email', label: 'Show email' },
  { key: 'location', label: 'Show location' },
  { key: 'linkedin', label: 'Show LinkedIn' },
  { key: 'github', label: 'Show GitHub' },
  { key: 'portfolio', label: 'Show portfolio' },
];

/** Whether the header prints `field`: every one does until it is listed in `hidden`. */
export function isHeaderFieldShown(header: { hidden?: readonly string[] } | null | undefined, field: HeaderField): boolean {
  return !header?.hidden?.includes(field);
}
