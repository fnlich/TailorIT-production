import type { Request } from 'express';
import { isSharePermission, type SharePermission } from '@tailorit/shared/sharing';
import { ownProfileOnly, profileEnded, profileNotShared, type LiveGrant } from '../auth/grants';
import { notSignedIn } from '../http/errors';

// v33 SHARE-0 (PLAN F9 "Who pays"; SP v33 PLAN-sharing.md §5): who pays for a piece of TailorIT AI work. When B works on
// a profile A shared with them, B pays: B's plan, daily budget, extra credit and hourly limits, even on a Paid A's
// profile; limits are counted per person, so working on 3 profiles never triples them. A Payer names that person and
// the grant the work runs under (the AI queue checks the grant at enqueue and again at run: a revoke, a removed
// permission or a disabled account stops every B-paid task that has not started).
//
// A Payer is branded: only these constructors make one, so every `chargeTo` (required since v33 INT-1) names how
// its payer was decided:
//   payerOf(req)            the request's: B with the grant while acting, else the signed-in person (also guards.ts);
//   payerOfGrant(grant,p)   B under a live grant (core/auth/grants.ts): MCP's caller on a shared profile, the extension's
//                           AI help on a job B prepared (SHARE-3's payerOfQueueRun builds on it);
//   payerOfRow(row)         a stored row's (prepare_jobs, the auto-apply queue, the resume backlogs);
//   payerOfTask(row)        an ai_tasks row's (the queue's run: the gate and the grant check again);
//   ownPayer(id, reason)    a person paying for their own work outside a request (the extension, a daily step); a scan
//                           lists every call with its reason, and none may be under features/mcp/** (MCP's caller pays);
//   serverCost(reason)      nobody: a server cost (`server` task kinds and the job-analysis backlog only; a scan).
// The payer goes into the queue's rows through payerColumns; the AI queue scopes a task's dedupe key by owner and payer
// itself (ai/queue.ts scopedDedupeKey: the one builder; v33 SHARE-3's review retired this module's payerDedupeKey).

declare const PAYER: unique symbol;

/** Who pays for an AI task, and under which grant. Made only by the constructors of this module (and guards' payerOf). */
export interface Payer {
  /** The account whose budget, credit, plan and hourly limits pay; null: a server cost (nobody's). */
  readonly id: string | null;
  /** The grant the work runs under (B on A's profile); null: the payer's own profile, or a server cost. */
  readonly grantId: string | null;
  /** The permission that allowed it under that grant (the route's, or the row's); null without a grant. */
  readonly perm: SharePermission | null;
  readonly [PAYER]: true;
}

/** A payer that is a person (every Payer but serverCost's). */
export type PersonPayer = Payer & { readonly id: string };

function brand(id: string | null, grantId: string | null, perm: SharePermission | null): Payer {
  return Object.freeze({ id, grantId, perm }) as Payer;
}

/** Whether a person pays (else it is a server cost). */
export const isPersonPayer = (payer: Payer): payer is PersonPayer => payer.id !== null;

/**
 * The request's payer: while it acts on a shared profile (req.acting), the signed-in person (B) under that grant and
 * the route's permission; otherwise the signed-in person themself (an extension token's request: its owner). Throws
 * own_profile_only while a named profile is not decided yet (code before the route guard fails closed).
 */
export function payerOf(req: Request): PersonPayer {
  if (!req.user) throw notSignedIn();
  if (req.acting) return brand(req.user.id, req.acting.grantId, req.acting.routePerm) as PersonPayer;
  if (req.actingCandidate && req.acting === undefined) throw ownProfileOnly();
  return brand(req.user.id, null, null) as PersonPayer;
}

/** B paying under a live grant for work allowed by `perm` (throws profile_not_shared when the grant lacks it). */
export function payerOfGrant(grant: LiveGrant, perm: SharePermission): PersonPayer {
  if (!isSharePermission(perm) || !grant.permissions.includes(perm)) throw profileNotShared();
  return brand(grant.granteeId, grant.id, perm) as PersonPayer;
}

