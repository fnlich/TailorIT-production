import { isConfiguredAdmin } from '../auth/users';
import type { AppDeps } from '../context';
import { changeEntitlement } from './entitlements';

// v2.0: the admin accounts' first Paid term (A26; docs/design/v2.0/01-data-model.md, 0820's backfill). Every existing
// account starts Free; at the first start after the update, every account whose role is admin or whose email is in
// ADMIN_EMAILS is made Paid until now + PAID_TERM, through the entitlement service with source 'system', so it is
// audited like any change. It runs once, marked by app_settings `v20:admin-paid-grant`: an admin added later, or one
// whose term an admin changed, is never touched again by it.
//
// v30 FIX-B (BEH-7, DECISIONS P6.3): v3.0 starts on an empty database (P5), so that first start finds no account and
// the owner, signing in afterwards from ADMIN_EMAILS, would be a Free admin. On an install whose grant ran with 0
// accounts, an ADMIN_EMAILS account gets the same first Paid term when it is created (grantNewAdminPaid). The marker
// is claimed first (ON CONFLICT DO NOTHING): the API and the worker run the grant at once on a first start, and the
// slower one now waits for the other's marker and grants nothing (no duplicate key, no second term).

export const ADMIN_GRANT_MARKER = 'v20:admin-paid-grant';

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Grants the admins their first term, once. Answers the accounts granted, or null when it ran before. */
export async function grantAdminsPaidOnce(deps: Deps): Promise<string[] | null> {
  const granted = await deps.db.tx(
    async (t) => {
      const now = deps.now().toISOString();
      const claimed = await t.run('INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING', [
        ADMIN_GRANT_MARKER,
        JSON.stringify({ at: now, accounts: 0 }),
        now,
      ]);
      if (claimed.changes === 0) return null;
      const emails = deps.config.auth.adminEmails;
      const admins = (
        await t.all<{ id: string }>(
          `SELECT id FROM users WHERE role = 'admin'
             OR lower(email) IN (SELECT lower(value) FROM ${t.dialect.jsonEach('?')}) ORDER BY created_at, id`,
          [JSON.stringify(emails)],
        )
      ).map((row) => row.id);
      for (const userId of admins) {
        // In this transaction (changeEntitlement joins it).
        await changeEntitlement(deps, { userId, source: 'system', accountType: 'paid', note: 'The v2.0 update: the admin accounts start Paid.' });
      }
      if (admins.length > 0) {
        await t.run('UPDATE app_settings SET value = ? WHERE key = ?', [JSON.stringify({ at: now, accounts: admins.length }), ADMIN_GRANT_MARKER]);
      }
      return admins;
    },
    { label: 'grantAdminsPaidOnce' },
  );
  if (granted !== null) deps.log.info(`[accounts] the v2.0 admin grant: ${granted.length} admin account(s) made Paid for one term`);
  return granted;
}

/** The grant's marker: how many accounts it made Paid, or null when it has not run (or its value is unreadable). */
async function grantedAccounts(deps: Pick<AppDeps, 'db'>): Promise<number | null> {
  const row = await deps.db.one<{ value: unknown }>('SELECT value FROM app_settings WHERE key = ?', [ADMIN_GRANT_MARKER]);
  if (!row) return null;
  try {
    const value = (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) as { accounts?: unknown } | null;
    return typeof value?.accounts === 'number' ? value.accounts : null;
  } catch {
    return null;
  }
}

/**
 * v30 FIX-B (BEH-7, P6.3): an account just created as an administrator from ADMIN_EMAILS, on an install whose one-time
 * grant ran with no account at all (v3.0's fresh start), gets that grant's first Paid term (source 'system', audited).
 * An install upgraded from v2.0 (the grant ran with its admins) and one where the grant has not run yet (the next
 * start's grant covers the account) change nothing. Joins the caller's transaction. Answers whether it granted.
 */
export async function grantNewAdminPaid(deps: Deps, user: { id: string; email: string; role: string }): Promise<boolean> {
  if (user.role !== 'admin' || !isConfiguredAdmin(deps, user.email)) return false;
  if ((await grantedAccounts(deps)) !== 0) return false;
  await changeEntitlement(deps, {
    userId: user.id,
    source: 'system',
    accountType: 'paid',
    note: 'The v3.0 fresh start: an administrator from ADMIN_EMAILS starts Paid.',
  });
  deps.log.info('[accounts] a new administrator from ADMIN_EMAILS on a fresh install: made Paid for one term');
  return true;
}
