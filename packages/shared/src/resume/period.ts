import { monthNumber } from '../format/dates';
import { monthIndex, parseResumeDate, type ResumeDate } from './years';

// The structured dates the resume editor works with. The stored strings (`startDate`, `endDate`, `date`,
// `expiryDate`) stay as a canonical mirror that older consumers, the years analysis and the matcher read. The input
// that carries a period wins and the strings are derived from it (`formatPeriod`); strings alone are parsed into one
// (`parsePeriod`). Text that is not understood is kept as typed in `raw`, per side, so a round trip never loses it.

/** A date as the editor picks it: a year, and its month when it says (year only is allowed). */
export interface DatePart {
  /** 1900-2200. */
  y: number;
  /** 1-12. */
  m?: number;
}

export interface Period {
  from?: DatePart;
  to?: DatePart;
  /** The end is "Present" (or `ongoingText`); it wins over `to`, which is kept for when it is switched off. */
  ongoing?: boolean;
  /** The printed word for an ongoing end, at most 20 characters; absent means "Present". */
  ongoingText?: string;
  /** Legacy text that could not be understood, per side, shown until the user edits that side. */
  raw?: { start?: string; end?: string };
}

const FIRST_YEAR = 1900;
const LAST_YEAR = 2200;
const ONGOING_DEFAULT = 'Present';
const MAX_ONGOING_LENGTH = 20;
const MAX_RAW_LENGTH = 100;

type Record_ = Record<string, unknown>;

function isPlainRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Cut to `max` characters, never between the two halves of a surrogate pair, and trimmed. */
function cut(text: string, max: number): string {
  let end = Math.min(text.length, max);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1;
  return text.slice(0, end).trim();
}

/** A custom word for an ongoing end, on one line; undefined for none, or for the default. */
function customWord(value: unknown): string | undefined {
  const word = cut(trimmed(value).replace(/\s+/g, ' '), MAX_ONGOING_LENGTH);
  return word && word.toLowerCase() !== ONGOING_DEFAULT.toLowerCase() ? word : undefined;
}

function partOf(date: ResumeDate): DatePart {
  return date.month === null ? { y: date.year } : { y: date.year, m: date.month };
}

/**
 * `parseResumeDate`, except that a date is read only when its text says nothing beyond the year and month: a season
 * ("Summer 2019"), a day ("03/15/2019") or a second number ("2019 - 2021") would be lost in the canonical form, so
 * that text stays as typed.
 */
function readDate(text: string): ResumeDate | 'present' | null {
  const date = parseResumeDate(text);
  if (date === null || date === 'present') return date;
  const word = /\p{L}+/u.exec(text);
  if (word && monthNumber(word[0]) === null) return null;
  const numbers = text.match(/\d+/g)?.length ?? 0;
  return numbers <= (date.month !== null && !word ? 2 : 1) ? date : null;
}

// ------------------------------------------------------------------------------------------ strings <-> period

/** Canonical text of a date: "03/2019", or "2019" without a month. */
export function formatDate(part: DatePart): string {
  const year = String(part.y);
  return part.m === undefined ? year : `${String(part.m).padStart(2, '0')}/${year}`;
}

/**
 * The period a start and an end text say. Blank text is absent; a start that reads as Present is kept as typed, and
 * an end that does reads as ongoing, keeping its own word ("Current", "till date") unless it is "Present".
 */
export function parsePeriod(startText: string, endText: string): Period {
  const period: Period = {};
  const raw: { start?: string; end?: string } = {};
  const start = trimmed(startText);
  const end = trimmed(endText);
  if (start) {
    const date = readDate(start);
    if (date && date !== 'present') period.from = partOf(date);
    else raw.start = start;
  }
  if (end) {
    const date = readDate(end);
    if (date === 'present') {
      period.ongoing = true;
      const word = customWord(end);
      if (word) period.ongoingText = word;
    } else if (date) {
      period.to = partOf(date);
    } else {
      raw.end = end;
    }
  }
  if (raw.start !== undefined || raw.end !== undefined) period.raw = raw;
  return period;
}

