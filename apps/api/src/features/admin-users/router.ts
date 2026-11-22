import type { Router } from 'express';
import { z } from 'zod';
import {
  AdminAiBudgetBodySchema,
  AdminCreditBodySchema,
  AdminEntitlementBodySchema,
  AdminUserListQuerySchema,
  AdminUserPatchBodySchema,
  type AdminUserPatchBody,
  IdParam,
  usdToMicros,
  type AdminUserPatchResponse,
} from '@tailorit/shared';
import { addCredit, changeEntitlement, type EntitlementChange } from '../../core/accounts/index';
import { adminRouter, type AdminActor } from '../../core/admin/index';
import { expireConnectCodesForUser, revokeExtensionTokensForUser } from '../../core/auth/extension-tokens';
import { destroySessionsForUser } from '../../core/auth/session';
import { getUserById, isConfiguredAdmin } from '../../core/auth/users';
import { nowIso, type AppDeps } from '../../core/context';
import { conflict, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { accountHistory, adminUserOf, listAdminUsers } from './accounts';
import { endGrantsOfAccount } from '../sharing/end-grant'; // v33 SHARE-2
// v34 ACCTDEL
import { AccountDeleteBodySchema, type AccountDeletionResult } from '@tailorit/shared/account-deletion';
import { constantsOf } from '../../core/constants/service';
import { notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { confirmsAccount, deleteAccount, deletionRequestOf, lockEnabledAdmins } from '../account-deletion/service';
import { deleteTries, emailMismatch } from '../account-deletion/router';
import { userOf } from '../../core/auth/guards';
// end v34 ACCTDEL

// Administrator: list accounts, change role, disable. Owned by work package F3 (see docs/ARCHITECTURE.md). v2.0 (P6b;
// docs/design/v2.0/04-accounts-limits.md, "Admin routes (accounts)"): the list is paged and each row carries the
// account's type, term, AI budget override, extra credit and day so far (AdminUserSchema, @tailorit/shared); the type
// and term, the budget override and the credit change only through the entitlement service and the credit ledger
// (source 'admin', the admin as the actor), which audit every change. v30 ST4: an adminRouter (core/admin): its guard,
// input checks, 404s and an audit line for each change.

const ANOTHER_ADMIN = 'Another administrator can, if it is really meant.';
// v34 ACCTDEL
const NO_ADMIN_LEFT = 'That would leave no administrator who can sign in. Make another account an administrator first.';
const BEING_DELETED = "This account's deletion has not finished, so it stays off. Delete account (below) finishes it now.";
// end v34 ACCTDEL

const HistoryQuerySchema = z.object({ cursor: z.string().min(1).max(200).optional() });

const idOf = (raw: string | undefined) => parseInput(IdParam, raw ?? '', 'account id');

/** PATCH /api/admin/users/:id: the role, or disabled; null for an account that does not exist. */
async function patchAccount(
  deps: AppDeps,
  id: string,
  change: AdminUserPatchBody,
  admin: AdminActor,
): Promise<AdminUserPatchResponse | null> {
  const target = await getUserById(deps, id);
  if (!target) return null;
  if (change.role === undefined && change.disabled === undefined) {
    throw validationFailed('There is nothing to change.');
  }

  // Nobody demotes or disables the account they are signed in with: the one person who made that mistake would be
  // the one person who could no longer undo it. Another administrator can.
  if (target.id === admin.id) {
    if (change.disabled === true) {
      throw conflict(`You cannot disable the account you are signed in with. ${ANOTHER_ADMIN}`);
    }
    if (change.role !== undefined && change.role !== 'admin') {
      throw conflict(
        `You cannot remove the administrator role from the account you are signed in with. ${ANOTHER_ADMIN}`,
      );
    }
  }

  // v3.0 D2 (D2-0): async, as the core calls it makes are.
  await deps.db.tx(async (t) => {
    // v34 ACCTDEL: the last administrator who can sign in stays, under the deletion's locks (account-deletion/service.ts
    // lockEnabledAdmins): disabling or demoting an enabled administrator needs another enabled one at this moment (a
    // deletion of the acting administrator's own account may have committed meanwhile). An account being deleted stays
    // off.
    if (target.role === 'admin' && (change.disabled === true || (change.role !== undefined && change.role !== 'admin'))) {
      const admins = await lockEnabledAdmins(t);
      if (admins.includes(target.id) && !admins.some((id) => id !== target.id)) throw conflict(NO_ADMIN_LEFT);
    }
    if (change.disabled === false && (await deletionRequestOf(t, target.id))) throw conflict(BEING_DELETED);
    // end v34 ACCTDEL
    const now = nowIso(deps);
    if (change.role !== undefined && change.role !== target.role) {
      await t.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [change.role, now, target.id]);
    }
    if (change.disabled !== undefined && change.disabled !== (target.disabled_at !== null)) {
      await t.run('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?', [change.disabled ? now : null, now, target.id]);
    }
    // A disabled account's sessions end now (the session check refuses them anyway; this removes the rows), and so
    // do its extension connections (revoked: each row keeps why it ended until the autofill prune drops it) and its
    // connect codes (expired: re-enabled, the account must not connect from a code minted before the disable).
    if (change.disabled === true) {
      await destroySessionsForUser(deps, target.id);
      await revokeExtensionTokensForUser(deps, target.id, 'account_disabled');
      await expireConnectCodesForUser(deps, target.id);
    }
  });
  // v33 SHARE-2 (PLAN-sharing.md §6): after the disable committed, the work of every share on either side of the account
  // stops (endGrant; the grants keep their state: re-enabled, they are live again). Never throws.
  if (change.disabled === true) await endGrantsOfAccount(deps, target.id);

  const body: AdminUserPatchResponse = await adminUserOf(deps, target.id);
  if (change.role === 'user' && isConfiguredAdmin(deps, target.email)) {
    body.note =
      `${target.email} is listed in ADMIN_EMAILS, so it becomes an administrator again the next time it signs in ` +
      'or the server restarts. Remove it from ADMIN_EMAILS to make this change last.';
  }
  return body;
}

/** Mounted at /api/admin/users. */
export function createAdminUsersRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'account',
    id: IdParam,
    list: { query: AdminUserListQuerySchema, run: (_deps, query) => listAdminUsers(deps, query) },
    patch: { body: AdminUserPatchBodySchema, run: (_deps, id, change, admin) => patchAccount(deps, id, change, admin) },
    routes(router, { handle, audit }) {
      // The type and the term: Free, Paid (one term when no end is given), an exact end, or n more terms.
      router.put(
        '/:id/entitlement',
        handle(async (req, admin) => {
          const userId = idOf(req.params.id);
          const body = parseInput(AdminEntitlementBodySchema, req.body ?? {}, 'change');
          const change: EntitlementChange = { userId, source: 'admin', actorUserId: admin.id };
          if (body.accountType !== undefined) change.accountType = body.accountType;
          if (body.paidUntil !== undefined) change.paidUntil = body.paidUntil;
          if (body.extendTerms !== undefined) change.extendTerms = body.extendTerms;
          if (body.note !== undefined) change.note = body.note;
          await changeEntitlement(deps, change);
          await audit({ action: 'entitlement', ids: [userId], actor: admin, change: body });
          return adminUserOf(deps, userId);
        }),
      );

      // The daily AI budget override, in dollars or Unlimited; removing it brings back the account type's budget.
      router.put(
        '/:id/ai-budget',
        handle(async (req, admin) => {
          const userId = idOf(req.params.id);
          const body = parseInput(AdminAiBudgetBodySchema, req.body ?? {}, 'budget');
          let micros: number | null = null;
          if ('usd' in body) {
            micros = usdToMicros(body.usd);
            if (micros === null) {
              const message = 'Enter a daily budget in dollars, such as 0.25.';
              throw validationFailed(message, { usd: message });
            }
          }
          await changeEntitlement(deps, {
            userId,
            source: 'admin',
            actorUserId: admin.id,
            aiDailyBudget: { micros },
            ...(body.note !== undefined ? { note: body.note } : {}),
          });
          await audit({ action: 'ai-budget', ids: [userId], actor: admin, change: body });
          return adminUserOf(deps, userId);
        }),
      );

      router.delete(
        '/:id/ai-budget',
        handle(async (req, admin) => {
          const userId = idOf(req.params.id);
          await changeEntitlement(deps, { userId, source: 'admin', actorUserId: admin.id, aiDailyBudget: 'clear' });
          await audit({ action: 'ai-budget-clear', ids: [userId], actor: admin, change: null });
          return adminUserOf(deps, userId);
        }),
      );

      // Extra credit: a grant (above $0) or an adjustment (either sign); the balance never goes below $0.
      router.post(
        '/:id/credit',
        handle(async (req, admin) => {
          const userId = idOf(req.params.id);
          const body = parseInput(AdminCreditBodySchema, req.body ?? {}, 'credit');
          const amountMicros = usdToMicros(body.usd, { signed: body.kind === 'adjustment' });
          if (amountMicros === null) {
            const message = 'Enter an amount in dollars, such as 5.00.';
            throw validationFailed(message, { usd: message });
          }
          await addCredit(deps, {
            userId,
            amountMicros,
            kind: body.kind,
            source: 'admin',
            actorUserId: admin.id,
            ...(body.note !== undefined ? { note: body.note } : {}),
          });
          await audit({ action: 'credit', ids: [userId], actor: admin, change: body });
          return adminUserOf(deps, userId);
        }),
      );

      // v34 ACCTDEL (PLAN G10): Delete account. Never the administrator's own account from here (Settings › Account ›
      // Delete my account is theirs), never the last administrator who can sign in (deleteAccount refuses it), and only
      // with the account's address typed. 200 `deleted`; 202 `pending` when the account is off and the rest finishes on
      // its own (asked again, it finishes now). The audit line names the deletion by its line in account_deletions
      // (#id), never the account: the account and its address are gone.
      router.post('/:id/delete', deleteTries('admin-account-delete'), async (req, res) => {
        const admin = userOf(req);
        const userId = idOf(req.params.id);
        const body = parseInput(AccountDeleteBodySchema, req.body ?? {}, 'confirmation');
        const target = await getUserById(deps, userId);
        if (!target) throw notFound('That account');
        if (target.id === admin.id) throw refuse(deps, 'conflict', 'MSG_ACCOUNT_DELETE_OWN');
        if (!confirmsAccount(target, body.email)) throw emailMismatch(deps);
        const done = await deleteAccount(deps, target.id, 'admin');
        await audit({ action: 'delete', ids: [done.deletionId === null ? done.state : `#${done.deletionId}`], actor: admin, change: null });
        const answer: AccountDeletionResult =
          done.state === 'pending'
            ? { state: 'pending', message: constantsOf(deps).message('MSG_ACCOUNT_DELETE_PENDING_ADMIN') }
            : { state: 'deleted' };
        res.status(done.state === 'pending' ? 202 : 200).json(answer);
      });
      // end v34 ACCTDEL

      router.get(
        '/:id/history',
        handle((req) => {
          const userId = idOf(req.params.id);
          const { cursor } = parseInput(HistoryQuerySchema, req.query, 'query');
          return accountHistory(deps, userId, cursor);
        }),
      );
    },
  });
}
