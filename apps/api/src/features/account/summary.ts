import { AccountSummarySchema, type AccountSummary } from '@tailorit/shared';
import type { ActingProfile } from '@tailorit/shared/sharing'; // v33 SHARE-3
import { autoApplyUsage, creditBalance, entitlementsOf } from '../../core/accounts/index';
import { grantHolds, type LiveGrant } from '../../core/auth/grants'; // v33 SHARE-3
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { resumeCount } from '../resumes/counters';
import { profileFamilyOf } from '../resumes/role-family'; // v33 SHARE-3

// v2.0: what a person sees of their account (docs/design/v2.0/04-accounts-limits.md, "Subscribe and Buy credit"). It
// never carries the daily AI budget, the day's AI spend, or anything about the server: the extra-credit balance is the
// only money shown, and the answer is parsed through AccountSummarySchema, which drops any other field.

/**
 * GET /api/account's answer for one person. v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §4 "Mixed routes"): `grant`, a
 * live grant of a profile shared with that person (B) the request names, makes it the mixed answer: B's plan, extra
 * credit, features and Subscribe (B pays for what B does there: a Free B has Free's even on a Paid A's profile), A's
 * auto-applies and resume room (the profile's: B's work fills A's), and `profile`, whose profile it is. The review: A's
 * auto-applies only with Prepare's See (prepare:view; else B's own), A's default resume and its field only with
 * Documents' See (documents:view; else null), as the routes that show them ask.
 */
export async function accountSummary(deps: AppDeps, userId: string, grant: LiveGrant | null = null): Promise<AccountSummary> {
  const entitlements = await entitlementsOf(deps, userId);
  // v33 SHARE-3: the counts are the profile's (A's own plan sets its room and its auto-applies a day).
  const ownerId = grant ? grant.owner.id : userId;
  const ownerEntitlements = grant ? await entitlementsOf(deps, ownerId) : entitlements;
  // v33 SHARE-3 (review): A's auto-applies only for a grantee who may see A's Prepare.
  const usage = await autoApplyUsage(deps, grant && !grantHolds(grant, 'prepare:view') ? userId : ownerId);
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
    resumes: { count: await resumeCount(deps.db, ownerId), limit: ownerEntitlements.resumes }, // v33 SHARE-3: the profile's
    features: {
      aiJobSearch: entitlements.aiJobSearch,
      mcp: entitlements.mcp,
      batchDownload: entitlements.batchDownload,
    },
    // The payment-ready seam: v2.0 answers `contact`; a payment integration answers `checkout` with its address.
    subscribe: { visible: !paid, mode: 'contact', message: constants.message('MSG_SUBSCRIBE_CONTACT'), contactEmail },
    buyCredit: { mode: 'contact', message: constants.message('MSG_CREDIT_CONTACT'), contactEmail },
    ...(grant ? { profile: await actingProfileOf(deps, grant) } : {}), // v33 SHARE-3
  });
}

/** v33 SHARE-3: whose profile a mixed answer counts (AccountSummary.profile): A's name, address, default resume, field. */
async function actingProfileOf(deps: AppDeps, grant: LiveGrant): Promise<ActingProfile> {
  const ownerId = grant.owner.id;
  // v33 SHARE-3 (review): A's default resume and its field only for a grantee who may see A's documents.
  if (!grantHolds(grant, 'documents:view')) return { name: grant.owner.name, email: grant.owner.email, defaultResumeId: null, roleFamily: null };
  const row = await deps.db.one<{ default_resume_id: string | null }>('SELECT default_resume_id FROM users WHERE id = ?', [ownerId]);
  const family = await profileFamilyOf(deps, ownerId, row?.default_resume_id ?? null);
  return {
    name: grant.owner.name,
    email: grant.owner.email,
    defaultResumeId: row?.default_resume_id ?? null,
    roleFamily: family.source === 'none' ? null : family.familyId,
  };
}
