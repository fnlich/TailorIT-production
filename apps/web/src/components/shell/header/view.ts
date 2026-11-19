import { HOUR_MS, MINUTE_MS } from '@tailorit/shared/core';
import { NOTIFICATION_UNREAD_COUNT_CAP, type Notification, type NotificationTone } from '@tailorit/shared/notifications';
// Relative, not '@/': the web tests read these.
import { formatDate } from '../../../lib/format';
import { aiUseOf } from '../../limits/aiUse';
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

/** Today's AI use as the header reads it (api.ts HeaderSummaryRead): the share, or the micros of a v3.1 API. */
export interface HeaderAiRead {
  percent?: number | null;
  usedMicros?: number;
  budgetMicros?: number | null;
  resetsAt: string;
}

/** The header's summary, as far as the usage chip reads it. */
export interface UsageSummary {
  ai: HeaderAiRead;
  extraCredit: { balanceMicros: number };
  plan: 'free' | 'paid';
  paidUntil: string | null;
}

/**
 * v32 SHELL (E7): today's share of the daily limit, 0-100, or null with no daily limit. The API's `percent` when it
 * sends one (v3.2); else the micros' share (a v3.1 API), by the API's own rule (ADMINAPP's aiUsePercent, v31 FIX-WEB
 * UX-14): whole cents over whole cents, 99 at most below the limit and 100 once it is used, so the chip never says
 * "100%" while AI work still runs on the day's budget.
 */
export function aiPercent(ai: HeaderAiRead): number | null {
  // v32 INT-1: one rule for the share everywhere a person sees it (COPY's aiUseOf, as Settings › Account and Prepare
  // All read it). An answer with neither the share nor a budget (none the API sends) reads as 0%, as before.
  if (ai.percent === undefined && ai.budgetMicros === undefined) return 0;
  const use = aiUseOf({ ...ai, usedMicros: ai.usedMicros ?? 0 });
  return use.kind === 'unlimited' ? null : use.percent;
}

export interface UsageView {
  /** `budget`: today's use against the daily limit (a meter); `unlimited`: no daily limit (no meter). */
  kind: 'budget' | 'unlimited';
  /** 0-100, the meter's value (the share of the limit used, whole percent; 100 once it is used). */
  percent: number;
  /** "42%" ("" with no daily limit). */
  percentText: string;
  /** What the chip's popover says of today's use: "42% used", or "No daily limit". Never money (E7). */
  valueText: string;
  tone: UsageTone;
  /** Today's limit is used: new AI work takes extra credit (or waits). */
  reached: boolean;
  /** Reached with no extra credit left: new AI work waits for the reset. */
  waiting: boolean;
  /** "$1.50", what is left of the extra credit (cents, rounded down): extra usage keeps its amount. */
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
 * is the tape until then, amber from it, red once the limit is used (docs/design/v3.1/20-visual-identity.md §7). v32
 * SHELL (E7): today's use is a share only; no amount of the daily limit is drawn or named (extra usage keeps its amount).
 */
export function usageView(summary: UsageSummary, warningPercent: number): UsageView {
  const extraAmount = centsText(summary.extraCredit.balanceMicros, 'down');
  const extraText = USAGE_COPY.extra(extraAmount);
  const plan = {
    planLabel: summary.plan === 'paid' ? USAGE_COPY.paidPlan : USAGE_COPY.freePlan,
    planUntil: summary.plan === 'paid' && summary.paidUntil ? USAGE_COPY.paidUntil(formatDate(summary.paidUntil)) : null,
  };
  const percent = aiPercent(summary.ai);
  if (percent === null) {
    return {
      kind: 'unlimited',
      percent: 0,
      percentText: '',
      valueText: USAGE_COPY.unlimited,
      tone: 'tape',
      reached: false,
      waiting: false,
      extraAmount,
      extraText,
      ...plan,
      triggerLabel: `${USAGE_COPY.meterLabel} ${USAGE_COPY.unlimitedShort}, ${extraText}`,
    };
  }
  const reached = percent >= 100;
  const tone: UsageTone = reached ? 'danger' : percent >= warningPercent ? 'warning' : 'tape';
  const percentText = `${percent}%`;
  return {
    kind: 'budget',
    percent,
    percentText,
    valueText: USAGE_COPY.percentUsed(percentText),
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
