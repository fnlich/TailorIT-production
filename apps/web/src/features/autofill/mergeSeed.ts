import type { AutofillProfile, AutofillSeed } from '@tailorit/shared/autofill';

// "Fill from my resume": the seed is laid over the profile on the page, and fills only what is still empty there. A
// field is a single value ("name.first", "contact.phone.country") or a whole list ("education", "skills"): a list the
// person has started is theirs, so a seed's entries are never mixed into it. Only what the seed says it filled is
// taken, and nothing is ever replaced. Pure, so the page only draws the result.

export interface SeedMerge {
  profile: AutofillProfile;
  /** The fields taken from the seed ("name.first", "education"), in the profile's order. */
  filled: string[];
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

/** The profile with the seed's values in its empty fields, and which fields those were. */
export function mergeSeed(current: AutofillProfile, seed: AutofillSeed): SeedMerge {
  const fields: string[] = [];
  fieldsOf(current, '', fields);
  let profile = current as unknown as Rec;
  const filled: string[] = [];
  for (const field of fields) {
    const offered = read(seed.profile, field);
    if (!isEmpty(read(current, field)) || isEmpty(offered) || !namedBy(field, seed.filled)) continue;
    profile = write(profile, field.split('.'), structuredClone(offered));
    filled.push(field);
  }
  return { profile: profile as unknown as AutofillProfile, filled };
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
