// v2.0: the accounts core (docs/design/v2.0/04-accounts-limits.md, 03-ai-usage.md): the account type and its
// entitlements, the only writer of users.account_type/paid_until and user_limit_overrides (entitlements.ts); server-AI
// money, the only writer of ai_spend_daily and ai_credit_ledger (money.ts); the auto-apply window's count (usage.ts);
// the admins' one-time Paid grant (admin-grant.ts); the limits' refusals (refusals.ts).

export {
  accountStateOf,
  aiBudgetOverride,
  assertFeature,
  changeEntitlement,
  effectiveType,
  entitlementsOf,
  type EntitlementChange,
} from './entitlements';
export {
  addCredit,
  aiBudgetState,
  aiDailyBudgetMicros,
  chargeAi,
  creditBalance,
  spendToday,
  type AddCreditInput,
  type AiBudgetState,
  type Charge,
  type ChargeInput,
  type SpendOfDay,
} from './money';
export { autoApplyUsage, liveReservations, type AutoApplyUsage } from './usage';
export { ADMIN_GRANT_MARKER, grantAdminsPaidOnce, grantNewAdminPaid } from './admin-grant';
export { aiUnavailableError, aiUsageExhaustedError, autoApplyLimitMessage, resumeLimitError } from './refusals';
