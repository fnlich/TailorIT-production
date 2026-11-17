import type {
  AdminAccountHistory,
  AdminUser,
  AdminUserTypeFilter,
  CreditLedgerEntry,
  EntitlementEvent,
  EntitlementSource,
} from '@tailorit/shared/accounts';
import { formatUsd } from '@tailorit/shared/constants';
// Relative, not '@/': the web tests read these.
import { formatDate, formatMonthDay } from '../../../lib/format';
import { DAY_MS } from '@tailorit/shared';

// v2.0: Admin › Users (docs/design/v2.0/08-ui.md, "Users"): each account's type and term, daily AI budget, today's use
// and extra credit, and the account sheet's history. Pure, so the tests read it without a page.

// v2.0 fix (REQ-11): how close to its end a Paid account shows its date in the warning colour, and the "Paid ending"
// filter's days, are the constant PAID_ENDING_DAYS (the server's filter reads the same one), not a number of the web's.

/** The type filter's choices; `endingDays` is PAID_ENDING_DAYS. */
export function typeFilterOptions(endingDays: number): readonly { value: AdminUserTypeFilter; label: string }[] {
  return [
    { value: 'all', label: 'All types' },
    { value: 'free', label: 'Free' },
    { value: 'paid', label: 'Paid' },
    { value: 'paid_ending', label: `Paid ending in ${endingDays} ${endingDays === 1 ? 'day' : 'days'}` },
  ];
}

/** "Free"; "Paid · until Dec 13" (warning within `endingDays` of its end); a lapsed Paid account is Free. */
export function typeCell(
  user: Pick<AdminUser, 'effectiveType' | 'paidUntil'>,
  now: number,
  endingDays: number,
): { text: string; ending: boolean } {
  if (user.effectiveType !== 'paid') return { text: 'Free', ending: false };
  if (!user.paidUntil) return { text: 'Paid', ending: false };
  const left = Date.parse(user.paidUntil) - now;
  return { text: `Paid · until ${formatMonthDay(user.paidUntil)}`, ending: left <= endingDays * DAY_MS };
}

/** "Default" (the type's budget), "Unlimited", or the override ("$0.25"). */
export function budgetCell(user: Pick<AdminUser, 'aiBudget'>): string {
  if (!user.aiBudget) return 'Default';
  return user.aiBudget.override === null ? 'Unlimited' : formatUsd(user.aiBudget.override);
}

/** Today's use: the AI charged ("$0.07"), any write-off ("+$0.02 written off") and the auto-applies ("3 auto-applies"). */
export function todayCell(user: Pick<AdminUser, 'today'>): { ai: string; writtenOff: string | null; autoApplies: string } {
  const { aiSpentMicros, writtenOffMicros, autoApplies } = user.today;
  return {
    ai: `AI ${formatUsd(aiSpentMicros)}`,
    writtenOff: writtenOffMicros > 0 ? `+${formatUsd(writtenOffMicros)} written off` : null,
    autoApplies: `${autoApplies} auto-appl${autoApplies === 1 ? 'y' : 'ies'}`,
  };
}

/** A date picked in the sheet as the term's end: the end of that day, here. */
export function endOfDayIso(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).toISOString();
}

export const SOURCE_LABEL: Record<EntitlementSource, string> = { admin: 'Admin', payment: 'Payment', system: 'System' };

/** One line of the account's history. */
export interface HistoryLine {
  id: string;
  at: string;
  text: string;
  source: string;
  /** Who did it: the admin's name, else the source. */
  by: string;
  note: string | null;
}

/**
 * A daily budget in an event: micro-dollars, null for an Unlimited override, and "default" (or nothing) for no
 * override (the type's budget), as the API sends a stored SQL NULL (v2.0 INT).
 */
function money(value: unknown): string {
  if (typeof value === 'number') return formatUsd(value);
  return value === null ? 'Unlimited' : 'Default';
}

function eventText(event: EntitlementEvent): string {
  switch (event.field) {
    case 'account_type':
      return `Type: ${String(event.oldValue ?? 'free')} → ${String(event.newValue ?? 'free')}`;
    case 'paid_until':
      return `Paid until: ${typeof event.oldValue === 'string' ? formatDate(event.oldValue) : 'none'} → ${
        typeof event.newValue === 'string' ? formatDate(event.newValue) : 'none'
      }`;
    case 'ai_daily_budget':
      return `Daily AI budget: ${money(event.oldValue)} → ${money(event.newValue)}`;
  }
}

const CREDIT_WORD: Record<CreditLedgerEntry['kind'], string> = {
  grant: 'Credit added',
  purchase: 'Credit bought',
  spend: 'Credit used',
  adjustment: 'Credit adjusted',
};

function creditText(entry: CreditLedgerEntry): string {
  const amount = entry.amountMicros >= 0 ? `+${formatUsd(entry.amountMicros)}` : formatUsd(entry.amountMicros);
  return `${CREDIT_WORD[entry.kind]}: ${amount} (balance ${formatUsd(entry.balanceAfterMicros)})`;
}

/** The entitlement events and the credit rows as one list, newest first. */
export function historyLines(history: Pick<AdminAccountHistory, 'events' | 'credit'>): HistoryLine[] {
  const lines: HistoryLine[] = [
    ...history.events.map((event) => ({
      id: `event:${event.id}`,
      at: event.createdAt,
      text: eventText(event),
      source: SOURCE_LABEL[event.source],
      by: event.actor?.name ?? SOURCE_LABEL[event.source],
      note: event.note,
    })),
    ...history.credit.map((entry) => ({
      id: `credit:${entry.id}`,
      at: entry.createdAt,
      text: creditText(entry),
      source: SOURCE_LABEL[entry.source],
      by: entry.actor?.name ?? SOURCE_LABEL[entry.source],
      note: entry.note,
    })),
  ];
  return lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}
