import { HOUR_MS, MINUTE_MS } from '@tailorit/shared/core';
import { NOTIFICATION_UNREAD_COUNT_CAP, type HeaderSummary, type Notification, type NotificationTone } from '@tailorit/shared/notifications';
// Relative, not '@/': the web tests read these.
import { formatDate } from '../../../lib/format';
import { BELL_COPY, USAGE_COPY } from './copy';

// v3.1 HEADER (D8, D9): what the top bar's usage chip and bell show, as pure functions of GET /api/me/header and the
// notifications list, so the tests read them without a page.

const MICROS_PER_CENT = 10_000;

/** Whole cents. `down` never says more than there is (what is left); `nearest` for what was used. */
function centsOf(micros: number, round: 'down' | 'nearest' = 'nearest'): number {
  return Math.max(0, round === 'down' ? Math.floor(micros / MICROS_PER_CENT) : Math.round(micros / MICROS_PER_CENT));
}

/** Whole cents: "$1.50". `down` never says more than there is (what is left); `nearest` for what was used. */
export function centsText(micros: number, round: 'down' | 'nearest' = 'nearest'): string {
  return `$${(centsOf(micros, round) / 100).toFixed(2)}`;
}

/** The bell's count: nothing at 0, the number up to 99, "99+" from the API's cap on. */
export function badgeText(unread: number): string | null {
  if (unread <= 0) return null;
  return unread >= NOTIFICATION_UNREAD_COUNT_CAP ? '99+' : String(unread);
}

/** The bell's accessible name, with the count it draws ("Notifications, 3 unread"). */
export function bellLabel(unread: number): string {
  const count = badgeText(unread);
  return count ? BELL_COPY.nameUnread(count) : BELL_COPY.name;
}

/**
 * What the polite live region says when a read of the header finds more unread notifications than the last one
 * ("1 new notification, 4 unread"); null on the first read, and when the count fell or stayed (marking read).
 */
export function unreadAnnouncement(previous: number | undefined, next: number): string | null {
  if (previous === undefined || next <= previous) return null;
  return BELL_COPY.arrived(next - previous, badgeText(next) ?? '0');
}

export type UsageTone = 'tape' | 'warning' | 'danger';

export interface UsageView {
  /** `budget`: today's use against the daily budget (a meter); `unlimited`: no daily budget (no meter). */
  kind: 'budget' | 'unlimited';
  /** 0-100, the meter's value (the share of the budget used, whole percent; 100 once it is used). */
  percent: number;
  /** "42%". */
  percentText: string;
  /** "$0.42 of $1.00" ("$0.42 today" with no daily limit). */
  valueText: string;
  tone: UsageTone;
  /** Today's budget is used: new AI work takes extra credit (or waits). */
  reached: boolean;
  /** Reached with no extra credit left: new AI work waits for the reset. */
  waiting: boolean;
  /** "$1.50", what is left of the extra credit (cents, rounded down). */
  extraAmount: string;
  /** "Extra usage $1.50". */
  extraText: string;
  /** "Free plan" / "Paid plan". */
  planLabel: string;
  /** "Until Dec 13, 2026" for a Paid term with an end. */
  planUntil: string | null;
  /** The chip's accessible name: everything it draws, in the order it draws it. */
  triggerLabel: string;
}

/**
 * The chip and its popover for one header summary. `warningPercent` is the constant AI_USE_WARNING_PERCENT: the meter
 * is the tape until then, amber from it, red once the budget is used (docs/design/v3.1/20-visual-identity.md §7).
 */
export function usageView(summary: HeaderSummary, warningPercent: number): UsageView {
  const { usedMicros, budgetMicros } = summary.ai;
  const extraAmount = centsText(summary.extraCredit.balanceMicros, 'down');
  const extraText = USAGE_COPY.extra(extraAmount);
  const plan = {
    planLabel: summary.plan === 'paid' ? USAGE_COPY.paidPlan : USAGE_COPY.freePlan,
    planUntil: summary.plan === 'paid' && summary.paidUntil ? USAGE_COPY.paidUntil(formatDate(summary.paidUntil)) : null,
  };
  const used = centsText(usedMicros);
  if (budgetMicros === null) {
    const valueText = USAGE_COPY.unlimitedUsed(used);
    return {
      kind: 'unlimited',
      percent: 0,
      percentText: '',
      valueText,
      tone: 'tape',
      reached: false,
      waiting: false,
      extraAmount,
      extraText,
      ...plan,
      triggerLabel: `${USAGE_COPY.meterLabel} ${valueText}, ${extraText}`,
    };
  }
  const reached = usedMicros >= budgetMicros;
  // v31 FIX-WEB (REV-UX UX-14): the share of the amounts the popover shows ("$0.06 of $0.10" is 60%, never 62%), so the
  // chip and its popover round the same way. Just under the budget stays at 99%: 100% is for a used budget.
  const usedCents = centsOf(usedMicros);
  const budgetCents = centsOf(budgetMicros);
  const percent = reached ? 100 : budgetCents > 0 ? Math.min(99, Math.round((usedCents / budgetCents) * 100)) : 0;
  const tone: UsageTone = reached ? 'danger' : percent >= warningPercent ? 'warning' : 'tape';
  const percentText = `${percent}%`;
  return {
    kind: 'budget',
    percent,
    percentText,
    valueText: USAGE_COPY.of(used, centsText(budgetMicros)),
    tone,
    reached,
    waiting: reached && summary.extraCredit.balanceMicros <= 0,
    extraAmount,
    extraText,
    ...plan,
    triggerLabel: `${USAGE_COPY.meterLabel} ${percentText}, ${extraText}`,
  };
}

/** "in 5 hours", "in 42 minutes", "in less than a minute": the wait until `at`. */
export function waitText(at: string, now: number): string {
  const left = Date.parse(at) - now;
  if (!Number.isFinite(left) || left < MINUTE_MS) return 'in less than a minute';
  if (left < HOUR_MS) {
    const minutes = Math.floor(left / MINUTE_MS);
    return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const hours = Math.floor(left / HOUR_MS);
  return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** "Resets at 12:00 AM Pacific Time (in 5 hours)": the day's reset in the constants' words, and how long until it. */
export function resetLine(resetsAt: string, now: number, when: string): string {
  return USAGE_COPY.resetsIn(when, waitText(resetsAt, now));
}

/** A tone's mark: the soft tile and the full colour of its icon (tokens; the title carries the meaning). */
export const TONE_MARK: Readonly<Record<NotificationTone, string>> = {
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

/** `items` with `id` marked read at `at` (unchanged when it already was). */
export function markedRead(items: readonly Notification[], id: string, at: string): Notification[] {
  return items.map((item) => (item.id === id && item.readAt === null ? { ...item, readAt: at } : item));
}

/** `items`, every one read (the first read time kept). */
export function allRead(items: readonly Notification[], at: string): Notification[] {
  return items.map((item) => (item.readAt === null ? { ...item, readAt: at } : item));
}

/** The address a notification opens: a path inside TailorIT, else null (the API only stores paths; never trust more). */
export function safeLink(link: string | null): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//') || link.includes('\\')) return null;
  return link;
}
