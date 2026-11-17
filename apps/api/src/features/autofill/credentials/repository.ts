import { randomUUID } from 'node:crypto';
import {
  AUTOFILL_ANY_HOST,
  AUTOFILL_SIGN_IN_LIMITS,
  signInHostCovered,
  type AutofillCredential,
  type AutofillSignInItem,
  type AutofillSignInList,
  type PutAutofillSignInBody,
} from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../../core/context';
import { notFound, validationFailed } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import { openPassword, sealPassword } from './crypto';

// The job-site sign-ins (autofill_credentials, work package AF, autofill API version 3): one row per account and site
// (`*` for every site that makes an applicant sign in: signInHostCovered), its password sealed (crypto.ts). Only this
// file touches the table. The list and a save answer the host, the email, the time and where and when it was last read,
// never the password; only credentialFor, for the extension's Auto sign-in, opens one (and records that read). Nothing
// here logs.

interface CredentialRow {
  id: string;
  host: string;
  email: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  updated_at: string;
  last_read_host: string | null;
  last_read_at: string | null;
}

type ItemRow = Pick<CredentialRow, 'id' | 'host' | 'email' | 'updated_at' | 'last_read_host' | 'last_read_at'>;

const NEEDS_PASSWORD = 'Enter the password for this site.';

const itemOf = (row: ItemRow): AutofillSignInItem => ({
  id: row.id,
  host: row.host,
  email: row.email,
  updatedAt: row.updated_at,
  lastReadHost: row.last_read_host,
  lastReadAt: row.last_read_at,
});

const ITEM_COLUMNS = 'id, host, email, updated_at, last_read_host, last_read_at';

/** GET /sign-ins: every site's sign-in of the account, `*` first, then by host. Never a password. */
export async function listSignIns(deps: Pick<AppDeps, 'db'>, userId: string): Promise<AutofillSignInList> {
  const rows = await deps.db.all<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM autofill_credentials WHERE user_id = ?
     ORDER BY host <> '*', host`,
    [userId],
  );
  return { items: rows.map(itemOf), total: rows.length, limit: AUTOFILL_SIGN_IN_LIMITS.saved };
}

/**
 * PUT /sign-ins: the sign-in for `host`, replacing the one there (its id and creation time kept). Without a password
 * the saved one is kept (an email changed alone); a new host needs one (400). 409 past AUTOFILL_SIGN_IN_LIMITS.saved.
 * v3.0 D2-B: the look for the host's row, the count and the insert hold the person's lock, so two saves at once never
 * pass the cap together.
 */
export async function saveSignIn(
  deps: Pick<AppDeps, 'db' | 'now' | 'config' | 'log' | 'services'>,
  userId: string,
  body: PutAutofillSignInBody,
): Promise<AutofillSignInItem> {
  const now = nowIso(deps);
  // Sealed before the transaction: the key file is made on the first save.
  const sealed = body.password === undefined ? null : await sealPassword(deps, userId, body.host, body.password);
  return deps.db.tx(async (t) => {
    await t.lockPerson(userId);
    const existing = await t.one<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM autofill_credentials WHERE user_id = ? AND host = ?`, [
      userId,
      body.host,
    ]);
    if (existing) {
      if (sealed) {
        await t.run(
          `UPDATE autofill_credentials SET email = ?, ciphertext = ?, iv = ?, tag = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
          [body.email, sealed.ciphertext, sealed.iv, sealed.tag, now, existing.id, userId],
        );
      } else {
        await t.run('UPDATE autofill_credentials SET email = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
          body.email,
          now,
          existing.id,
          userId,
        ]);
      }
      return itemOf({ ...existing, email: body.email, updated_at: now });
    }
    if (!sealed) throw validationFailed(NEEDS_PASSWORD, { password: NEEDS_PASSWORD });
    const saved = await t.one<{ n: number }>('SELECT count(*) AS n FROM autofill_credentials WHERE user_id = ?', [userId]);
    // v30 ST3: the refusal is the constant MSG_SIGN_INS_MAX.
    if ((saved?.n ?? 0) >= AUTOFILL_SIGN_IN_LIMITS.saved) {
      throw refuse(deps, 'conflict', 'MSG_SIGN_INS_MAX', { max: AUTOFILL_SIGN_IN_LIMITS.saved });
    }
    const id = randomUUID();
    await t.run(
      `INSERT INTO autofill_credentials(id, user_id, host, email, ciphertext, iv, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, body.host, body.email, sealed.ciphertext, sealed.iv, sealed.tag, now, now],
    );
    return itemOf({ id, host: body.host, email: body.email, updated_at: now, last_read_host: null, last_read_at: null });
  }, { label: 'saveSignIn' });
}

/** DELETE /sign-ins/:id: 404 for another account's or none. */
export async function deleteSignIn(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<void> {
  const removed = await deps.db.run('DELETE FROM autofill_credentials WHERE id = ? AND user_id = ?', [id, userId]);
  if (removed.changes === 0) throw notFound('That sign-in');
}

/**
 * GET /credentials?host=&path=: the account's sign-in for exactly `host`, else, for a job site that makes an applicant
 * sign in (signInHostCovered: by its host, and on a host it covers by its candidate paths, by `path`), the one for every
 * site, opened; null otherwise. The one reader of a password; the read is recorded on the row (the host asked for, and
 * when; never the path).
 */
export async function credentialFor(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now'>,
  userId: string,
  host: string,
  path?: string,
): Promise<AutofillCredential | null> {
  const hosts = signInHostCovered(host, path) ? [host, AUTOFILL_ANY_HOST] : [host];
  const row = await deps.db.one<CredentialRow>(
    `SELECT id, host, email, ciphertext, iv, tag, updated_at, last_read_host, last_read_at FROM autofill_credentials
     WHERE user_id = ? AND host IN (${deps.db.dialect.list(hosts.length)}) ORDER BY host = ? LIMIT 1`,
    [userId, ...hosts, AUTOFILL_ANY_HOST],
  );
  if (!row) return null;
  const password = await openPassword(deps, userId, row.host, { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
  await deps.db.run('UPDATE autofill_credentials SET last_read_host = ?, last_read_at = ? WHERE id = ? AND user_id = ?', [
    host,
    nowIso(deps),
    row.id,
    userId,
  ]);
  return { host: row.host as AutofillCredential['host'], email: row.email, password };
}
