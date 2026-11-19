import type { AccountSummary } from '@tailorit/shared/accounts';
import { formatUsd } from '@tailorit/shared/constants';
// Relative, not '@/': the web tests read these.
import { LIMIT_COPY } from '../../components/limits/copy';
import { formatDate } from '../../lib/format';

// v2.0: Settings › Account (docs/design/v2.0/08-ui.md, "Settings › Account"): what the person sees of their plan. Pure,
// so the tests read it without a page. It never holds the daily AI budget, AI spend or anything about the server: the
// account summary carries none of it, and the extra-credit balance is the only money shown.

export const ACCOUNT_COPY = {
  title: 'Account',
  description: 'Your plan, usage and extra credit.',
  type: 'Account type',
  free: 'Free',
  paid: 'Paid',
  paidUntil: (date: string) => `Paid until ${date}`,
  autoApplies: 'Auto-applies today',
  /** v32 COPY (E7): today's AI use, as a share of the daily budget only. */
  aiUse: 'AI use today',
  resumes: 'Resumes',
  resumesLabel: 'Resumes saved',
  resumesText: (count: number, limit: number) => `${count} of ${limit} resumes`,
  aiSearch: 'AI job search',
  aiSearchLocked: 'Paid accounts',
  aiSearchIncluded: 'Included',
  credit: 'Extra credit',
  buyCredit: 'Buy extra credit',
  subscribe: 'Subscribe',
  unlimited: 'Unlimited',
  // v30 INT-0 (audit B24): the usage meter's label, one copy (components/limits/copy.ts).
  resetsAt: LIMIT_COPY.resetsAt,
  loadFailed: "Your account didn't load",
  tryAgain: 'Try again',
} as const;

/** A count against a limit: a meter while the plan has a limit, "Unlimited" when it has none. */
export type CountRow = { kind: 'meter'; used: number; limit: number } | { kind: 'unlimited' };

export interface AccountView {
  paid: boolean;
  typeLabel: string;
  /** "Paid until Dec 13, 2026" for a Paid account with an end; null otherwise. */
  paidUntil: string | null;
  autoApply: CountRow;
  /** "Resets at 12:00 AM Pacific Time", under the auto-apply meter. */
  autoApplyReset: string;
  resumes: CountRow;
  /** The resume meter's words: "23 of 30 resumes". */
  resumesText: string | null;
  aiJobSearch: 'included' | 'locked';
  /** "$1.25". */
  credit: string;
  /** Subscribe shows to a Free account only (`subscribe.visible`). */
  subscribe: boolean;
}

function countRow(used: number, limit: number | null): CountRow {
  return limit === null ? { kind: 'unlimited' } : { kind: 'meter', used, limit };
}

/** What Settings › Account shows for `account`. */
export function accountView(account: AccountSummary): AccountView {
  const paid = account.type === 'paid';
  return {
    paid,
    typeLabel: paid ? ACCOUNT_COPY.paid : ACCOUNT_COPY.free,
    paidUntil: paid && account.paidUntil ? ACCOUNT_COPY.paidUntil(formatDate(account.paidUntil)) : null,
    autoApply: countRow(account.autoApply.used, account.autoApply.limit),
    autoApplyReset: ACCOUNT_COPY.resetsAt(account.autoApply.resetText),
    resumes: countRow(account.resumes.count, account.resumes.limit),
    resumesText: account.resumes.limit === null ? null : ACCOUNT_COPY.resumesText(account.resumes.count, account.resumes.limit),
    aiJobSearch: account.features.aiJobSearch ? 'included' : 'locked',
    credit: formatUsd(account.extraCredit.balanceMicros),
    subscribe: account.subscribe.visible,
  };
}
