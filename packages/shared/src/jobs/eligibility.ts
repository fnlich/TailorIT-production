import { canonicalCertification, findCertifications } from '../match/catalogue';
import type { AuthorizationRequirement } from './facts';
import { CA_PROVINCES, COUNTRIES, KNOWN_CITIES, US_STATES } from './geo';

// v2.0 (docs/design/v2.0/06-filters-analysis.md, "Deterministic extraction"): what a posting's own words say about who
// may apply, read by rules before any AI. Pure and bounded: it reads at most MAX_TEXT characters, sentence by sentence.
//
// - A candidate-location rule is a sentence with an eligibility cue ("only", "must", "open to", "hire", ...) and a place
//   verb ("located", "reside", "candidates in", ...) or a time-zone word or token; or a list of places followed by
//   "only" ("US only"); or an exclusion ("We are unable to hire in CO, NY or WA"). A place with no cue is never a rule
//   ("Our office is in Austin, TX"): the office address is not eligibility.
// - Places come from the geo tables (US states, Canadian provinces, countries and their common forms, well-known
//   cities). A region implies its country. An exclusion of US or Canadian regions becomes every region of that country
//   but those; elsewhere an exclusion is ignored (unknown passes).
// - Time zones become standard UTC offsets ("-0800"), with ranges, "within N hours of", "overlap with" and "US time
//   zones" spread over whole hours. A token with no cue in its sentence adds nothing; "IST" counts only beside India.
// - Certifications (a closed list, the resume catalogue's plus common licences), a cover letter required or not, a
//   citizenship or permanent residence required, and "or equivalent experience" for a degree.

/** The hours either side of a zone that "overlap with <zone> business hours" allows (technical, 06's table). */
export const ELIGIBILITY_OVERLAP_HOURS = 3;
/** Characters of a posting the rules read: a posting longer than this is read up to here. */
const MAX_TEXT = 100_000;
/** The eligibility quote's length (job_facts.details, the AI schema's quote). */
const QUOTE_MAX = 200;

// ------------------------------------------------------------------------------------------------------ the text

/**
 * The text as the rules read it: line breaks kept, dashes and the minus sign as "-", and dotted abbreviations of single
 * letters joined ("U.S." is "US", "e.g." is "eg"), so a sentence never ends inside one.
 */
function prepareText(text: string): string {
  return text
    .slice(0, MAX_TEXT)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\b([A-Za-z])\.\s?([A-Za-z])\.(?:\s?([A-Za-z])\.)?/g, (_m, a: string, b: string, c: string | undefined) => `${a}${b}${c ?? ''}`);
}

const BULLETS = /[\u2022\u00b7\u25aa\u2023\u25e6\u25cf\u25a0\u25a1\u27a4\u25ba]/g;

/** The text's sentences: split at line breaks, bullets, ";", "!", "?" and a "." before a space or the end. */
export function eligibilitySentences(text: string): string[] {
  const out: string[] = [];
  for (const line of prepareText(text).split('\n')) {
    for (const part of line.replace(BULLETS, '\n').split(/\n|[;!?](?=\s|$)|\.(?=\s|$)/)) {
      const sentence = part.replace(/^[\s*>-]+/, '').replace(/\s+/g, ' ').trim();
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- the places

/** ISO 3166-2 subdivision codes of the countries whose tables are complete enough to check a region against. */
const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] as const;
const GB_NATIONS = ['ENG', 'NIR', 'SCT', 'WLS'] as const;
// India's states and union territories, with the codes ISO renamed in 2023 under both spellings.
const IN_STATES = [
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'CT', 'DH', 'DL', 'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD',
  'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TG', 'TN', 'TR', 'TS', 'UK', 'UP', 'UT', 'WB',
] as const;

const SUBDIVISIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  US: new Set(Object.keys(US_STATES)),
  CA: new Set(Object.keys(CA_PROVINCES)),
  AU: new Set(AU_STATES),
  GB: new Set(GB_NATIONS),
  IN: new Set(IN_STATES),
};

/** Countries whose every region is listed, so "every region but these" can be written out (06: US and Canada). */
const COMPLETE_TABLES = ['US', 'CA'] as const;

/** Every region of a country with a complete table, as ISO 3166-2 codes. */
function regionsOf(country: string): string[] {
  return [...(SUBDIVISIONS[country] ?? [])].map((code) => `${country}-${code}`);
}

/**
 * A region code as stored ("US-TX"): upper-cased; a country with a subdivision table (US, CA, AU, GB, IN) must list the
 * code; any other country keeps a code of the ISO 3166-2 form. A bare US state or Canadian province code ("TX") is read
 * as that country's. Null when it is none of these.
 */
export function normalizeRegionCode(value: string): string | null {
  const text = value.trim().toUpperCase().replace(/\s+/g, '');
  const full = /^([A-Z]{2})-([A-Z0-9]{1,3})$/.exec(text);
  if (full) {
    const [, country, code] = full as unknown as [string, string, string];
    if (!Object.hasOwn(COUNTRIES, country) && !SUBDIVISIONS[country]) return /^[A-Z]{2}$/.test(country) ? `${country}-${code}` : null;
    const table = SUBDIVISIONS[country];
    return table && !table.has(code) ? null : `${country}-${code}`;
  }
  if (/^[A-Z]{2}$/.test(text)) {
    if (SUBDIVISIONS.US!.has(text)) return `US-${text}`;
    if (SUBDIVISIONS.CA!.has(text)) return `CA-${text}`;
  }
  return null;
}

/** A country code as stored ("US"): two letters, upper case; "UK" reads as GB. Null otherwise. */
export function normalizeCountryCode(value: string): string | null {
  const text = value.trim().toUpperCase();
  if (text === 'UK') return 'GB';
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

/** "Texas" -> "texas", "Québec" -> "quebec": lower case, accents and punctuation gone. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

interface Place {
  country: string;
  /** ISO 3166-2, or null for a whole country. */
  region: string | null;
}

/** Place names read in any case (several words) or with a capital first letter (one word), longest first. */
const PLACE_NAMES = new Map<string, Place>();
function addName(name: string, place: Place): void {
  const key = fold(name);
  if (key && !PLACE_NAMES.has(key)) PLACE_NAMES.set(key, place);
}
for (const [code, name] of Object.entries(US_STATES)) addName(name, { country: 'US', region: `US-${code}` });
addName('Washington DC', { country: 'US', region: 'US-DC' });
addName('Washington D C', { country: 'US', region: 'US-DC' });
for (const [code, name] of Object.entries(CA_PROVINCES)) addName(name, { country: 'CA', region: `CA-${code}` });
addName('Newfoundland', { country: 'CA', region: 'CA-NL' });
for (const [code, { name, aliases }] of Object.entries(COUNTRIES)) {
  addName(name, { country: code, region: null });
  // "us" and "u s" are the pronoun or a code (read as codes below); "america" is also North, Latin or Central America.
  for (const alias of aliases) if (alias.includes(' ') && !/^u s/.test(alias)) addName(alias, { country: code, region: null });
}
addName('the United States', { country: 'US', region: null });
addName('the States', { country: 'US', region: null });
addName('the United Kingdom', { country: 'GB', region: null });
for (const [key, city] of Object.entries(KNOWN_CITIES)) {
  // A one-word city of fewer than four letters ("sf") is too easily another word.
  if (!key.includes(' ') && key.length < 4) continue;
  const region = city.region && SUBDIVISIONS[city.country]?.has(city.region) ? `${city.country}-${city.region}` : null;
  addName(key, { country: city.country, region });
}

const NAME_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...PLACE_NAMES.keys()]
    .sort((a, b) => b.length - a.length)
    .map((key) => key.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(`[\\s.,'-]{1,3}`))
    .join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

