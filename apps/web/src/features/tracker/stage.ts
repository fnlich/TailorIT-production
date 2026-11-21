import {
  STATUS,
  STATUS_INFO,
  eventDate,
  isTerminalStatus,
  stepperModel,
  type ApplicationStatus,
  type ApplicationSummary,
  type StepperModel,
} from '@tailorit/shared';
import type { MessageParams } from '@tailorit/shared/constants';
import type { PublicMessageKey } from '@/lib/constants';

/*
 * v31 FIX-DOCS (REV-UX UX-1): what the redesigned Tracker says about where an application stands, free of React so it
 * is unit-tested: the next step a card shows ("Next: follow up"), how long the application has been in its stage, and
 * the stage meter that replaced the list's five-dot stepper. Every word is a constant (`t` is usePublicConstants().t).
 */

/** A page's message renderer (usePublicConstants().t). */
export type Words = (key: PublicMessageKey, params?: MessageParams) => string;

export type NextStepTone = 'next' | 'done' | 'closed';

/**
 * The next step's words key per status; an ended application says Done (accepted) or Closed. v33 TRACKER (F1): a Saved
 * entry with the Draft mark has Saved's next step (Draft is a mark, not a stage).
 */
const NEXT_STEP: Record<ApplicationStatus, PublicMessageKey> = {
  [STATUS.saved]: 'LABEL_TRACKER_STEP_SAVED',
  [STATUS.applied]: 'LABEL_TRACKER_STEP_APPLIED',
  [STATUS.screen]: 'LABEL_TRACKER_STEP_SCREEN',
  [STATUS.interviewing]: 'LABEL_TRACKER_STEP_INTERVIEWING',
  [STATUS.offer]: 'LABEL_TRACKER_STEP_OFFER',
  [STATUS.accepted]: 'LABEL_TRACKER_STEP_DONE',
  [STATUS.withdrawn]: 'LABEL_TRACKER_STEP_CLOSED',
  [STATUS.ghosted]: 'LABEL_TRACKER_STEP_CLOSED',
  [STATUS.rejected]: 'LABEL_TRACKER_STEP_CLOSED',
};

/**
 * "Next: follow up" (tone `next`), or "Done" / "Closed" for an application that ended. `short` is what a card draws
 * beside its arrow: the step alone, its first letter capitalised ("Follow up"); `text` is what it says in full.
 */
export function nextStep(status: ApplicationStatus, t: Words): { text: string; short: string; tone: NextStepTone } {
  const key = NEXT_STEP[status];
  const step = t(key);
  if (status === STATUS.accepted) return { text: step, short: step, tone: 'done' };
  if (isTerminalStatus(status)) return { text: step, short: step, tone: 'closed' };
  return { text: t('MSG_TRACKER_NEXT_STEP', { step }), short: step.charAt(0).toUpperCase() + step.slice(1), tone: 'next' };
}

/** "YYYY-MM-DD" (or an ISO time's day) as a local calendar day's start, in ms; NaN when unreadable. */
function dayStart(value: string): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!day) return Number.NaN;
  return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
}

/**
 * Since when the application has been in its stage: the date of its current status's event, else the day it was
 * tracked. Null when no date can be read. v33 TRACKER (F1): a Draft-marked entry is in Saved since it was saved (no
 * longer since it joined the queue).
 */
export function stageSince(application: Pick<ApplicationSummary, 'currentStatus' | 'events' | 'trackedOn'>): string | null {
  return eventDate(application.events, application.currentStatus) ?? application.trackedOn ?? null;
}

/** Whole local days from `since` to `today` (never below 0); null when `since` is unreadable. */
export function daysBetween(since: string | null, today: Date): number | null {
  if (!since) return null;
  const from = dayStart(since);
  if (Number.isNaN(from)) return null;
  const to = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** The time in the stage: short ("4d", "Today") for a card or a cell, and the sentence ("In Applied for 4 days"). */
export function timeInStage(days: number | null, stage: string, t: Words): { short: string; long: string } | null {
  if (days === null) return null;
  if (days === 0) return { short: t('LABEL_TRACKER_TODAY_SHORT'), long: t('MSG_TRACKER_IN_STAGE_TODAY', { stage }) };
  return { short: t('LABEL_TRACKER_DAYS_SHORT', { days }), long: t('MSG_TRACKER_DAYS_IN_STAGE', { days, stage }) };
}

export interface StageMeterModel extends StepperModel {
  /** How many of the steps are reached (the fill ends at the last reached one). */
  reached: number;
  /** The position of the furthest reached step, 1-based (0: none). */
  at: number;
}

/**
 * The list's stage meter: the stepper's steps (Saved, Applied, Screen, Interview, Offer, plus the ending when there is
 * one) as ticks on one tape, filled to the furthest reached step.
 */
export function stageMeter(events: Parameters<typeof stepperModel>[0]): StageMeterModel {
  const model = stepperModel(events);
  let at = 0;
  model.steps.forEach((step, index) => {
    if (step.reached) at = index + 1;
  });
  return { ...model, reached: model.steps.filter((step) => step.reached).length, at };
}

/** The meter's value said in words: "Screen, stage 3 of 5". */
export function stageMeterText(model: StageMeterModel, stage: string, t: Words): string {
  return t('MSG_TRACKER_STAGE_PROGRESS', { stage, step: model.at, steps: model.steps.length });
}

/** An empty lane's line: "Drag a card here when it reaches interviewing." (the stage in lower case). */
export function laneEmptyText(status: ApplicationStatus, t: Words): string {
  return t('MSG_TRACKER_LANE_EMPTY_TEXT', { stage: STATUS_INFO[status].label.toLowerCase() });
}

/** Whether a stored status ends the application (no next step but Done or Closed). */
export const endsApplication = (status: ApplicationStatus): boolean => isTerminalStatus(status);
