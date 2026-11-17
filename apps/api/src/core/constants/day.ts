import { dayKeyOf, nextResetAt, nextWindowResetAt, resetText, windowRangeOf } from '@tailorit/shared';
import type { AppDeps } from '../context';
import { constantsOf } from './service';

// v2.0: the day and the auto-apply window by the resolved constants (02-constants.md, "Day and window"). The daily AI
// budget and the Free auto-apply counter are keyed by the day key, so nothing ever resets them. Each call reads the
// constants at that moment: an admin's change of the reset time or zone moves today's key at once.

type ClockDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The day key of `at` (now): its calendar date in DAY_RESET_TIME_ZONE, less DAY_RESET_TIME. */
export function dayKeyAt(deps: ClockDeps, at: Date = deps.now()): string {
  const constants = constantsOf(deps);
  return dayKeyOf(at, constants.get('DAY_RESET_TIME'), constants.get('DAY_RESET_TIME_ZONE'));
}

/** When today's day key ends: the next daily reset after `at` (now). */
export function nextDailyResetAt(deps: ClockDeps, at: Date = deps.now()): Date {
  const constants = constantsOf(deps);
  return nextResetAt(at, constants.get('DAY_RESET_TIME'), constants.get('DAY_RESET_TIME_ZONE'));
}

/** The {reset_time} placeholder's words: "12:00 AM Pacific Time". */
export function resetTextOf(deps: ClockDeps): string {
  const constants = constantsOf(deps);
  return resetText(constants.get('DAY_RESET_TIME'), constants.get('DAY_RESET_ZONE_LABEL'));
}

/** The auto-apply window that holds `at` (now): AUTO_APPLY_WINDOW_DAYS days counted from AUTO_APPLY_WINDOW_EPOCH. */
export interface AutoApplyWindow {
  /** The day key of `at`. */
  dayKey: string;
  /** The window's first and last day keys (the reservation count's BETWEEN). */
  start: string;
  end: string;
  windowDays: number;
  /** When the window ends: the auto-apply count resets. */
  resetsAt: string;
}

export function autoApplyWindow(deps: ClockDeps, at: Date = deps.now()): AutoApplyWindow {
  const constants = constantsOf(deps);
  const time = constants.get('DAY_RESET_TIME');
  const zone = constants.get('DAY_RESET_TIME_ZONE');
  const windowDays = constants.get('AUTO_APPLY_WINDOW_DAYS');
  const epoch = constants.get('AUTO_APPLY_WINDOW_EPOCH');
  const dayKey = dayKeyOf(at, time, zone);
  const { start, end } = windowRangeOf(dayKey, windowDays, epoch);
  return { dayKey, start, end, windowDays, resetsAt: nextWindowResetAt(at, time, zone, windowDays, epoch).toISOString() };
}