/** Codes read only as written (upper case, a whole word): US states, Canadian provinces, a few country forms. */
const CODE_PLACES = new Map<string, Place>();
for (const code of Object.keys(US_STATES)) CODE_PLACES.set(code, { country: 'US', region: `US-${code}` });
for (const code of Object.keys(CA_PROVINCES)) CODE_PLACES.set(code, { country: 'CA', region: `CA-${code}` });
for (const [code, country] of [
  ['US', 'US'],
  ['USA', 'US'],
  ['UK', 'GB'],
  ['UAE', 'AE'],
] as const) {
  CODE_PLACES.set(code, { country, region: null });
}
const CODE_PATTERN = new RegExp(`\\b(?:${[...CODE_PLACES.keys()].sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
/** Codes that are also everyday words in capitals: read as places only beside a list's punctuation or after "in". */
const WEAK_CODES = new Set(['OR', 'IN', 'ME', 'OK', 'HI', 'AS']);

interface PlaceHit extends Place {
  start: number;
  end: number;
}

/** The places a sentence names, in order, outside the spans `masked` (time zones read already). */
function placesIn(sentence: string, masked: ReadonlyArray<readonly [number, number]>): PlaceHit[] {
  const hits: PlaceHit[] = [];
  const free = (start: number, end: number) =>
    !masked.some(([from, to]) => start < to && end > from) && !hits.some((hit) => start < hit.end && end > hit.start);
  for (const match of sentence.matchAll(NAME_PATTERN)) {
    const text = match[0];
    const start = match.index ?? 0;
    // One word: a capital first letter ("Texas", "Austin"), so a common word in lower case is not a place.
    if (!/[\s.,'-]/.test(text) && !/^\p{Lu}/u.test(text)) continue;
    const place = PLACE_NAMES.get(fold(text));
    if (place && free(start, start + text.length)) hits.push({ ...place, start, end: start + text.length });
  }
  // A sentence written in capitals has no codes to tell from its words.
  if (/\p{Ll}/u.test(sentence)) {
    for (const match of sentence.matchAll(CODE_PATTERN)) {
      const code = match[0];
      const start = match.index ?? 0;
      const end = start + code.length;
      if (WEAK_CODES.has(code)) {
        const before = sentence.slice(Math.max(0, start - 6), start);
        const after = sentence.slice(end, end + 6);
        if (!/(?:\bin|\bof|[,/(:])\s*$/i.test(before) && !/^\s*(?:[,/)]|$|or\b|and\b)/i.test(after)) continue;
      }
      const place = CODE_PLACES.get(code);
      if (place && free(start, end)) hits.push({ ...place, start, end });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

// --------------------------------------------------------------------------------------------- the time zones

/** Standard offsets in minutes of the zone abbreviations (daylight names give their zone's standard offset). */
const ZONE_ABBREVIATIONS: Readonly<Record<string, number>> = {
  PST: -480, PDT: -480, PT: -480,
  MST: -420, MDT: -420, MT: -420,
  CST: -360, CDT: -360, CT: -360,
  EST: -300, EDT: -300, ET: -300,
  AKST: -540, AKDT: -540,
  HST: -600,
  AST: -240, ADT: -240,
  NST: -210, NDT: -210,
  GMT: 0, UTC: 0, WET: 0, BST: 0,
  CET: 60, CEST: 60,
  EET: 120, EEST: 120,
  IST: 330,
  SGT: 480, AWST: 480,
  JST: 540,
  AEST: 600, AEDT: 600,
};
/** Two-letter forms that are also US state codes (MT, CT) or common letters: zones only beside a time word. */
const SHORT_ZONES = new Set(['PT', 'MT', 'CT', 'ET']);
const ABBREVIATION_PATTERN = new RegExp(`\\b(?:${Object.keys(ZONE_ABBREVIATIONS).sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');

/** Zone names, in words. */
const ZONE_WORDS: Readonly<Record<string, number>> = {
  'central european': 60,
  'eastern european': 120,
  'western european': 0,
  'india standard': 330,
  'indian standard': 330,
  pacific: -480,
  mountain: -420,
  central: -360,
  eastern: -300,
  alaska: -540,
  alaskan: -540,
  hawaii: -600,
  hawaiian: -600,
  'hawaii-aleutian': -600,
  atlantic: -240,
  newfoundland: -210,
  uk: 0,
  british: 0,
  greenwich: 0,
};
const ZONE_WORD = Object.keys(ZONE_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/[ -]/g, '[\\s-]'))
  .join('|');
const TIME_WORD = String.raw`(?:standard\s+|daylight\s+)?(?:time\s*zones?|timezones?|time|tz|business\s+hours|working\s+hours|hours)\b`;
/** A zone in words, or a list of them ("Pacific or Mountain"), followed by a time word ("time", "hours"). */
const ZONE_WORD_CHAIN = new RegExp(
  String.raw`\b(?:${ZONE_WORD})(?:\s*(?:,|\/|\bor\b|\band\b|\bto\b|-|\bthrough\b|\bthru\b)\s*(?:the\s+)?(?:${ZONE_WORD}))*\s+${TIME_WORD}`,
  'gi',
);
/** One zone in words (inside a chain; or alone in an AI answer). */
const ZONE_WORD_ONE = new RegExp(String.raw`\b(?:${ZONE_WORD})\b`, 'gi');
const UTC_OFFSET = /\b(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?:\s*:?\s*(\d{2}))?(?!\d)/gi;
const IANA_ZONE = /\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g;
/** Every US zone (Hawaii to Eastern). */
const US_ZONES = /\b(?:any\s+|all\s+|the\s+)?(?:US|USA|United\s+States|American|North\s+American)\s+time\s*zones?\b/gi;
/** The four zones of the contiguous states. */
const CONTIGUOUS_US = /\b(?:continental|contiguous)\s+(?:US|USA|United\s+States)\b|\blower\s*48\b/gi;
/** Words that make a two-letter zone a zone ("PT time zone", "within CT hours", "overlap with ET"). */
const ZONE_CONTEXT = /\btime\s*zones?\b|\btimezones?\b|\bhours\b|\boverlap/i;
const INDIA = /\bIndia(?:n)?\b/;

interface ZoneHit {
  start: number;
  end: number;
  /** One offset, or a set (a phrase naming several zones). */
  minutes: number[];
  /** A single zone: ranges and "within" apply to it. */
  single: boolean;
  /** The phrase also names a place ("continental US"). */
  place?: boolean;
}

/** minutes -> "-0800". */
function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

/** "-0800" -> -480; null when it is not an offset. */
function offsetMinutes(text: string): number | null {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(text);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

const OFFSET_CACHE = new Map<string, number | null>();

/** A zone's offset in minutes at an instant, from Intl ("GMT-05:00"); null when Intl does not know the zone. */
function offsetAt(timeZone: string, instant: Date): number | null {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value;
  if (!name) return null;
  if (name === 'GMT' || name === 'UTC') return 0;
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * An IANA zone's standard offset ("America/New_York" -> "-0500"): the lesser of its offsets on January 1 and July 1
 * (2026), so a zone south of the equator, on summer time in January, reads as its standard time too. Null when the
 * name is not a zone Intl knows.
 */
export function standardOffsetOf(timeZone: string | null | undefined): string | null {
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 64) return null;
  const name = timeZone.trim();
  if (!OFFSET_CACHE.has(name)) {
    let minutes: number | null = null;
    try {
      const january = offsetAt(name, new Date('2026-01-01T12:00:00Z'));
      const july = offsetAt(name, new Date('2026-07-01T12:00:00Z'));
      minutes = january === null || july === null ? null : Math.min(january, july);
    } catch {
      minutes = null;
    }
    if (OFFSET_CACHE.size > 500) OFFSET_CACHE.clear();
    OFFSET_CACHE.set(name, minutes);
  }
  const minutes = OFFSET_CACHE.get(name) ?? null;
  return minutes === null ? null : offsetText(minutes);
}

/** Every whole hour from `from` to `to` (both ends kept, as given). */
function spread(from: number, to: number): number[] {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const out = new Set<number>([low, high]);
  for (let at = low; at <= high; at += 60) out.add(at);
  return [...out];
}

const ALL_US = [-600, -540, -480, -420, -360, -300];
const CONTIGUOUS = [-480, -420, -360, -300];

/**
 * The zones a text names, with their spans. `rule`: a sentence of a posting (a two-letter zone counts only beside a
 * time word, a zone in words only before one, IST only beside India); `answer`: a value the AI gave as a zone, read
 * as one.
 */
function zoneHits(text: string, mode: 'rule' | 'answer'): ZoneHit[] {
  const hits: ZoneHit[] = [];
  const free = (start: number, end: number) => !hits.some((hit) => start < hit.end && end > hit.start);
  const add = (start: number, end: number, minutes: number[], single: boolean) => {
    if (free(start, end)) hits.push({ start, end, minutes, single });
  };
  for (const match of text.matchAll(UTC_OFFSET)) {
    const hours = Number(match[2]);
    const minutes = Number(match[3] ?? 0);
    if (hours > 14 || minutes >= 60) continue;
    const value = (hours * 60 + minutes) * (match[1] === '-' ? -1 : 1);
    add(match.index ?? 0, (match.index ?? 0) + match[0].length, [value], true);
  }
  for (const match of text.matchAll(IANA_ZONE)) {
    const offset = standardOffsetOf(match[0]);
    const minutes = offset === null ? null : offsetMinutes(offset);
    if (minutes !== null) add(match.index ?? 0, (match.index ?? 0) + match[0].length, [minutes], true);
  }
  for (const match of text.matchAll(US_ZONES)) add(match.index ?? 0, (match.index ?? 0) + match[0].length, ALL_US, false);
  for (const match of text.matchAll(CONTIGUOUS_US)) {
    const start = match.index ?? 0;
    if (free(start, start + match[0].length)) hits.push({ start, end: start + match[0].length, minutes: CONTIGUOUS, single: false, place: true });
  }
  // Zones in words: in a posting, a chain followed by a time word ("Pacific or Mountain time zones"); in an AI answer,
  // any.
  const wordSpans: Array<[number, number]> = [];
  if (mode === 'answer') wordSpans.push([0, text.length]);
  else for (const match of text.matchAll(ZONE_WORD_CHAIN)) wordSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  for (const [from, to] of wordSpans) {
    for (const match of text.slice(from, to).matchAll(ZONE_WORD_ONE)) {
      const key = match[0].toLowerCase().replace(/[\s-]+/g, ' ').replace('hawaii aleutian', 'hawaii-aleutian');
      const minutes = ZONE_WORDS[key];
      if (minutes === undefined) continue;
      if ((key === 'uk' || key === 'british') && !/^\s*time\b/i.test(text.slice(from + (match.index ?? 0) + match[0].length))) continue;
      const start = from + (match.index ?? 0);
      add(start, start + match[0].length, [minutes], true);
    }
  }
  const context = mode === 'answer' || ZONE_CONTEXT.test(text);
  const abbreviations = [...text.matchAll(ABBREVIATION_PATTERN)];
  const longZone = abbreviations.some((match) => !SHORT_ZONES.has(match[0]) && match[0] !== 'IST');
  for (const match of abbreviations) {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;
    if (token === 'IST' && !INDIA.test(text)) continue;
    if (SHORT_ZONES.has(token)) {
      // "PT/ET", "CT time": a zone; "located in CT": Connecticut.
      const beside = /^\s*(?:time\b|hours\b|zones?\b|\/\s*(?:PT|MT|CT|ET)\b|\)?\s*(?:time\s*zones?|hours))/i.test(text.slice(end)) ||
        /(?:\b(?:PT|MT|CT|ET)\s*\/\s*)$/.test(text.slice(0, start));
      if (mode === 'rule' && !beside && !(context || longZone)) continue;
    }
    add(start, end, [ZONE_ABBREVIATIONS[token]!], true);
  }
  return hits.sort((a, b) => a.start - b.start);
}

const RANGE_BETWEEN = /^\s*(?:to|-|through|thru|until|and)\s*$/i;
const WITHIN = /(?:within|\+\/-|\+-|\u00b1|plus\s+or\s+minus)\s*(\d{1,2})\s*(?:hours?|hrs?|h)\s*(?:of|from)?\s*(?:the\s+)?$/i;
const OVERLAP = /overlap(?:ping|s)?\b[^.]{0,60}?(?:with|during|in)\s+(?:the\s+)?$/i;

/** The standard offsets a text's zones allow, with ranges, "within N hours of" and "overlap with" spread out. */
function offsetsOf(text: string, mode: 'rule' | 'answer'): { offsets: number[]; spans: Array<[number, number]> } {
  const hits = zoneHits(text, mode);
  const out = new Set<number>();
  const used = new Set<number>();
  for (let index = 0; index < hits.length; index += 1) {
    if (used.has(index)) continue;
    const hit = hits[index]!;
    const before = text.slice(Math.max(0, hit.start - 80), hit.start);
    const next = hits[index + 1];
    if (hit.single && next?.single && RANGE_BETWEEN.test(text.slice(hit.end, next.start)) &&
      (!/^\s*and\s*$/i.test(text.slice(hit.end, next.start)) || /\bbetween\s+(?:the\s+)?$/i.test(before))) {
      for (const minutes of spread(hit.minutes[0]!, next.minutes[0]!)) out.add(minutes);
      used.add(index + 1);
      continue;
    }
    const within = WITHIN.exec(before);
    if (hit.single && within) {
      const hours = Math.min(12, Number(within[1]));
      for (let k = -hours; k <= hours; k += 1) out.add(hit.minutes[0]! + k * 60);
      continue;
    }
    if (hit.single && OVERLAP.test(before)) {
      for (let k = -ELIGIBILITY_OVERLAP_HOURS; k <= ELIGIBILITY_OVERLAP_HOURS; k += 1) out.add(hit.minutes[0]! + k * 60);
      continue;
    }
    for (const minutes of hit.minutes) out.add(minutes);
  }
  const offsets = [...out].filter((minutes) => minutes >= -720 && minutes <= 840).sort((a, b) => a - b);
  // "continental US" also names the country: its span stays readable as a place.
  return { offsets, spans: hits.filter((hit) => !hit.place).map((hit) => [hit.start, hit.end]) };
}

/**
 * Time zones as the AI's v2 answer or a posting writes them ("PST", "Eastern", "UTC-5", "US time zones", "within 2 hours
 * of EST", "America/Chicago") as the standard UTC offsets they allow, sorted, each once ("-0800"). Values it cannot
 * read add nothing ("IST" without India).
 */
export function normalizeTimeZones(texts: readonly string[]): string[] {
  const out = new Set<number>();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue;
    for (const minutes of offsetsOf(prepareText(text.slice(0, 200)), 'answer').offsets) out.add(minutes);
  }
  return [...out].sort((a, b) => a - b).map(offsetText);
}

// ------------------------------------------------------------------------------------------- location rules

const CUE = /\b(?:only|must|require|requires|required|requirement|requirements|need to|needs to|eligible|open to|consider|considering|accept|accepting|hire|hiring)\b/i;
const PLACE_VERB =
  /\b(?:located|based|reside|resides|residing|residency|residents?|live|lives|living|work(?:ing)?\s+from|in\s+the\s+following|candidates\s+in|applicants\s+in)\b/i;
/** "We are unable to hire in", "not open to candidates in", "cannot employ": every place after it is excluded. */
const NOT_HIRING =
  /\b(?:unable\s+to|cannot|can\s*not|can't|not\s+able\s+to|do\s+not|don't|does\s+not|doesn't|are\s+not|is\s+not|aren't|isn't|will\s+not|won't|not)\s+(?:currently\s+|presently\s+|yet\s+)?(?:able\s+to\s+)?(?:hire|hiring|employ|employing|consider|considering|accept|accepting|open|eligible|available|support|supporting|recruit|recruiting)\b/i;
/** "excluding", "except": the places after it are excluded, in a sentence that is otherwise a rule. */
const EXCEPT = /\b(?:excluding|except(?:\s+for)?|with\s+the\s+exception\s+of|not\s+including)\b/i;
/** In an exclusion, a place after "outside" is where people may be ("cannot hire outside the US"). */
const OUTSIDE = /\boutside\s+(?:of\s+)?(?:the\s+)?$/i;
const RULE_HINT = /\b(?:remote|hire|hiring|candidates?|applicants?|residents?)\b/i;

/** A candidate-location rule found in a posting: allowed places, excluded places, offsets, and its sentence. */
export interface EligibilityRules {
  /** ISO 3166-1 alpha-2, each once, sorted. */
  countries: string[];
  /** ISO 3166-2, each once, sorted. */
  regions: string[];
  /** Standard offsets, "±HHMM", sorted. */
  utcOffsets: string[];
  /** The first rule's sentence, at most 200 characters; null when no rule was found. */
  quote: string | null;
}

interface SentenceRule {
  allowed: Place[];
  excluded: Place[];
  offsets: number[];
}

/** One sentence's rule, or null when it states none. */
function sentenceRule(sentence: string): SentenceRule | null {
  const hasCue = CUE.test(sentence);
  const zones = offsetsOf(sentence, 'rule');
  const places = placesIn(sentence, zones.spans);
  const offsets = hasCue ? zones.offsets : [];
  // "US only", "TX or CA only", "(US-only)": a list of places closed by "only".
  const placeOnly = places.some((place) => /^\s*(?:-\s*)?(?:\)\s*)?only\b/i.test(sentence.slice(place.end)));
  const notHiring = NOT_HIRING.exec(sentence);
  const except = notHiring ? null : EXCEPT.exec(sentence);
  const locationRule = (hasCue && PLACE_VERB.test(sentence)) || placeOnly;
  const marker = notHiring ?? (except && (locationRule || RULE_HINT.test(sentence)) ? except : null);
  const allowed: Place[] = [];
  const excluded: Place[] = [];
  if (marker) {
    const at = marker.index ?? 0;
    for (const place of places) {
      if (place.end <= at) {
        if (locationRule || except) allowed.push(place);
      } else if (OUTSIDE.test(sentence.slice(Math.max(0, place.start - 30), place.start))) allowed.push(place);
      else excluded.push(place);
    }
  } else if (locationRule) {
    allowed.push(...places);
  }
  if (allowed.length === 0 && excluded.length === 0 && offsets.length === 0) return null;
  return { allowed, excluded, offsets };
}

