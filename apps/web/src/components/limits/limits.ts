import type { AccountFeature, AccountSummary, AccountType, BuyCreditAction } from '@tailorit/shared/accounts';
import type { MessageParams, PublicConstants } from '@tailorit/shared/constants';
// Relative, not '@/': the web tests read these.
import { subscribeAllowed } from '../../lib/account';
import { ApiError, isLimitError, type LimitErrorCode } from '../../lib/api';
import type { PublicMessageKey } from '../../lib/constants';

// v2.0: what a limit message shows and which buttons it carries (docs/design/v2.0/08-ui.md, "Shared pieces";
// 04-accounts-limits.md, "Subscribe and Buy credit"). Pure, so the tests read it without a page.

/**
 * The kinds of limit message: the four refusals the API answers (LIMIT_ERROR_CODES), and the Free auto-apply limit,
 * which the web shows from the queue's usage (the claim refuses the extension, not a page request).
 */
export type LimitKind = LimitErrorCode | 'auto_apply_limit';

/** One limit message as LimitNotice and LimitDialog show it. */
export interface LimitInfo {
  kind: LimitKind;
  /** The sentence: the server's own, or a constant rendered by the web. */
  message: string;
  /** Ask for the Subscribe button (shown only when the account may subscribe: never for Paid). */
  subscribe: boolean;
  /** Ask for "Get extra credit". */
  buyCredit: boolean;
  /** When the limit resets, an ISO instant, when known. */
  resetAt?: string;
}

/** A message renderer: usePublicConstants().t. */
export type MessageRenderer = (key: PublicMessageKey, params?: MessageParams) => string;

/** The Paid-only features a Free account meets in the web (AI job search, batch resume download: DECISIONS A28). */
export type PaidFeature = Exclude<AccountFeature, 'mcp'>;

/** Each Paid-only feature's message (constants, admin-editable). */
export const PAID_FEATURE_MESSAGES: Record<PaidFeature, PublicMessageKey> = {
  ai_job_search: 'MSG_PAID_AI_SEARCH',
  batch_download: 'MSG_BATCH_DOWNLOAD_PAID',
};

/** A limit message from an API error, or null when the error is not one (LIMIT_ERROR_CODES). */
export function limitFromError(error: unknown): LimitInfo | null {
  if (!isLimitError(error)) return null;
  return {
    kind: error.code,
    message: error.message,
    subscribe: error.subscribe,
    buyCredit: error.buyCredit,
    ...(error.resetAt ? { resetAt: error.resetAt } : {}),
  };
}

/** `value` as a limit message: a LimitInfo as it is, an ApiError of a limit code, else null. */
export function toLimit(value: LimitInfo | ApiError | unknown): LimitInfo | null {
  if (value instanceof ApiError) return limitFromError(value);
  if (isLimitInfo(value)) return value;
  return null;
}

function isLimitInfo(value: unknown): value is LimitInfo {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<LimitInfo>;
  return typeof record.kind === 'string' && typeof record.message === 'string' && typeof record.subscribe === 'boolean';
}

/** The Notice tone: `error` for the server AI being unavailable, `warning` for every plan or usage limit. */
export function limitTone(kind: LimitKind): 'warning' | 'error' {
  return kind === 'ai_unavailable' ? 'error' : 'warning';
}

/**
 * Whether a Subscribe or Buy credit action leads somewhere: a checkout address, or an admin contact email to write to.
 * v32 FIX-UX (UXREQ-14): `contact` with no email is a dead end ("The admin has not set a contact email yet."), so no
 * button offers it.
 */
export function purchaseReachable(action: { mode: 'contact'; contactEmail: string | null } | { mode: 'checkout' }): boolean {
  return action.mode === 'checkout' || Boolean(action.contactEmail?.trim());
}

/**
 * The buttons a limit message shows to this account: Subscribe when the message asks for it, the account may
 * subscribe (never Paid; 08-ui.md) and subscribing leads somewhere; Get extra credit when the message asks for it and
 * buying leads somewhere. `ai_unavailable` asks for neither. While the account is unknown, the public contact email
 * (`contactEmail`, ADMIN_CONTACT_EMAIL) says whether there is anyone to write to (left out: assume there is).
 */
export function limitButtons(
  limit: Pick<LimitInfo, 'subscribe' | 'buyCredit'>,
  account: AccountSummary | null | undefined,
  contactEmail?: string | null,
): { subscribe: boolean; buyCredit: boolean } {
  const fallback = contactEmail === undefined ? true : purchaseReachable({ mode: 'contact', contactEmail });
  const canSubscribe = account ? purchaseReachable(account.subscribe) : fallback;
  const canBuy = account ? purchaseReachable(account.buyCredit) : fallback;
  return { subscribe: limit.subscribe && subscribeAllowed(account) && canSubscribe, buyCredit: limit.buyCredit && canBuy };
}

/** The locked-feature message of a Paid-only feature, with Subscribe (MSG_PAID_AI_SEARCH, MSG_BATCH_DOWNLOAD_PAID). */
export function paidFeatureLimit(t: MessageRenderer, feature: PaidFeature): LimitInfo {
  return { kind: 'paid_feature', message: t(PAID_FEATURE_MESSAGES[feature]), subscribe: true, buyCredit: false };
}

