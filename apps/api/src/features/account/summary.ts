import { AccountSummarySchema, type AccountSummary } from '@tailorit/shared';
import { autoApplyUsage, creditBalance, entitlementsOf } from '../../core/accounts/index';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { resumeCount } from '../resumes/counters';

// v2.0: what a person sees of their account (docs/design/v2.0/04-accounts-limits.md, "Subscribe and Buy credit"). It
// never carries the daily AI budget, the day's AI spend, or anything about the server: the extra-credit balance is the
// only money shown, and the answer is parsed through AccountSummarySchema, which drops any other field.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** GET /api/account's answer for one person. */
export async function accountSummary(deps: Deps, userId: string): Promise<AccountSummary> {
  const entitlements = await entitlementsOf(deps, userId);
  const usage = await autoApplyUsage(deps, userId);
  const constants = constantsOf(deps);
  const contactEmail = constants.get('ADMIN_CONTACT_EMAIL');
  const paid = entitlements.type === 'paid';
  return AccountSummarySchema.parse({
    type: entitlements.type,
    // "Paid until <date>" is for a Paid account only: a lapsed term's end is history, not a plan.
    paidUntil: paid ? entitlements.paidUntil : null,
    extraCredit: { balanceMicros: await creditBalance(deps, userId) },
    autoApply: {
      used: usage.used,
      limit: usage.limit,
      windowDays: usage.windowDays,
      resetsAt: usage.resetsAt,
      resetText: usage.resetText,
    },
    // Every resume the account holds, of every kind: the stored count the limit reads (v30 DB-JOBS, D1d).
    resumes: { count: await resumeCount(deps.db, userId), limit: entitlements.resumes },
    features: {
      aiJobSearch: entitlements.aiJobSearch,
      mcp: entitlements.mcp,
      batchDownload: entitlements.batchDownload,
    },
    // The payment-ready seam: v2.0 answers `contact`; a payment integration answers `checkout` with its address.
    subscribe: { visible: !paid, mode: 'contact', message: constants.message('MSG_SUBSCRIBE_CONTACT'), contactEmail },
    buyCredit: { mode: 'contact', message: constants.message('MSG_CREDIT_CONTACT'), contactEmail },
  });
}
