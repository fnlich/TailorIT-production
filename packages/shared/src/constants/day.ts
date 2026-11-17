// The day and the auto-apply window (02-constants.md, "Day and window"). Pure, Intl only. A day key is the calendar date
// "YYYY-MM-DD", in the reset's time zone, whose reset time has passed on the wall clock; the daily AI budget and the
// Free auto-apply counter are keyed by it, so nothing ever has to reset them. Daylight saving is handled by Intl.
// v20 FIX-A (REQ-11): no default of its own: callers pass the resolved constants (DAY_RESET_TIME, DAY_RESET_TIME_ZONE,
// DAY_RESET_ZONE_LABEL, AUTO_APPLY_WINDOW_DAYS, AUTO_APPLY_WINDOW_EPOCH), whose defaults live in ./constants only.

import { MINUTE_MS, DAY_MS } from '../core/time';

/** How far firstChange looks at a time: a little more than the longest day (25 hours, when daylight saving ends). */
const HOURS_26_MS = 26 * 60 * MINUTE_MS;

type InstantInput = Date | string | number;

function msOf(instant: InstantInput): number {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new RangeError(`Not an instant: ${String(instant)}`);
  return ms;
}

/** "HH:MM" (24-hour) → minutes after midnight; null when it is not such a time. */
export function minutesOfTime(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Whether Intl.DateTimeFormat accepts `name` as a time zone. */
export function isTimeZone(name: string): boolean {
  if (!name || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();
function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    wallFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock at `ms` in `timeZone`: its calendar date, its minutes after midnight, and its UTC offset in ms. */
function wallClock(ms: number, timeZone: string): { date: string; minutes: number; offsetMs: number } {
  const parts = wallFormatter(timeZone).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const year = part('year');
  const month = part('month');
  const day = part('day');
  const hour = part('hour') % 24;
  const minute = part('minute');
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const wholeSecond = ms - (((ms % 1000) + 1000) % 1000);
  const offsetMs = Date.UTC(year, month - 1, day, hour, minute, part('second')) - wholeSecond;
  return { date, minutes: hour * 60 + minute, offsetMs };
}

/** How far back dayKeyOf looks for the clock having gone back (longer than any daylight saving change). */
const CLOCK_BACK_LOOK_MS = 3 * 60 * MINUTE_MS;

/**
 * The day key of `instant`: its calendar date in `timeZone` once the wall clock there has reached `resetTime` that day,
 * else the day before. With 00:00 in America/Los_Angeles, 2026-10-22T06:59Z is "2026-10-21" and 07:00Z is
 * "2026-10-22" (PDT, UTC-7).
 *
 * v20 FIX-A (BEH-8): the reset time is read on the wall clock, so a reset other than midnight keeps its hour on the
 * two daylight saving days (it was subtracted in absolute time: an hour off). A reset time the clock skips (2:30 as
 * daylight saving starts) comes at the first instant after it; one the clock repeats (1:30 as it ends) comes the first
 * time, and the key never goes back in the repeated hour.
 */
export function dayKeyOf(instant: InstantInput, resetTime: string, timeZone: string): string {
  const reset = minutesOfTime(resetTime);
  if (reset === null) throw new RangeError(`Not a time of day: ${resetTime}`);
  const ms = msOf(instant);
  const now = wallClock(ms, timeZone);
  if (now.minutes >= reset) return now.date;
  // Before the reset on the clock. If the clock went back within the last hours, on this same date, the day may have
  // passed the reset before it did: the wall clock just before the change says.
  const before = wallClock(ms - CLOCK_BACK_LOOK_MS, timeZone);
  if (before.offsetMs > now.offsetMs) {
    let low = ms - CLOCK_BACK_LOOK_MS;
    let high = ms;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (wallClock(middle, timeZone).offsetMs === before.offsetMs) low = middle;
      else high = middle;
    }
    const last = wallClock(low, timeZone);
    if (last.date === now.date && last.minutes >= reset) return now.date;
  }
  return addDaysToKey(now.date, -1);
}

/** The first instant after `from` (whose key is `key(from)`) where `key` changes; `key` never goes back. */
function firstChange(from: number, key: (ms: number) => string, horizonMs: number): Date {
  const start = key(from);
  let low = from;
  let high = from + horizonMs;
  while (key(high) === start) high += horizonMs;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (key(middle) === start) low = middle;
    else high = middle;
  }
  return new Date(high);
}

/** The next instant whose day key differs from `instant`'s: when today's AI budget and auto-apply count reset. */
export function nextResetAt(
  instant: InstantInput,
  resetTime: string,
  timeZone: string,
): Date {
  return firstChange(msOf(instant), (ms) => dayKeyOf(ms, resetTime, timeZone), HOURS_26_MS);
}

/** Whether `text` is a real calendar date "YYYY-MM-DD". */
export function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dayNumber(dayKey: string): number {
  if (!isCalendarDate(dayKey)) throw new RangeError(`Not a day key: ${dayKey}`);
  return Math.round(Date.parse(`${dayKey}T00:00:00.000Z`) / DAY_MS);
}

/** `dayKey` moved by `days` (negative: back). */
export function addDaysToKey(dayKey: string, days: number): string {
  return new Date((dayNumber(dayKey) + days) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The window key of `dayKey`: the first day key of the block of `windowDays` days, counted from `epoch`, that holds
 * it. With `windowDays = 1` it is `dayKey` itself. The block's last day is `windowKey + windowDays - 1`.
 */
export function windowKeyOf(dayKey: string, windowDays: number, epoch: string): string {
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new RangeError(`Not a window length: ${windowDays}`);
  const offset = dayNumber(dayKey) - dayNumber(epoch);
  return addDaysToKey(epoch, Math.floor(offset / windowDays) * windowDays);
}

/** The first and last day keys of the window that holds `dayKey` (the reservation count's BETWEEN). */
export function windowRangeOf(
  dayKey: string,
  windowDays: number,
  epoch: string,
): { start: string; end: string } {
  const start = windowKeyOf(dayKey, windowDays, epoch);
  return { start, end: addDaysToKey(start, windowDays - 1) };
}

/** The next instant whose window key differs from `instant`'s: when a multi-day auto-apply window resets. */
export function nextWindowResetAt(
  instant: InstantInput,
  resetTime: string,
  timeZone: string,
  windowDays: number,
  epoch: string,
): Date {
  const keyAt = (ms: number) => windowKeyOf(dayKeyOf(ms, resetTime, timeZone), windowDays, epoch);
  return firstChange(msOf(instant), keyAt, HOURS_26_MS);
}

/** "00:00" → "12:00 AM", "13:30" → "1:30 PM". */
export function formatTimeOfDay(time: string): string {
  const minutes = minutesOfTime(time);
  if (minutes === null) return time;
  const hours = Math.floor(minutes / 60);
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes % 60).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** The {reset_time} placeholder: resetText("00:00", "Pacific Time") is "12:00 AM Pacific Time". */
export function resetText(resetTime: string, zoneLabel: string): string {
  return `${formatTimeOfDay(resetTime)} ${zoneLabel}`.trim();
}

// Durations: ISO 8601 calendar lengths of one unit (the Paid term) --------------------------------------------------

export type DurationUnit = 'Y' | 'M' | 'W' | 'D';
/** The longest count of one unit a duration takes (P1000D). */
const DURATION_COUNT_MAX = 1000;

/** "P1M" → {count: 1, unit: 'M'}; null when it is not a calendar-only length of one unit (P1Y, P1M, P1W, P30D). */
export function parseDuration(text: string): { count: number; unit: DurationUnit } | null {
  const match = /^P([1-9]\d{0,3})([YMWD])$/.exec(text);
  if (!match) return null;
  const count = Number(match[1]);
  return count <= DURATION_COUNT_MAX ? { count, unit: match[2] as DurationUnit } : null;
}

const UNIT_WORDS: Record<DurationUnit, string> = { Y: 'year', M: 'month', W: 'week', D: 'day' };

/** "P1M" → "1 month", "P30D" → "30 days". */
export function durationText(text: string): string {
  const duration = parseDuration(text);
  if (!duration) return text;
  return `${duration.count} ${UNIT_WORDS[duration.unit]}${duration.count === 1 ? '' : 's'}`;
}

const daysInMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * `from` plus `times` × `duration`, in UTC, with month-end clamping: 2026-01-31 + P1M is 2026-02-28 (2028-02-29 in a
 * leap year). The time of day is kept. Throws on a duration that does not parse.
 */
export function addCalendarDuration(from: InstantInput, duration: string, times = 1): Date {
  const parsed = parseDuration(duration);
  if (!parsed) throw new RangeError(`Not a calendar duration: ${duration}`);
  const start = new Date(msOf(from));
  const count = parsed.count * times;
  if (parsed.unit === 'D' || parsed.unit === 'W') {
    return new Date(start.getTime() + count * (parsed.unit === 'W' ? 7 : 1) * DAY_MS);
  }
  const months = parsed.unit === 'Y' ? count * 12 : count;
  const total = start.getUTCFullYear() * 12 + start.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  const day = Math.min(start.getUTCDate(), daysInMonth(year, monthIndex));
  return new Date(
    Date.UTC(
      year,
      monthIndex,
      day,
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}