function startOf(period: Period): string {
  return period.from ? formatDate(period.from) : (period.raw?.start ?? '');
}

function endOf(period: Period, ongoingWord: string): string {
  if (period.ongoing) return ongoingWord;
  return period.to ? formatDate(period.to) : (period.raw?.end ?? '');
}

/** The canonical `startDate` and `endDate`: a side with a date prints it, otherwise its `raw` text. */
export function formatPeriod(period: Period): { startDate: string; endDate: string } {
  return { startDate: startOf(period), endDate: endOf(period, period.ongoingText?.trim() || ONGOING_DEFAULT) };
}

/** The printed form: "01/2020 - Present", "2019 - 2021", "01/2020" (a start only), or '' for nothing. */
export function periodText(period: Period): string {
  const { startDate, endDate } = formatPeriod(period);
  return [startDate, endDate].filter(Boolean).join(' - ');
}

/** What the years analysis reads: `formatPeriod`, but an ongoing end is always "Present", a word it knows. */
export function analysisDates(period: Period): { startDate: string; endDate: string } {
  return { startDate: startOf(period), endDate: endOf(period, ONGOING_DEFAULT) };
}

/** Whether the end is before the start (a missing month counts as January for a start, December for an end). */
export function isEndBeforeStart({ from, to, ongoing }: Period): boolean {
  if (!from || !to || ongoing) return false;
  return monthIndex(to.y, to.m ?? 12) < monthIndex(from.y, from.m ?? 1);
}

// ------------------------------------------------------------------------------------------ untrusted input

/** A whole number from a number or a numeric string; anything else (NaN, objects, arrays) is absent. */
function whole(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isNaN(number) ? undefined : Math.trunc(number);
}

/** `{y, m}` read from an object: the year clamped, the month dropped unless 1-12; no year, no date. */
function datePart(value: unknown): DatePart | undefined {
  if (!isPlainRecord(value)) return undefined;
  const year = whole(value.y);
  if (year === undefined) return undefined;
  const month = whole(value.m);
  const y = Math.min(LAST_YEAR, Math.max(FIRST_YEAR, year));
  return month !== undefined && month >= 1 && month <= 12 ? { y, m: month } : { y };
}

function rawText(value: unknown): string | undefined {
  return cut(trimmed(value), MAX_RAW_LENGTH) || undefined;
}

/**
 * A period from an untrusted object (JSON, a request): numbers coerced and clamped, strings trimmed and cut, unknown
 * keys dropped. A side with a date keeps no `raw`, and `ongoingText` stays only while the end is ongoing. Undefined
 * when nothing is left. Never throws.
 */
export function normalizePeriod(input: unknown): Period | undefined {
  if (!isPlainRecord(input)) return undefined;
  const period: Period = {};
  const from = datePart(input.from);
  const to = datePart(input.to);
  const ongoing = input.ongoing === true;
  if (from) period.from = from;
  if (to) period.to = to;
  if (ongoing) {
    period.ongoing = true;
    const word = customWord(input.ongoingText);
    if (word) period.ongoingText = word;
  }
  const raw = isPlainRecord(input.raw) ? input.raw : {};
  const start = from ? undefined : rawText(raw.start);
  const end = to || ongoing ? undefined : rawText(raw.end);
  if (start || end) period.raw = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  return Object.keys(period).length > 0 ? period : undefined;
}

// ------------------------------------------------------------------------------------------ which dates an entry has

const RANGE = { kind: 'range', start: 'startDate', end: 'endDate' } as const;
const SINGLE = { kind: 'single', date: 'date' } as const;

/** The date fields one entry list stores: a range is a `Period`, a single date a `SingleDate`. */
export type EntryDateFields =
  | { readonly kind: 'range'; readonly start: 'startDate'; readonly end: 'endDate' }
  | { readonly kind: 'single'; readonly date: 'date'; readonly expiry?: 'expiryDate' };