/**
 * The candidate-location rules of a posting's text (06's rules): the places and time zones its rule sentences allow,
 * the excluded US and Canadian regions written out as the rest of their country, and the first rule sentence.
 */
export function extractEligibility(texts: ReadonlyArray<string | null | undefined>): EligibilityRules {
  const countries = new Set<string>();
  const regions = new Set<string>();
  const offsets = new Set<number>();
  const excludedRegions = new Set<string>();
  const excludedCountries = new Set<string>();
  let quote: string | null = null;
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue;
    for (const sentence of eligibilitySentences(text)) {
      const rule = sentenceRule(sentence);
      if (!rule) continue;
      if (quote === null && (rule.allowed.length > 0 || rule.offsets.length > 0 || rule.excluded.length > 0)) {
        quote = sentence.slice(0, QUOTE_MAX).trim();
      }
      for (const place of rule.allowed) {
        countries.add(place.country);
        if (place.region) regions.add(place.region);
      }
      for (const place of rule.excluded) {
        if (place.region) excludedRegions.add(place.region);
        else excludedCountries.add(place.country);
      }
      for (const minutes of rule.offsets) offsets.add(minutes);
    }
  }
  // An exclusion of regions of a country whose table is complete: every region of it but those (within the regions
  // allowed of it, when some are). Elsewhere an exclusion is ignored.
  for (const country of COMPLETE_TABLES) {
    const excluded = [...excludedRegions].filter((region) => region.startsWith(`${country}-`));
    if (excluded.length === 0) continue;
    const allowedHere = [...regions].filter((region) => region.startsWith(`${country}-`));
    const base = allowedHere.length > 0 ? allowedHere : regionsOf(country);
    for (const region of allowedHere) regions.delete(region);
    for (const region of base) if (!excluded.includes(region)) regions.add(region);
    countries.add(country);
  }
  for (const country of excludedCountries) countries.delete(country);
  return {
    countries: [...countries].sort(),
    regions: [...regions].sort(),
    utcOffsets: [...offsets].sort((a, b) => a - b).map(offsetText),
    quote,
  };
}

