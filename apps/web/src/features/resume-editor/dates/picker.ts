import { formatPeriod, isEndBeforeStart, type DatePart, type Period } from '@tailorit/shared';

// The rules of the date picker (Enhancv's): a page of years, then a month or none (the same month clicked again means
// the year alone), and on the To tab an ongoing switch whose word ("Present") the person can change. Pure, so the
// popover only draws them.

export const FIRST_PICKER_YEAR = 1949;
export const YEARS_PER_PAGE = 12;
export const MAX_ONGOING_TEXT = 20;
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** The last year offered: five years ahead (an expected graduation, a planned end). */
export const lastPickerYear = (now: Date) => now.getFullYear() + 5;

/** The years of the page that holds `year` (the newest page when none), newest first. */
export function yearPage(year: number | undefined, now: Date): { years: number[]; hasNewer: boolean; hasOlder: boolean } {
  const last = lastPickerYear(now);
  const target = Math.min(last, Math.max(FIRST_PICKER_YEAR, year ?? now.getFullYear()));
  const index = Math.floor((last - target) / YEARS_PER_PAGE);
  const top = last - index * YEARS_PER_PAGE;
  const years: number[] = [];
  for (let value = top; value > top - YEARS_PER_PAGE && value >= FIRST_PICKER_YEAR; value -= 1) years.push(value);
  return { years, hasNewer: index > 0, hasOlder: years[years.length - 1]! > FIRST_PICKER_YEAR };
}

/** The year a page step lands on: the top year of the newer or older page. */
export function stepYearPage(year: number | undefined, direction: 1 | -1, now: Date): number {
  const { years } = yearPage(year, now);
  const top = years[0]!;
  return direction === 1 ? top + YEARS_PER_PAGE : top - YEARS_PER_PAGE;
}

/** A year picked: the month is kept, the year changed. */
export function pickYear(part: DatePart | undefined, year: number): DatePart {
  return part?.m ? { y: year, m: part.m } : { y: year };
}

/** A month picked: the same month again means the year alone. Without a year yet, the current one is taken. */
export function pickMonth(part: DatePart | undefined, month: number, now: Date): DatePart {
  const year = part?.y ?? now.getFullYear();
  return part?.m === month ? { y: year } : { y: year, m: month };
}

export type PickerSide = 'from' | 'to';

/** The period with one side changed; the raw text of that side (an unread date) goes once a date is picked. */
export function withSide(period: Period, side: PickerSide, part: DatePart | undefined): Period {
  const next: Period = { ...period };
  if (part) next[side] = part;
  else delete next[side];
  if (next.raw) {
    const raw = { ...next.raw };
    delete raw[side === 'from' ? 'start' : 'end'];
    if (raw.start === undefined && raw.end === undefined) delete next.raw;
    else next.raw = raw;
  }
  if (side === 'to' && part) delete next.ongoing;
  return next;
}

/** The ongoing switch: on keeps `to` (switching back restores it) and the word; the word is cut to its limit. */
export function withOngoing(period: Period, ongoing: boolean, text?: string): Period {
  const next: Period = { ...period };
  if (ongoing) {
    next.ongoing = true;
    const word = (text ?? period.ongoingText ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ONGOING_TEXT);
    if (word && word.toLowerCase() !== 'present') next.ongoingText = word;
    else delete next.ongoingText;
    if (next.raw) {
      const raw = { ...next.raw };
      delete raw.end;
      if (raw.start === undefined) delete next.raw;
      else next.raw = raw;
    }
  } else {
    delete next.ongoing;
    delete next.ongoingText;
  }
  return next;
}

/** The hint under a side whose date sits on the wrong side of the other one; null when the period reads right. */
export function periodHint(period: Period, side: PickerSide): string | null {
  if (!isEndBeforeStart(period)) return null;
  return side === 'to' ? 'Must be after start date' : 'Must be before end date';
}

/** The period as the field prints it ("01/2020 - Present"), '' with nothing picked. */
export function periodLabel(period: Period): string {
  const { startDate, endDate } = formatPeriod(period);
  return [startDate, endDate].filter(Boolean).join(' - ');
}
