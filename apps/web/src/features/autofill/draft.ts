import type { AutofillProfile, AutofillSensitive } from '@tailorit/shared/autofill';

// What the Profile tab edits, and the keys its fields go by. A key is a dotted path into the draft
// ("profile.name.first", "sensitive.eeo.races"), except that an education or experience entry is named by its id, never
// by its position ("profile.education.<id>.startDate"): a field's message and its "From your resume" mark follow the
// entry through a move. Validation and the server's `fields` name a place by position; `fieldKeyOf` turns that into a
// key. Pure, so the page only draws the fields.

/** Both parts of the autofill profile: they load apart but are saved together, from one revision. */
export interface AutofillDraft {
  profile: AutofillProfile;
  sensitive: AutofillSensitive;
}

/** The lists whose entries a key names by id. */
const ENTRY_LISTS: ReadonlySet<string> = new Set(['profile.education', 'profile.experience']);

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The position a key's segment names in the list at `listKey`, or -1. */
function positionIn(list: readonly unknown[], listKey: string, segment: string): number {
  if (ENTRY_LISTS.has(listKey)) return list.findIndex((entry) => isRecord(entry) && entry.id === segment);
  const index = Number(segment);
  return Number.isInteger(index) && index >= 0 && index < list.length ? index : -1;
}

const join = (key: string, segment: string) => (key ? `${key}.${segment}` : segment);

/** The value a key names, or undefined when the draft has no such place. */
export function readField(draft: AutofillDraft, key: string): unknown {
  let node: unknown = draft;
  let walked = '';
  for (const segment of key.split('.')) {
    if (Array.isArray(node)) node = node[positionIn(node, walked, segment)];
    else if (isRecord(node)) node = node[segment];
    else return undefined;
    walked = join(walked, segment);
  }
  return node;
}

function writeAt(node: unknown, segments: readonly string[], depth: number, walked: string, value: unknown): unknown {
  if (depth === segments.length) return value;
  const segment = segments[depth]!;
  if (Array.isArray(node)) {
    const at = positionIn(node, walked, segment);
    if (at < 0) return node;
    const inner = writeAt(node[at], segments, depth + 1, join(walked, segment), value);
    if (inner === node[at]) return node;
    const next = node.slice();
    next[at] = inner;
    return next;
  }
  // Only the last segment may name a new property: a missing part on the way is no such place.
  if (!isRecord(node) || (depth < segments.length - 1 && !Object.hasOwn(node, segment))) return node;
  const inner = writeAt(node[segment], segments, depth + 1, join(walked, segment), value);
  return inner === node[segment] ? node : { ...node, [segment]: inner };
}

/** The draft with the value at `key` replaced; unchanged when the draft has no such place (a removed entry). */
export function writeField(draft: AutofillDraft, key: string, value: unknown): AutofillDraft {
  return writeAt(draft, key.split('.'), 0, '', value) as AutofillDraft;
}

/** A place named by position ("profile.education.0.endDate", as zod and the server name it) as a field key. */
export function fieldKeyOf(path: string, draft: AutofillDraft): string {
  let node: unknown = draft;
  let walked = '';
  for (const segment of path.split('.')) {
    let named = segment;
    if (Array.isArray(node)) {
      const entry: unknown = node[Number(segment)];
      if (ENTRY_LISTS.has(walked) && isRecord(entry) && typeof entry.id === 'string') named = entry.id;
      node = entry;
    } else {
      node = isRecord(node) ? node[segment] : undefined;
    }
    walked = join(walked, named);
  }
  return walked;
}

/** Whether `key` is `prefix` or a place inside it. */
export function isWithin(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}.`);
}

/** An edit of `key` concerns `place` when either holds the other (a list's mark goes with an edit of one of its rows). */
const concerns = (place: string, key: string) => isWithin(place, key) || isWithin(key, place);

/** The messages without those an edit of `key` concerns. */
export function withoutMessages(messages: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [place, message] of Object.entries(messages)) if (!concerns(place, key)) next[place] = message;
  return next;
}

/** The keys without those an edit of `key` concerns. */
export function withoutKeys(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...keys].filter((place) => !concerns(place, key)));
}

/** The list with the entry `id` moved one place up (-1) or down (1). */
export function moved<T extends { id: string }>(list: readonly T[], id: string, delta: -1 | 1): T[] {
  const from = list.findIndex((entry) => entry.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry!);
  return next;
}

function trimmed<T>(value: T): T {
  if (typeof value === 'string') return value.trim() as T;
  if (Array.isArray(value)) return value.map(trimmed) as T;
  if (isRecord(value)) {
    const next: Rec = {};
    for (const [name, inner] of Object.entries(value)) next[name] = trimmed(inner);
    return next as T;
  }
  return value;
}

/**
 * A social profile as its link (snapshot round 2): a handle ("@elena_r" or "elena_r") becomes the site's address for
 * it, and an address typed without its scheme ("x.com/elena_r") gets https://. Anything else is left as typed, for the
 * save's own check to name.
 */
function socialLink(text: string, site: { host: string; hosts: RegExp; handle: RegExp }): string {
  const handle = /^@?([A-Za-z0-9_]+)$/.exec(text)?.[1];
  if (handle !== undefined && site.handle.test(handle)) return `https://${site.host}/${handle}`;
  if (site.hosts.test(text)) return `https://${text}`;
  return text;
}

const X_SITE = { host: 'x.com', hosts: /^(?:www\.)?(?:x|twitter)\.com\/\S+$/i, handle: /^[A-Za-z0-9_]{1,15}$/ };
const TELEGRAM_SITE = { host: 't.me', hosts: /^(?:t\.me|telegram\.me)\/\S+$/i, handle: /^[A-Za-z0-9_]{5,32}$/ };

/**
 * The draft as it is saved: every text trimmed, and the rows left wholly empty dropped (another link with neither label
 * nor address, a language row never filled in, an empty skill or other name, a certification never filled in). X and
 * Telegram may be typed as a handle (socialLink). The Asian subgroups go when Asian is not among the races.
 */
export function cleanDraft(draft: AutofillDraft): AutofillDraft {
  const { profile, sensitive } = trimmed(draft);
  const { races, raceSubgroups } = sensitive.eeo;
  const relatives = sensitive.legal.relativesAt;
  return {
    profile: {
      ...profile,
      links: {
        ...profile.links,
        x: socialLink(profile.links.x, X_SITE),
        telegram: socialLink(profile.links.telegram, TELEGRAM_SITE),
        other: profile.links.other.filter((link) => link.label || link.url),
      },
      education: profile.education.map((entry) => ({
        ...entry,
        institution: { ...entry.institution, aliases: entry.institution.aliases.filter(Boolean) },
      })),
      languages: profile.languages.filter((row) => row.language || row.proficiency !== null),
      skills: profile.skills.filter(Boolean),
      preferences: { ...profile.preferences, relocationPlaces: profile.preferences.relocationPlaces.filter(Boolean) },
      certifications: profile.certifications.filter((row) => row.name || row.issuer || row.year !== null),
    },
    sensitive: {
      ...sensitive,
      eeo: {
        ...sensitive.eeo,
        raceSubgroups: races.state === 'value' && races.value.includes('asian') ? raceSubgroups : [],
      },
      legal: {
        ...sensitive.legal,
        relativesAt: relatives.state === 'value' ? { state: 'value', value: relatives.value.filter(Boolean) } : relatives,
      },
    },
  };
}