/**
 * The AI's v2 candidateEligibility, normalized for storage: country codes upper-cased ("UK" is GB) and kept when they
 * are two letters; regions checked against the subdivision tables (normalizeRegionCode); time zones read as offsets
 * (normalizeTimeZones); the quote trimmed to 200 characters.
 */
export function normalizeEligibilityAnswer(value: {
  countries?: readonly unknown[] | null;
  regions?: readonly unknown[] | null;
  timeZones?: readonly unknown[] | null;
  quote?: unknown;
}): { countries: string[]; regions: string[]; timeZones: string[]; quote: string | null } {
  const strings = (list: readonly unknown[] | null | undefined) =>
    (Array.isArray(list) ? list : []).filter((item): item is string => typeof item === 'string');
  const countries = [...new Set(strings(value.countries).map(normalizeCountryCode).filter((code): code is string => code !== null))];
  const regions = [...new Set(strings(value.regions).map(normalizeRegionCode).filter((code): code is string => code !== null))];
  const quote = typeof value.quote === 'string' && value.quote.trim() ? value.quote.replace(/\s+/g, ' ').trim().slice(0, QUOTE_MAX) : null;
  return {
    countries: countries.sort().slice(0, 60),
    regions: regions.sort().slice(0, 80),
    timeZones: normalizeTimeZones(strings(value.timeZones).slice(0, 20)).slice(0, 20),
    quote,
  };
}