/**
 * v32 FIX-UX (UXREQ-3): today's AI use spent, said before any request (the header knows it): MSG_AI_USAGE_EXHAUSTED,
 * with Get extra credit and, for an account that may subscribe, Subscribe; the same alert the server's refusal opens.
 */
export function aiUsedUpLimit(t: MessageRenderer): LimitInfo {
  return { kind: 'ai_usage_exhausted', message: t('MSG_AI_USAGE_EXHAUSTED'), subscribe: true, buyCredit: true };
}

/**
 * v32 FIX-UX (UXREQ-3): a background AI task that ended on a limit (its error's code is a limit's: today's AI use
 * spent, the resume limit, a Paid feature), as the limit alert says it; null for any other ending. The server's words.
 */
export function limitOfTaskError(error: { code?: string | null; message?: string | null } | null | undefined): LimitInfo | null {
  const code = error?.code;
  if (code !== 'ai_usage_exhausted' && code !== 'resume_limit_reached' && code !== 'paid_feature') return null;
  return { kind: code, message: error?.message || '', subscribe: true, buyCredit: code === 'ai_usage_exhausted' };
}

/**
 * The auto-apply limit's message, the Auto-apply page's waiting state: a Free account's (MSG_LIMIT_AUTO_APPLY, with
 * Subscribe); v2.0 fix (INT-open, the web's side of FIX-A's neutral messages): a Paid account an admin gave a finite
 * limit reads MSG_LIMIT_AUTO_APPLY_ACCOUNT, with no "Free" and no Subscribe.
 */
export function autoApplyLimit(t: MessageRenderer, limit: number, resetAt?: string, accountType: AccountType = 'free'): LimitInfo {
  const free = accountType === 'free';
  return {
    kind: 'auto_apply_limit',
    message: t(free ? 'MSG_LIMIT_AUTO_APPLY' : 'MSG_LIMIT_AUTO_APPLY_ACCOUNT', { limit }),
    subscribe: free,
    buyCredit: false,
    ...(resetAt ? { resetAt } : {}),
  };
}

/** The resume limit's message, Documents › Resumes at the limit: Free's with Subscribe, else the neutral one. */
export function resumeLimit(t: MessageRenderer, limit: number, accountType: AccountType = 'free'): LimitInfo {
  const free = accountType === 'free';
  return {
    kind: 'resume_limit_reached',
    message: t(free ? 'MSG_LIMIT_RESUMES' : 'MSG_LIMIT_RESUMES_ACCOUNT', { limit }),
    subscribe: free,
    buyCredit: false,
  };
}

/** A Subscribe or Buy credit action as its dialog renders it (`contact` in v2.0; `checkout` once payment exists). */
export type PurchaseAction = BuyCreditAction;

/**
 * The Subscribe dialog's action: the account's own (GET /api/account), else, while the account is unknown, the
 * contact message and email from the public constants (MSG_SUBSCRIBE_CONTACT, ADMIN_CONTACT_EMAIL).
 */
export function subscribeActionOf(
  account: AccountSummary | null | undefined,
  t: MessageRenderer,
  values: Pick<PublicConstants, 'ADMIN_CONTACT_EMAIL'>,
): PurchaseAction {
  if (account) {
    const action = account.subscribe;
    return action.mode === 'contact'
      ? { mode: 'contact', message: action.message, contactEmail: action.contactEmail }
      : { mode: 'checkout', message: action.message, url: action.url };
  }
  return { mode: 'contact', message: t('MSG_SUBSCRIBE_CONTACT'), contactEmail: values.ADMIN_CONTACT_EMAIL };
}

/** The Buy credit dialog's action: the account's own, else MSG_CREDIT_CONTACT and ADMIN_CONTACT_EMAIL. */
export function buyCreditActionOf(
  account: AccountSummary | null | undefined,
  t: MessageRenderer,
  values: Pick<PublicConstants, 'ADMIN_CONTACT_EMAIL'>,
): PurchaseAction {
  if (account) return account.buyCredit;
  return { mode: 'contact', message: t('MSG_CREDIT_CONTACT'), contactEmail: values.ADMIN_CONTACT_EMAIL };
}

/** The UsageMeter's numbers: how many segments are used, reserved (in progress) and free, and whether it is full. */
export interface UsageState {
  used: number;
  limit: number;
  /** Of `used`, the ones still in progress (drawn striped). */
  reserved: number;
  reached: boolean;
  /** aria-valuenow: `used` kept within 0..limit. */
  valueNow: number;
}

export function usageState(used: number, limit: number, reserved = 0): UsageState {
  const safeUsed = Math.max(0, Math.floor(used));
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    used: safeUsed,
    limit: safeLimit,
    reserved: Math.min(Math.max(0, Math.floor(reserved)), safeUsed),
    reached: safeUsed >= safeLimit,
    valueNow: Math.min(safeUsed, safeLimit),
  };
}
