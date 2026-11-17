import { validationFailed } from '../../core/http/errors';
import { DAY_MS } from '@tailorit/shared';

// v1.5 Q2: the dates the person's AI writes, read in the person's time zone (`tz`, an IANA name the AI passes when it
// knows it; else UTC, and every answer that read a date says which zone it used). Two kinds:
// - an instant, for a posting's time (postedSince / postedBetween): "12h", "1d", "7d", "2w" (rolling: that long before
//   now), "today", "yesterday", "thisWeek" (from the start of that day or week, Monday first), "YYYY-MM-DD" (from the
//   start of that day) or an ISO date-time;
// - a day range, for the tracker's dates (its events are days, "YYYY-MM-DD"): a period ("today", "yesterday",
//   "thisWeek", "lastWeek", "thisMonth", "lastMonth", "thisYear", "7d" = the last 7 days with today, "4w") or
//   from / to days ("YYYY-MM-DD", "today", "yesterday", "3d" = three days ago).

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROLLING = /^(\d{1,4})\s*([hdw])$/i;

export interface Zone {
  tz: string;
  /** False when the AI named no zone (UTC was used). */
  given: boolean;
}

/** The zone to read dates in: the AI's IANA name, else UTC. 400 for a name the runtime does not know. */
export function zoneOf(tz: string | undefined): Zone {
  if (tz === undefined || tz.trim() === '') return { tz: 'UTC', given: false };
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone;
    return { tz: resolved, given: true };
  } catch {
    throw validationFailed(`"${tz.slice(0, 64)}" is not a time zone. Use an IANA name such as America/New_York, or leave tz out for UTC.`);
  }
}

/** Minutes the zone is ahead of UTC at `at`. */
export function offsetMinutes(at: Date, tz: string): number {
  if (tz === 'UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The zone's calendar day at `at`, "YYYY-MM-DD". */
export function dayIn(at: Date, tz: string): string {
  return new Date(at.getTime() + offsetMinutes(at, tz) * 60_000).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instant the zone's `day` starts. */
export function startOfDay(day: string, tz: string): Date {
  const guess = Date.parse(`${day}T00:00:00.000Z`);
  const first = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess - offsetMinutes(new Date(first), tz) * 60_000);
}

/** Monday of the week holding `day`. */
function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

function realDay(text: string): boolean {
  return DAY.test(text) && new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10) === text;
}

const BAD_INSTANT =
  'Write a time as "12h", "1d", "7d", "2w", "today", "yesterday", "thisWeek", a day "YYYY-MM-DD" or an ISO date-time.';

/** The instant a relative or written time names (see the module's note). */
export function instantOf(text: string, now: Date, zone: Zone, field: string): Date {
  const value = text.trim();
  const rolling = ROLLING.exec(value);
  if (rolling) {
    const hours = Number(rolling[1]) * ({ h: 1, d: 24, w: 168 } as const)[rolling[2]!.toLowerCase() as 'h' | 'd' | 'w'];
    return new Date(now.getTime() - hours * 3_600_000);
  }
  const today = dayIn(now, zone.tz);
  switch (value.toLowerCase()) {
    case 'today':
      return startOfDay(today, zone.tz);
    case 'yesterday':
      return startOfDay(addDays(today, -1), zone.tz);
    case 'thisweek':
      return startOfDay(weekStart(today), zone.tz);
  }
  if (realDay(value)) return startOfDay(value, zone.tz);
  const parsed = Date.parse(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(parsed)) return new Date(parsed);
  throw validationFailed(`${field}: ${BAD_INSTANT}`, { [field]: BAD_INSTANT });
}

export interface DayRange {
  from: string;
  to: string;
}

const PERIODS = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisYear'] as const;
export const PERIOD_WORDS: readonly string[] = [...PERIODS, '7d', '30d', '4w'];

/** The days of a period word, or of "<n>d" / "<n>w" (the last n days or weeks, today included). */
export function periodRange(period: string, now: Date, zone: Zone): DayRange {
  const today = dayIn(now, zone.tz);
  const rolling = ROLLING.exec(period.trim());
  if (rolling && rolling[2]!.toLowerCase() !== 'h') {
    const days = Number(rolling[1]) * (rolling[2]!.toLowerCase() === 'w' ? 7 : 1);
    return { from: addDays(today, -(Math.max(1, days) - 1)), to: today };
  }
  const month = today.slice(0, 7);
  switch (period.trim().toLowerCase()) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'thisweek':
      return { from: weekStart(today), to: addDays(weekStart(today), 6) };
    case 'lastweek':
      return { from: addDays(weekStart(today), -7), to: addDays(weekStart(today), -1) };
    case 'thismonth':
      return { from: `${month}-01`, to: addDays(`${nextMonth(month)}-01`, -1) };
    case 'lastmonth': {
      const last = previousMonth(month);
      return { from: `${last}-01`, to: addDays(`${month}-01`, -1) };
    }
    case 'thisyear':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
  }
  throw validationFailed(
    `period: use ${PERIODS.join(', ')}, or "<n>d" / "<n>w" for the last n days or weeks.`,
    { period: 'Not a period' },
  );
}

function nextMonth(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
}

function previousMonth(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

const BAD_DAY = 'Write a day as "YYYY-MM-DD", "today", "yesterday" or "<n>d" (n days ago).';

/** One day: "YYYY-MM-DD", "today", "yesterday" or "<n>d" (n days ago). */
export function dayOf(text: string, now: Date, zone: Zone, field: string): string {
  const value = text.trim();
  const today = dayIn(now, zone.tz);
  if (value.toLowerCase() === 'today') return today;
  if (value.toLowerCase() === 'yesterday') return addDays(today, -1);
  const ago = /^(\d{1,4})d$/i.exec(value);
  if (ago) return addDays(today, -Number(ago[1]));
  if (realDay(value)) return value;
  throw validationFailed(`${field}: ${BAD_DAY}`, { [field]: BAD_DAY });
}

/** A day range from a period, or from / to days (either may be left open). Null when none is given. */
export function dayRange(
  input: { period?: string; from?: string; to?: string },
  now: Date,
  zone: Zone,
): Partial<DayRange> | null {
  if (input.period) return periodRange(input.period, now, zone);
  if (!input.from && !input.to) return null;
  return {
    ...(input.from ? { from: dayOf(input.from, now, zone, 'from') } : {}),
    ...(input.to ? { to: dayOf(input.to, now, zone, 'to') } : {}),
  };
}