/** Document list -> its date fields. The custom-section entries are the lists under `customSections`. */
export const ENTRY_DATE_FIELDS = {
  experience: RANGE,
  education: RANGE,
  projects: RANGE,
  volunteering: RANGE,
  'customSections.entries': RANGE,
  certifications: { ...SINGLE, expiry: 'expiryDate' },
  awards: SINGLE,
  publications: SINGLE,
  courses: SINGLE,
} as const satisfies Readonly<Record<string, EntryDateFields>>;
export type EntryDateList = keyof typeof ENTRY_DATE_FIELDS;

// ------------------------------------------------------------------------------------------ single dates

/** A date on its own (certification, award, publication, course): the picked date, or the legacy text as typed. */
export interface SingleDate {
  y?: number;
  m?: number;
  raw?: string;
}

/** The date a text says; blank is absent, and Present or text that is not understood is kept in `raw`. */
export function parseSingleDate(text: string): SingleDate {
  const value = trimmed(text);
  if (!value) return {};
  const date = readDate(value);
  return date && date !== 'present' ? partOf(date) : { raw: value };
}

/** The canonical text: the date when there is one, otherwise `raw`. */
export function formatSingleDate(date: SingleDate): string {
  return date.y === undefined ? (date.raw ?? '') : formatDate({ y: date.y, m: date.m });
}

/** A single date from an untrusted object, as `normalizePeriod` reads a side. Undefined when nothing is left. */
export function normalizeSingleDate(input: unknown): SingleDate | undefined {
  if (!isPlainRecord(input)) return undefined;
  const part = datePart(input);
  if (part) return part;
  const raw = rawText(input.raw);
  return raw ? { raw } : undefined;
}

// ------------------------------------------------------------------------------------------ languages

export const LANGUAGE_LEVELS = [1, 2, 3, 4, 5] as const;
export type LanguageLevel = (typeof LANGUAGE_LEVELS)[number];
/** Indexed by level - 1. */
export const LANGUAGE_LEVEL_NAMES = ['Beginner', 'Intermediate', 'Advanced', 'Proficient', 'Native'] as const;

/** The name of a level (1-5); '' for anything else. */
export function languageLevelName(level: number): string {
  return Number.isInteger(level) ? (LANGUAGE_LEVEL_NAMES[level - 1] ?? '') : '';
}

// The words people write for a level, with the CEFR levels (C2 is the top of the scale, with Native).
const LEVEL_OF_WORD: Readonly<Record<string, LanguageLevel>> = {
  native: 5,
  bilingual: 5,
  'mother tongue': 5,
  c2: 5,
  fluent: 4,
  proficient: 4,
  'full professional': 4,
  c1: 4,
  advanced: 3,
  'professional working': 3,
  b2: 3,
  intermediate: 2,
  conversational: 2,
  b1: 2,
  basic: 1,
  beginner: 1,
  elementary: 1,
  'limited working': 1,
  a1: 1,
  a2: 1,
};
const LEVEL_WORDS = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:${Object.keys(LEVEL_OF_WORD)
    .map((word) => word.replace(' ', String.raw`[\s-]+`))
    .join('|')})(?![\p{L}\p{N}])`,
  'giu',
);

/** The level a proficiency label says ("Native or bilingual", "Fluent (C1)"); null for other words or conflicting ones. */
export function languageLevelOf(text: string): LanguageLevel | null {
  if (typeof text !== 'string') return null;
  const levels = new Set<LanguageLevel>();
  for (const found of text.matchAll(LEVEL_WORDS)) {
    const level = LEVEL_OF_WORD[found[0].toLowerCase().replace(/[\s-]+/g, ' ')];
    if (level) levels.add(level);
  }
  return levels.size === 1 ? ([...levels][0] ?? null) : null;
}
