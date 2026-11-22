import { z } from 'zod';
import { ROLES } from '../auth/index';
import type { Limit } from '../constants/constants';
import { messageError } from '../constants/public/defaults';
import { IsoDate, IsoDateTime } from '../core/list';
import { ActingProfileSchema } from '../sharing/dto'; // v33 SHARE-0

// v2.0: the two account types, their entitlements, extra credit and the admin's account routes
// (docs/design/v2.0/04-accounts-limits.md). The account type is stored as `account_type` plus `paid_until`; every
// check reads the effective type, which is `paid` only while `paid_until` is in the future. Money is an integer count
// of micro-dollars ($1 = 1,000,000) everywhere; the admin's forms send dollars as text ("0.25"), read exactly.

export const ACCOUNT_TYPES = ['free', 'paid'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Who changed an entitlement or the credit: an admin, a payment provider (later), or TailorIT itself. */
export const ENTITLEMENT_SOURCES = ['admin', 'payment', 'system'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/** The fields account_entitlement_events records (one row per changed field). */
export const ENTITLEMENT_FIELDS = ['account_type', 'paid_until', 'ai_daily_budget'] as const;
export type EntitlementField = (typeof ENTITLEMENT_FIELDS)[number];

/** The extra-credit ledger's entries: a `purchase` always carries its payment reference. */
export const CREDIT_KINDS = ['grant', 'purchase', 'spend', 'adjustment'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

/**
 * The features a plan turns on or off (assertFeature: 403 `paid_feature` when off for a Free account). v20 P10 (A28):
 * `batch_download`, Documents' batch resume download (FREE_/PAID_BATCH_DOWNLOAD, MSG_BATCH_DOWNLOAD_PAID).
 */
export const ACCOUNT_FEATURES = ['ai_job_search', 'mcp', 'batch_download'] as const;
export type AccountFeature = (typeof ACCOUNT_FEATURES)[number];

/**
 * The resolved limits of one person (entitlementsOf, apps/api/src/core/accounts/entitlements.ts), read per request so
 * an admin's change applies to the next one. A Limit of null is UNLIMITED.
 */
export interface Entitlements {
  type: AccountType;
  paidUntil: string | null;
  /** FREE_/PAID_AUTO_APPLY_PER_DAY. */
  autoApplyPerWindow: Limit;
  /** FREE_/PAID_RESUME_LIMIT. */
  resumes: Limit;
  /** user_limit_overrides.ai_daily_budget, else FREE_/PAID_AI_DAILY_BUDGET_USD; never shown to the person. */
  aiDailyBudgetMicros: Limit;
  /** FREE_/PAID_AI_JOB_SEARCH. */
  aiJobSearch: boolean;
  /** FREE_/PAID_MCP. */
  mcp: boolean;
  /** FREE_/PAID_BATCH_DOWNLOAD (v20 P10, A28). */
  batchDownload: boolean;
  /** FREE_/PAID_TAILOR_PER_HOUR (v32 FIX-PLAN, E12): tailorings started an hour; UNLIMITED is never counted. */
  tailorsPerHour: Limit;
  /** FREE_/PAID_PREPARE_PER_HOUR (v32 FIX-PLAN, E12): server Prepares started an hour; UNLIMITED never waits. */
  preparesPerHour: Limit;
}

/** Whole micro-dollars, never below 0. */
const Micros = z.number().int().nonnegative();
/** Whole micro-dollars, either sign (a ledger amount). */
const SignedMicros = z.number().int();

/** A dollar amount as the admin types it: "0.25", "5", "$1.50"; at most 6 decimal places. */
export const UsdTextSchema = z
  .string()
  .trim()
  .regex(/^\$?\d{1,10}(\.\d{1,6})?$/, 'Enter an amount in dollars, such as 0.25 (at most 6 decimal places)');
/** The same, with an optional "-" (a credit adjustment may take credit away). */
export const SignedUsdTextSchema = z
  .string()
  .trim()
  .regex(/^-?\$?\d{1,10}(\.\d{1,6})?$/, 'Enter an amount in dollars, such as 1.25 or -1.25 (at most 6 decimal places)');

// The Subscribe and Buy credit actions are data, not wired into the UI (the payment-ready seam): v2.0 sends `contact`
// only; a payment integration adds `checkout` with its address, and only the server changes.
const ContactActionSchema = z.object({
  mode: z.literal('contact'),
  /** MSG_SUBSCRIBE_CONTACT or MSG_CREDIT_CONTACT, rendered. */
  message: z.string(),
  /** ADMIN_CONTACT_EMAIL; null: MSG_CONTACT_EMAIL_MISSING is shown instead. */
  contactEmail: z.string().nullable(),
});
const CheckoutActionSchema = z.object({
  mode: z.literal('checkout'),
  message: z.string(),
  /** Where "Continue to payment" goes. Not sent by v2.0. */
  url: z.url(),
});
export const PURCHASE_MODES = ['contact', 'checkout'] as const;
export type PurchaseMode = (typeof PURCHASE_MODES)[number];

export const SubscribeActionSchema = z.discriminatedUnion('mode', [
  ContactActionSchema.extend({ visible: z.boolean() }),
  CheckoutActionSchema.extend({ visible: z.boolean() }),
]);
export type SubscribeAction = z.infer<typeof SubscribeActionSchema>;
export const BuyCreditActionSchema = z.discriminatedUnion('mode', [ContactActionSchema, CheckoutActionSchema]);
export type BuyCreditAction = z.infer<typeof BuyCreditActionSchema>;

/**
 * GET /api/account (session): what the person sees of their account. It never carries the AI budget, today's AI
 * spend, or anything about the server: the extra-credit balance is the only money shown.
 */
export const AccountSummarySchema = z.object({
  type: z.enum(ACCOUNT_TYPES),
  /** Shown to Paid accounts as "Paid until <date>". */
  paidUntil: IsoDateTime.nullable(),
  extraCredit: z.object({ balanceMicros: Micros }),
  autoApply: z.object({
    /** Reserved and used auto-applies in the current window. */
    used: z.number().int().nonnegative(),
    /** null: unlimited. */
    limit: z.number().int().nonnegative().nullable(),
    windowDays: z.number().int().positive(),
    resetsAt: IsoDateTime,
    /** "12:00 AM Pacific Time" (resetText). */
    resetText: z.string(),
  }),
  resumes: z.object({
    count: z.number().int().nonnegative(),
    /** null: unlimited (the technical safety cap is not shown). */
    limit: z.number().int().nonnegative().nullable(),
  }),
  features: z.object({ aiJobSearch: z.boolean(), mcp: z.boolean(), batchDownload: z.boolean() }),
  /** Free accounts only: `visible` is false for a Paid one. */
  subscribe: SubscribeActionSchema,
  buyCredit: BuyCreditActionSchema,
  // v33 SHARE-0 (PLAN-sharing.md §4 "Mixed routes", §9 "Account data"): the profile the request acts on (its owner's
  // name, email, default resume and field), the person's own when it names none. The plan, credit and features above
  // stay the signed-in person's (B pays); the resume and auto-apply counts are the profile's. SHARE-3 fills it.
  profile: ActingProfileSchema.optional(),
  // end v33 SHARE-0
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

/**
 * An account's entitlement state after a change (changeEntitlement's answer, and the admin's PUT routes).
 * `aiBudgetOverride`: absent means no override (the type's constant applies); `{micros: null}` is an UNLIMITED
 * override.
 */
export const AccountStateSchema = z.object({
  userId: z.string(),
  accountType: z.enum(ACCOUNT_TYPES),
  effectiveType: z.enum(ACCOUNT_TYPES),
  paidUntil: IsoDateTime.nullable(),
  aiBudgetOverride: z.object({ micros: Micros.nullable() }).optional(),
  extraCreditMicros: Micros,
});
export type AccountState = z.infer<typeof AccountStateSchema>;

// Admin › Users ---------------------------------------------------------------------------------------------------
//   GET    /api/admin/users?q=&type=&cursor=&limit=   → AdminUserList (paged)
//   PATCH  /api/admin/users/:id                       AdminUserPatchBody → AdminUser (+ note)
//   PUT    /api/admin/users/:id/entitlement           AdminEntitlementBody → AdminUser
//   PUT    /api/admin/users/:id/ai-budget             AdminAiBudgetBody → AdminUser
//   DELETE /api/admin/users/:id/ai-budget             → AdminUser
//   POST   /api/admin/users/:id/credit                AdminCreditBody → AdminUser
//   GET    /api/admin/users/:id/history?cursor=       → AdminAccountHistory (newest first, paged)

/** One row of Admin › Users (moved here from apps/api/src/features/admin-users/router.ts, v2.0 fields added). */
export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  disabled: z.boolean(),
  /** v34 ACCTDEL: its deletion was asked and has not finished yet (it is off; the daily pass finishes it). */
  beingDeleted: z.boolean().optional(),
  createdAt: IsoDateTime,
  lastSignInAt: IsoDateTime.nullable(),
  accountType: z.enum(ACCOUNT_TYPES),
  effectiveType: z.enum(ACCOUNT_TYPES),
  paidUntil: IsoDateTime.nullable(),
  /** Absent: the type's default budget. `override` null: an UNLIMITED override. */
  aiBudget: z.object({ override: Micros.nullable() }).optional(),
  extraCreditMicros: Micros,
  today: z.object({
    /** Today's server-AI spend charged to the account (daily budget and credit). */
    aiSpentMicros: Micros,
    /** Today's cost past the budget and the credit, written off. */
    writtenOffMicros: Micros,
    /** Today's auto-applies (reserved and used). */
    autoApplies: z.number().int().nonnegative(),
  }),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

/** PATCH /api/admin/users/:id answers the changed row, plus a `note` when the change will not last. */
export const AdminUserPatchResponseSchema = AdminUserSchema.extend({ note: z.string().optional() });
export type AdminUserPatchResponse = z.infer<typeof AdminUserPatchResponseSchema>;

/** Admin › Users' type filter: `paid_ending` is Paid with paid_until within 7 days. */
export const ADMIN_USER_TYPE_FILTERS = ['all', 'free', 'paid', 'paid_ending'] as const;
export type AdminUserTypeFilter = (typeof ADMIN_USER_TYPE_FILTERS)[number];
export const ADMIN_USERS_PAGE_MAX = 100;
export const ADMIN_USERS_PAGE_DEFAULT = 50;

export const AdminUserListQuerySchema = z.object({
  /** Part of an email or a name. */
  q: z.string().trim().max(200).optional(),
  type: z.enum(ADMIN_USER_TYPE_FILTERS).default('all'),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_USERS_PAGE_MAX).default(ADMIN_USERS_PAGE_DEFAULT),
});
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;

export const AdminUserListSchema = z.object({
  items: z.array(AdminUserSchema),
  /** Present while more rows follow. */
  nextCursor: z.string().optional(),
});
export type AdminUserList = z.infer<typeof AdminUserListSchema>;

export const AdminUserPatchBodySchema = z.object({
  role: z.enum(ROLES, { error: `The role must be one of ${ROLES.join(', ')}.` }).optional(),
  disabled: z.boolean({ error: 'Disabled is true or false.' }).optional(),
});
export type AdminUserPatchBody = z.infer<typeof AdminUserPatchBodySchema>;

const NoteSchema = z.string().trim().max(500, messageError('MSG_TEXT_TOO_LONG', { max: 500 })).optional();

/**
 * PUT /api/admin/users/:id/entitlement: the type and term (changeEntitlement, source `admin`). `accountType: 'paid'`
 * with neither `paidUntil` nor `extendTerms` on an account with no future end gets one term from now; `free` ends the
 * term at once; `extendTerms` adds n × PAID_TERM to the later of now and the current end. A Paid end in the past is
 * refused (400).
 */
export const AdminEntitlementBodySchema = z
  .object({
    accountType: z.enum(ACCOUNT_TYPES).optional(),
    paidUntil: z.iso.datetime().nullable().optional(),
    extendTerms: z.number().int().min(1).max(36).optional(),
    note: NoteSchema,
  })
  .refine(
    (body) => body.accountType !== undefined || body.paidUntil !== undefined || body.extendTerms !== undefined,
    'Change the type, the end date or the term',
  );
export type AdminEntitlementBody = z.infer<typeof AdminEntitlementBodySchema>;

/** PUT /api/admin/users/:id/ai-budget: a daily budget in dollars ("0.25"), or Unlimited. */
export const AdminAiBudgetBodySchema = z.union([
  z.object({ usd: UsdTextSchema, note: NoteSchema }),
  z.object({ unlimited: z.literal(true), note: NoteSchema }),
]);
export type AdminAiBudgetBody = z.infer<typeof AdminAiBudgetBodySchema>;

/** The credit kinds an admin adds: a grant (> 0) or an adjustment (either sign; the balance never goes below 0). */
export const ADMIN_CREDIT_KINDS = ['grant', 'adjustment'] as const;

/** POST /api/admin/users/:id/credit (addCredit, source `admin`). 400 when the balance would go below 0. */
export const AdminCreditBodySchema = z
  .object({ usd: SignedUsdTextSchema, kind: z.enum(ADMIN_CREDIT_KINDS), note: NoteSchema })
  .refine((body) => body.kind === 'adjustment' || !body.usd.startsWith('-'), {
    path: ['usd'],
    message: 'A grant adds credit: use an amount above 0',
  });
export type AdminCreditBody = z.infer<typeof AdminCreditBodySchema>;

/** Who made a change: the admin's id and name (null for a payment or TailorIT itself, or an admin who is gone). */
const ActorSchema = z.object({ id: z.string(), name: z.string() }).nullable();

/** One account_entitlement_events row. Values are JSON: a type, an end date, or a budget in micro-dollars (or null). */
export const EntitlementEventSchema = z.object({
  id: z.number().int().positive(),
  field: z.enum(ENTITLEMENT_FIELDS),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  source: z.enum(ENTITLEMENT_SOURCES),
  actor: ActorSchema,
  paymentRef: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type EntitlementEvent = z.infer<typeof EntitlementEventSchema>;

/** One ai_credit_ledger row. A spend names its day and the AI task it paid for. */
export const CreditLedgerEntrySchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(CREDIT_KINDS),
  amountMicros: SignedMicros,
  balanceAfterMicros: Micros,
  dayKey: IsoDate.nullable(),
  source: z.enum(ENTITLEMENT_SOURCES),
  actor: ActorSchema,
  paymentRef: z.string().nullable(),
  taskId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntrySchema>;

/** GET /api/admin/users/:id/history: the entitlement events and the credit ledger, newest first, one page each. */
export const AdminAccountHistorySchema = z.object({
  events: z.array(EntitlementEventSchema),
  credit: z.array(CreditLedgerEntrySchema),
  nextCursor: z.string().optional(),
});
export type AdminAccountHistory = z.infer<typeof AdminAccountHistorySchema>;

// v32 ADMINAPP (E7): people see their day's AI use only as a share of their daily budget, never its amounts. The API
// sends this share (GET /api/me/header, GET /api/prepare/all) and the raw micro-dollars to admins only; the web draws
// the share as sent. One rounding for every place that shows it.

/** A micro-dollar amount in whole cents, as the header rounds what was used ($1 = 100 cents = 1,000,000 micros). */
const centsOfMicros = (micros: number) => Math.max(0, Math.round(micros / 10_000));

/**
 * Today's AI use as a whole percent of the day's budget, the way the header shows it: 100 only once the budget is used
 * (just under it stays at 99), else the share of the amounts in whole cents ($0.06 of $0.10 is 60%); 0 for a budget
 * under a cent that is not used yet. Null for no daily limit (an UNLIMITED budget).
 */
export function aiUsePercent(usedMicros: number, budgetMicros: number | null): number | null {
  if (budgetMicros === null) return null;
  if (usedMicros >= budgetMicros) return 100;
  const budgetCents = centsOfMicros(budgetMicros);
  return budgetCents > 0 ? Math.min(99, Math.round((centsOfMicros(usedMicros) / budgetCents) * 100)) : 0;
}

/** A share of the day's AI budget as sent to people: a whole percent, 0 to 100; null: no daily limit. */
export const AiUsePercentSchema = z.number().int().min(0).max(100).nullable();
// end v32 ADMINAPP