/** The places a remote location allows ("Remote - TX": US-TX; "Remote, US": US); a remote location with no place adds nothing. */
export function remoteEligibility(
  locations: ReadonlyArray<{ region: string | null; countryCode: string | null; isRemote: boolean }>,
): { countries: string[]; regions: string[] } {
  const countries = new Set<string>();
  const regions = new Set<string>();
  for (const location of locations) {
    if (!location.isRemote) continue;
    const country = location.countryCode ? normalizeCountryCode(location.countryCode) : null;
    const region =
      country && location.region && /^[A-Za-z0-9]{1,3}$/.test(location.region.trim())
        ? normalizeRegionCode(`${country}-${location.region.trim()}`)
        : null;
    if (region) {
      regions.add(region);
      countries.add(region.slice(0, 2));
    } else if (country) countries.add(country);
  }
  return { countries: [...countries].sort(), regions: [...regions].sort() };
}

// ------------------------------------------------------------------------------------------- certifications

/** Licences a posting often requires that the resume catalogue (match/catalogue.ts) does not list. */
const EXTRA_LICENCES: ReadonlyArray<{ name: string; patterns: readonly RegExp[] }> = [
  { name: 'Registered Nurse (RN)', patterns: [/\bRN\b/g, /\bregistered nurse\b/gi] },
  { name: 'Licensed Practical Nurse (LPN)', patterns: [/\bLPN\b/g, /\blicensed (?:practical|vocational) nurse\b/gi] },
  { name: 'Certified Nursing Assistant (CNA)', patterns: [/\bCNA\b/g, /\bcertified nursing assistant\b/gi] },
  { name: "Commercial Driver's License (CDL)", patterns: [/\bCDL\b/g, /\bcommercial driver'?s licen[cs]e\b/gi] },
  {
    name: 'Professional Engineer (PE)',
    patterns: [/\bPE licen[cs](?:e|ure)\b/g, /\bprofessional engineer(?:ing)? licen[cs](?:e|ure)\b/gi, /\blicensed professional engineer\b/gi],
  },
  { name: 'Engineer in Training (EIT)', patterns: [/\bEIT\b/g, /\bengineer[\s-]in[\s-]training\b/gi] },
  { name: 'Basic Life Support (BLS)', patterns: [/\bBLS\b/g, /\bbasic life support\b/gi] },
  { name: 'Advanced Cardiovascular Life Support (ACLS)', patterns: [/\bACLS\b/g, /\badvanced cardi(?:ac|ovascular) life support\b/gi] },
  { name: 'Pediatric Advanced Life Support (PALS)', patterns: [/\bPALS\b/g, /\bpediatric advanced life support\b/gi] },
  { name: 'Board Certified Behavior Analyst (BCBA)', patterns: [/\bBCBA\b/g, /\bboard certified behavio(?:u)?r analyst\b/gi] },
  { name: 'CPR', patterns: [/\bCPR\b/g] },
];

/** The extra licences a text names, in the order it names them. */
function extraLicencesIn(text: string): string[] {
  const found: Array<[number, string]> = [];
  for (const licence of EXTRA_LICENCES) {
    let first = Number.POSITIVE_INFINITY;
    for (const pattern of licence.patterns) {
      for (const match of text.matchAll(pattern)) first = Math.min(first, match.index ?? 0);
    }
    if (Number.isFinite(first)) found.push([first, licence.name]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, name]) => name);
}

/** Two names of one certification, after the words certKey drops: the catalogue's spelling and a common other. */
const CERT_KEY_ALIASES: Readonly<Record<string, string>> = {
  'aws solutions architect associate': 'aws solutions architect',
  'aws solutions architect professional': 'aws solutions architect',
  'pmp project management professional': 'pmp',
  'project management professional': 'pmp',
  'security+': 'comptia security+',
  'network+': 'comptia network+',
  'a+': 'comptia a+',
};

/**
 * The key certifications are compared by (06's certKey): a known certification's canonical name (the resume
 * catalogue's, or a licence above), lower-cased, punctuation and the words "certified", "certification",
 * "certificate", "license" and "licence" removed, spaces collapsed, an alias table applied. '' when nothing is left.
 */
export function certKey(name: string): string {
  if (typeof name !== 'string' || !name.trim()) return '';
  const text = name.slice(0, 200);
  const canonical = canonicalCertification(text) ?? extraLicencesIn(text)[0] ?? text;
  const key = canonical
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .replace(/\b(?:certified|certification|certifications|certificate|license|licence|licensed|licensure)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (CERT_KEY_ALIASES[key] ?? key).slice(0, 80);
}

/** A certification a posting names, required or preferred, with its key. */
export interface FoundCertification {
  name: string;
  key: string;
  required: boolean;
}

const REQUIRED_CUE = /\b(?:required|requires?|requirement|mandatory|must\s+(?:hold|have|possess|obtain|maintain|be|carry)|certification\s+required)\b/i;
const PREFERRED_CUE = /\b(?:preferred|prefer|a\s+plus|nice\s+to\s+have|bonus|desired|desirable|advantageous|ideally)\b/i;
const CERT_CONTEXT = /\bcertifi|\blicen[cs]|\bcredential/i;
/** A heading that sets the kind of what follows it. */
const PREFERRED_HEADING = /\b(?:preferred|nice\s+to\s+have|bonus|desired|pluses|a\s+plus)\b/i;
const REQUIRED_HEADING = /\b(?:requirements?|required|qualifications|must\s+haves?|what\s+you(?:'ll)?\s+need|minimum)\b/i;

/** The certifications a sentence names: the catalogue's (its ambiguous codes only when the sentence says "certified"
 *  or "licence") and the licences above. */
function certificationsOf(sentence: string): string[] {
  const catalogue = findCertifications(sentence, { max: 20, assumeContext: CERT_CONTEXT.test(sentence) });
  return [...new Set([...catalogue, ...extraLicencesIn(sentence)])];
}

/**
 * The certifications a posting requires or prefers (06: a closed list matched in sentences with "required", "must
 * hold", "must have", "certification required" (required) or "preferred", "a plus", "nice to have" (preferred); a
 * bullet under a "Requirements" or "Preferred" heading takes the heading's kind). Each once, required first.
 */
export function extractCertifications(text: string): FoundCertification[] {
  const found = new Map<string, FoundCertification>();
  let heading: 'required' | 'preferred' | null = null;
  for (const rawLine of prepareText(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // A short line without an end mark is a heading: it sets the kind of the lines under it.
    if (line.length <= 60 && !/[.;!?]$/.test(line) && !/^[\u2022\u00b7*-]/.test(line) && line.split(/\s+/).length <= 7) {
      heading = PREFERRED_HEADING.test(line) ? 'preferred' : REQUIRED_HEADING.test(line) ? 'required' : null;
      continue;
    }
    for (const sentence of eligibilitySentences(line)) {
      const names = certificationsOf(sentence);
      if (names.length === 0) continue;
      const preferred = PREFERRED_CUE.exec(sentence);
      const required = REQUIRED_CUE.exec(sentence);
      for (const name of names) {
        let kind: 'required' | 'preferred' | null;
        if (preferred && required) {
          // Both: the cue nearest the name.
          const at = sentence.toLowerCase().indexOf(name.toLowerCase().split(' ')[0] ?? '');
          kind = Math.abs((preferred.index ?? 0) - at) < Math.abs((required.index ?? 0) - at) ? 'preferred' : 'required';
        } else kind = preferred ? 'preferred' : required ? 'required' : heading;
        if (!kind) continue;
        const key = certKey(name);
        if (!key) continue;
        const known = found.get(key);
        if (!known || (!known.required && kind === 'required')) found.set(key, { name: name.slice(0, 120), key, required: kind === 'required' });
      }
    }
  }
  return [...found.values()].sort((a, b) => Number(b.required) - Number(a.required));
}

// -------------------------------------------------------------------------- the letter, authorization, degree

const NO_LETTER =
  /\bno\s+cover\s*letters?\b|\bcover\s*letters?\s+(?:is\s+|are\s+)?(?:not\s+(?:required|necessary|needed|mandatory)|optional|unnecessary)\b|\b(?:do\s+not|don't|no\s+need\s+to)\s+(?:include|send|submit|attach)\s+(?:a\s+)?cover\s*letter/i;
const LETTER = /cover\s*letter[^.]{0,40}\b(required|must|mandatory)\b|\b(required|must include|please include)[^.]{0,40}cover\s*letter/i;

/** 06: "cover letter (is) required" and the like: true; "no cover letter needed", "cover letter optional": false; else null. */
export function coverLetterRule(text: string): boolean | null {
  const prepared = prepareText(text);
  if (NO_LETTER.test(prepared)) return false;
  return LETTER.test(prepared) ? true : null;
}

const CITIZEN_COUNTRY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:US|USA|United\s+States|American)\b/, 'US'],
  [/\b(?:Canadian|Canada)\b/, 'CA'],
  [/\b(?:UK|British|United\s+Kingdom)\b/, 'GB'],
];
const CITIZEN_REQUIRED =
  /\b(?:US|USA|United\s+States|American|Canadian|Canada|UK|British|United\s+Kingdom)\s+citizen(?:s|ship)?\b[^.]{0,40}\b(?:required|is\s+required|only|mandatory|a\s+must)\b|\b(?:must\s+(?:be|hold|have|possess)|requires?|required|only)\b[^.]{0,30}\b(?:US|USA|United\s+States|American|Canadian|Canada|UK|British|United\s+Kingdom)\s+citizen(?:s|ship)?\b/i;
const PERMANENT_RESIDENT = /\bgreen\s*card\b|\bpermanent\s+residen(?:t|ts|ce|cy)\b|\b(?:US|USA)\s+person\b/i;
const NOT_REQUIRED = /\bnot\s+(?:required|necessary|needed)\b/i;

/**
 * 06's authorization rules: "U.S. citizenship is required", "must be a U.S. citizen" give `citizen` (of the country
 * named: the US, Canada or the UK); "green card or citizen", "U.S. citizens or permanent residents", "U.S. person" give
 * `permanent_resident`. Null when the text says neither.
 */
export function authorizationRule(text: string): { authorization: AuthorizationRequirement; country: string | null } | null {
  let citizen: { authorization: AuthorizationRequirement; country: string | null } | null = null;
  for (const sentence of eligibilitySentences(text)) {
    if (NOT_REQUIRED.test(sentence) && /citizen|green\s*card|permanent/i.test(sentence)) continue;
    const required = CITIZEN_REQUIRED.exec(sentence);
    if (PERMANENT_RESIDENT.test(sentence) && (required || /\bcitizens?\b/i.test(sentence) || /\b(?:must|required|only)\b/i.test(sentence))) {
      const named = CITIZEN_COUNTRY.find(([pattern]) => pattern.test(sentence))?.[1] ?? (/green\s*card/i.test(sentence) ? 'US' : null);
      return { authorization: 'permanent_resident', country: named };
    }
    if (required && !citizen) {
      const country = CITIZEN_COUNTRY.find(([pattern]) => pattern.test(required[0]))?.[1] ?? null;
      citizen = { authorization: 'citizen', country };
    }
  }
  return citizen;
}

const OR_EQUIVALENT =
  /\bor\s+(?:an?\s+)?equivalent\b|\bequivalent\s+(?:practical\s+|work\s+|professional\s+|relevant\s+|combination\s+of\s+)?(?:experience|education)\b|\bin\s+lieu\s+of\s+(?:a\s+)?degree\b/i;

/** Whether a posting accepts equivalent experience instead of a degree. */
export function degreeOrEquivalentRule(text: string): boolean {
  return OR_EQUIVALENT.test(prepareText(text));
}

// ------------------------------------------------------------------------------------------------- all of it

/** What the rules read of one posting (buildJobFacts' `deterministic` source). */
export interface DeterministicFacts {
  /** The candidate-location rules of the description and the location text. */
  eligibility: EligibilityRules;
  /** The places the job's remote locations allow. */
  remote: { countries: string[]; regions: string[] };
  certifications: FoundCertification[];
  coverLetterRequired: boolean | null;
  authorization: AuthorizationRequirement | null;
  citizenshipCountry: string | null;
  degreeOrEquivalent: boolean;
}

/**
 * Every rule over a posting: the full description text (never the trimmed prompt text) and the location text, and the
 * job's parsed locations for the remote rule. No AI.
 */
export function extractDeterministicFacts(input: {
  description: string;
  locationsText?: string | null;
  locations?: ReadonlyArray<{ region: string | null; countryCode: string | null; isRemote: boolean }>;
}): DeterministicFacts {
  const description = typeof input.description === 'string' ? input.description : '';
  const authorization = authorizationRule(description);
  return {
    eligibility: extractEligibility([description, input.locationsText]),
    remote: remoteEligibility(input.locations ?? []),
    certifications: extractCertifications(description),
    coverLetterRequired: coverLetterRule(description),
    authorization: authorization?.authorization ?? null,
    citizenshipCountry: authorization?.country ?? null,
    degreeOrEquivalent: degreeOrEquivalentRule(description),
  };
}