/**
 * A person paying for their own work outside a request (`reason`: a short literal the scan lists, e.g. 'extension',
 * 'daily'). Never under features/mcp/** (the caller pays there: payerOf or payerOfGrant).
 */
export function ownPayer(userId: string, reason: string): PersonPayer {
  if (!userId) throw new Error('ownPayer needs the account that pays.');
  if (!reason.trim()) throw new Error('ownPayer needs a reason (the payer scan lists it).');
  return brand(userId, null, null) as PersonPayer;
}

/** A server cost, charged to nobody (`reason`: a short literal the scan lists): `server` kinds and the job-analysis backlog. */
export function serverCost(reason: string): Payer {
  if (!reason.trim()) throw new Error('serverCost needs a reason (the payer scan lists it).');
  return brand(null, null, null);
}

/**
 * The columns of a stored row that name its payer (migration 0049). `user_id` is whose profile; the payer is the first
 * of `started_by` (prepare_jobs), `prepared_by` (autofill_agent_queue), `charge_user_id` (the resume backlogs: null is
 * the owner) that is set, else `user_id`; `grant_id` the grant it runs under.
 */
export interface PayerRow {
  user_id: string;
  started_by?: string | null;
  prepared_by?: string | null;
  charge_user_id?: string | null;
  grant_id?: string | null;
}

/**
 * A stored row's payer (the runner's step, a queue row's run, a backlog retry). `perm` is the permission the row's work
 * needs under its grant (default `prepare:run`: a Prepare's and a queue row's; `documents:edit` for a resume backlog).
 * A row paid by someone other than its owner that names no grant any more throws profile_ended: the work stops. It
 * builds the payer; it does not check that the grant is live (the runner and the queue call assertGrantLive).
 */
export function payerOfRow(row: PayerRow, perm: SharePermission = 'prepare:run'): PersonPayer {
  const payerId = row.started_by ?? row.prepared_by ?? row.charge_user_id ?? row.user_id;
  const grantId = row.grant_id ?? null;
  if (grantId === null) {
    if (payerId !== row.user_id) throw profileEnded();
    return brand(payerId, null, null) as PersonPayer;
  }
  if (payerId === row.user_id) throw new Error('A row under a grant is paid by the grantee, never by the profile owner.');
  if (!isSharePermission(perm)) throw new Error(`Unknown permission ${String(perm)}.`);
  return brand(payerId, grantId, perm) as PersonPayer;
}

/** An ai_tasks row's payer columns. */
export interface TaskPayerRow {
  /** Whose task (null: public work, a job analysis). */
  user_id: string | null;
  /** Who pays (null: a server cost). */
  charge_user_id: string | null;
  grant_id: string | null;
  grant_perm: string | null;
}

/**
 * An AI task's payer as stored (the queue's run checks the gate and the grant again with it): charge_user_id null is a
 * server cost; a grant names its permission (grant_perm). A task paid by someone other than its owner names a grant,
 * except public work (user_id null: a job analysis Prepare forced, charged to its person).
 */
export function payerOfTask(row: TaskPayerRow): Payer {
  if (row.charge_user_id === null) {
    if (row.grant_id !== null) throw profileEnded();
    return brand(null, null, null);
  }
  if (row.grant_id === null) {
    if (row.user_id !== null && row.charge_user_id !== row.user_id) throw profileEnded();
    return brand(row.charge_user_id, null, null);
  }
  if (!isSharePermission(row.grant_perm)) throw new Error('A task under a grant names the permission it was queued under.');
  return brand(row.charge_user_id, row.grant_id, row.grant_perm);
}

/** What a queue row stores of its payer (ai_tasks: charge_user_id, grant_id, grant_perm). */
export function payerColumns(payer: Payer): { charge_user_id: string | null; grant_id: string | null; grant_perm: SharePermission | null } {
  return { charge_user_id: payer.id, grant_id: payer.grantId, grant_perm: payer.perm };
}

/** Whether two payers are the same person under the same grant. */
export const samePayer = (a: Payer, b: Payer): boolean => a.id === b.id && a.grantId === b.grantId;
