import type { AutofillProfile, AutofillSeed } from '@tailorit/shared/autofill';

// "Fill from my resume": the seed is laid over the profile on the page, and fills only what is still empty there. A
// field is a single value ("name.first", "contact.phone.country") or a whole list ("education", "skills"): a list the
// person has started is theirs, so a seed's entries are never mixed into it. Only what the seed says it filled is
// taken, and nothing is replaced unless the person asks. Pure, so the page only draws the result.
// v32 FILL: the fields where the person's answer was kept though the resume says otherwise are named (`kept`), so the
// page can offer to use the resume's instead; the person's yes passes them back as `replace`. A value the seed took
// from the account or the job preferences (`fromSettings`) is never offered over an answer of the person's.

/**
 * The seed as the page merges it: the contract's, and (v32 FILL) which of its values are the settings'; v32 FIX-API
 * (REV-SECBEH SF-1) which the AI read from an uploaded file (marked "AI read, check it").
 */
export type MergedSeed = AutofillSeed & { fromSettings?: readonly string[]; fromAi?: readonly string[] };

export interface SeedMerge {
  profile: AutofillProfile;
  /** The fields taken from the seed ("name.first", "education"), in the profile's order. */
  filled: string[];
  /** v32 FILL: the fields that kept the person's answer though the resume's differs, in the profile's order. */
  kept: string[];
}

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Nothing typed: '' (or blanks), null, or an empty list. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return Array.isArray(value) && value.length === 0;
}

/** The fields of a profile: its single values and its lists, by path. */
function fieldsOf(value: unknown, path: string, into: string[]): void {
  if (isRecord(value)) {
    for (const [name, inner] of Object.entries(value)) fieldsOf(inner, path ? `${path}.${name}` : name, into);
  } else {
    into.push(path);
  }
}

function read(value: unknown, path: string): unknown {
  let node = value;
  for (const segment of path.split('.')) node = isRecord(node) ? node[segment] : undefined;
  return node;
}

function write(value: Rec, segments: readonly string[], inner: unknown): Rec {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  const next = rest.length === 0 ? inner : write(isRecord(value[head]) ? value[head] : {}, rest, inner);
  return { ...value, [head]: next };
}

/** Whether the seed's `filled` paths name this field, a place inside it, or a part that holds it. */
function namedBy(field: string, filled: readonly string[]): boolean {
  return filled.some((path) => path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`));
}

/** A value as two answers are compared: entries without their ids, texts trimmed and in lower case. */
function comparable(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (Array.isArray(value)) return value.map(comparable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'id')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, comparable(inner)]),
    );
  }
  return value;
}

const sameAnswer = (a: unknown, b: unknown) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

/**
 * The profile with the seed's values in its empty fields, and which fields those were; `replace` (the person's yes to
 * an earlier merge's `kept`) puts the seed's values over those fields too. v32 FILL: `defaults`, the values the page
 * was given that are no answer of the person's (a profile never saved shows the sign-in address as its email): a field
 * that still holds its default counts as empty, unless the seed's value is the settings' too.
 */
export function mergeSeed(
  current: AutofillProfile,
  seed: MergedSeed,
  replace: readonly string[] = [],
  defaults: Readonly<Record<string, unknown>> = {},
): SeedMerge {
  const fields: string[] = [];
  fieldsOf(current, '', fields);
  let profile = current as unknown as Rec;
  const filled: string[] = [];
  const kept: string[] = [];
  for (const field of fields) {
    const offered = read(seed.profile, field);
    if (isEmpty(offered) || !namedBy(field, seed.filled)) continue;
    const mine = read(current, field);
    const settings = namedBy(field, seed.fromSettings ?? []);
    const untouched = Object.hasOwn(defaults, field) && sameAnswer(mine, defaults[field]) && !settings;
    if (isEmpty(mine) || ((untouched || replace.includes(field)) && !sameAnswer(mine, offered))) {
      profile = write(profile, field.split('.'), structuredClone(offered));
      filled.push(field);
    } else if (!sameAnswer(mine, offered) && !settings) {
      kept.push(field);
    }
  }
  return { profile: profile as unknown as AutofillProfile, filled, kept };
}

/** The fields of an entry the page marks one by one (as its keys name them, after the entry's id). */
const ENTRY_FIELDS = {
  education: [
    'institution.canonicalName',
    'institution.aliases',
    'degree.level',
    'degree.type',
    'degree.field',
    'minor',
    'startDate',
    'endDate',
    'current',
    'gpa',
    'location.city',
    'location.region',
    'location.country',
  ],
  experience: [
    'company',
    'title',
    'location.city',
    'location.region',
    'location.country',
    'startDate',
    'endDate',
    'current',
    'description',
  ],
} as const;

/**
 * v32 FIX-API (SF-1): of the field keys a merge marks (seedHintKeys), those the AI read from an uploaded file: a key's
 * field (a list's whole: "education") named by the seed's `fromAi`.
 */
export function aiHintKeys(keys: readonly string[], fromAi: readonly string[] = []): string[] {
  if (fromAi.length === 0) return [];
  return keys.filter((key) => {
    const rest = key.startsWith('profile.') ? key.slice('profile.'.length) : key;
    const field = rest.startsWith('education.') || rest.startsWith('experience.') ? rest.split('.')[0]! : rest;
    return namedBy(field, fromAi);
  });
}

/**
 * The field keys to mark "From your resume" after a merge: every field with a value in an entry the seed added (by the
 * entry's id), and each other field as a whole ("profile.skills").
 */
export function seedHintKeys(profile: AutofillProfile, filled: readonly string[]): string[] {
  const keys: string[] = [];
  for (const field of filled) {
    if (field !== 'education' && field !== 'experience') {
      keys.push(`profile.${field}`);
      continue;
    }
    for (const entry of profile[field]) {
      for (const part of ENTRY_FIELDS[field]) {
        const value = read(entry, part);
        if (!isEmpty(value) && value !== false) keys.push(`profile.${field}.${entry.id}.${part}`);
      }
    }
  }
  return keys;
}
