import { PUBLIC_CONSTANT_DEFAULTS } from '@/lib/constants';

// v30 X1-WEB: the held line's title (14 §4.3); its sentence is the constant MSG_EXT_JOB_HELD (read with `t`).
// v30 FIX-WEB (REV-UX UX-15): the title is a constant too, MSG_JOB_HELD_TITLE (FIX-B's), so an admin's change reaches the
// badge and the notice; HELD_TITLE is its default while the server's values (or an older server) lack it. v30 FIX-INT:
// that default is the constant's own (one source), now that FIX-B's constant is merged.

/** The held line's default title, on the job detail and on a list row: MSG_JOB_HELD_TITLE's default. */
export const HELD_TITLE: string = PUBLIC_CONSTANT_DEFAULTS.MSG_JOB_HELD_TITLE;

/** The held title in use: the public constant MSG_JOB_HELD_TITLE when the server sends it, else the default. */
export function heldTitleOf(values: object): string {
  const value = (values as { MSG_JOB_HELD_TITLE?: unknown }).MSG_JOB_HELD_TITLE;
  return typeof value === 'string' && value.trim() ? value : HELD_TITLE;
}

/** Whether a job is held for review: JobSummary.held is absent (an older answer) or false for every other job. */
export const isHeld = (job: { held?: boolean }): boolean => job.held === true;
