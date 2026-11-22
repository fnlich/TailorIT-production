import { randomBytes } from 'node:crypto';
import {
  AUTOFILL_API_VERSION,
  EXTENSION_SCOPES,
  ExtensionClientSchema,
  formatConnectCode,
  type AutofillConnectResponse,
  type AutofillRedeemResponse,
  type AutofillSession,
  type AutofillTokenItem,
  type AutofillTokenList,
  type ExtensionBrowser,
  type ExtensionClient,
  type ExtensionOs,
  type ExtensionScope,
} from '@tailorit/shared/autofill';
import {
  assertRoomForExtensionToken,
  createExtensionToken,
  EXTENSION_DISCONNECTED,
  hashExtensionSecret,
  readScopes,
} from '../../core/auth/extension-tokens';
import { getUserById } from '../../core/auth/users';
import type { AppDeps, SessionUser } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { deletionRequestOf } from '../account-deletion/service'; // v34 FIX-API

// Connecting the TailorIT Autofill extension. The Settings page mints a connect code (16 Crockford base32 characters,
// 80 random bits) that lives 10 minutes and works once; the database keeps only its SHA-256 and the scopes chosen with
// it. The page hands the code to the extension (chrome.runtime.sendMessage), or shows it to type in, and the
// extension's worker exchanges it, with no cookie, for a token carrying exactly the code's scopes
// (core/auth/extension-tokens.ts). Neither the code nor the token is ever logged; the log names ids only.

/** A connect code's life. */
export const CONNECT_CODE_TTL_MS = 10 * 60_000;
/** Live codes per account: minting one more expires the oldest. */
export const MAX_LIVE_CONNECT_CODES = 3;
/** A code's row is kept this long after it expired, used or not, then pruned. */
const KEEP_EXPIRED_CODES_MS = 86_400_000;

const ACCOUNT_DISABLED =
  'That account has been disabled, so the extension cannot connect to it. Ask an administrator of this installation ' +
  'to re-enable it.';

/** Crockford's base32: the digits and the capitals but I, L, O and U (normalizeConnectCode reads it back). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new code, normalized: randomBytes(10) as 16 characters of 5 bits each. */
export function newConnectCode(): string {
  let code = '';
  let bits = 0;
  let size = 0;
  for (const byte of randomBytes(10)) {
    bits = (bits << 8) | byte;
    size += 8;
    while (size >= 5) {
      size -= 5;
      code += CROCKFORD[(bits >> size) & 31];
    }
    bits &= (1 << size) - 1;
  }
  return code;
}

/**
 * Every scope, without profile:sensitive when "Let this browser read work authorization..." was unticked, and without
 * credentials:read unless "Let this browser sign in to job sites for me" was ticked (version 3: off by default).
 */
export function connectScopes(includeSensitive: boolean, allowSignIn = false): ExtensionScope[] {
  return EXTENSION_SCOPES.filter(
    (scope) =>
      (includeSensitive || scope !== 'profile:sensitive') && (allowSignIn || scope !== 'credentials:read'),
  );
}

/**
 * POST /connect: stores a new code for `userId` with its scopes and answers it in groups of four, with the extension
 * ids the page offers it to. Refused (409) while the account has the most connections allowed. v3.0 D2-B (the
 * concurrency audit): the count of the account's connections and the code's insert hold the person's lock.
 */
export async function mintConnectCode(
  deps: AppDeps,
  userId: string,
  includeSensitive: boolean,
  allowSignIn = false,
): Promise<AutofillConnectResponse> {
  const code = newConnectCode();
  const now = deps.now();
  const minted = now.toISOString();
  const expiresAt = new Date(now.getTime() + CONNECT_CODE_TTL_MS).toISOString();
  await deps.db.tx(async (t) => {
    await t.lockPerson(userId);
    await assertRoomForExtensionToken(deps, userId);
    // Only the newest MAX_LIVE_CONNECT_CODES - 1 live codes stay live beside the new one. (v30 PG-0: the insert order
    // and the open-ended offset through the dialect: every autofill test connects first.)
    await t.run(
      `UPDATE extension_connect_codes SET expires_at = ?
       WHERE code_hash IN (SELECT code_hash FROM extension_connect_codes
         WHERE user_id = ? AND used_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC, ${t.dialect.seq()} DESC ${t.dialect.offsetOnly('?')})`,
      [minted, userId, minted, MAX_LIVE_CONNECT_CODES - 1],
    );
    await t.run(
      `INSERT INTO extension_connect_codes(code_hash, user_id, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [hashExtensionSecret(code), userId, JSON.stringify(connectScopes(includeSensitive, allowSignIn)), minted, expiresAt],
    );
  }, { label: 'mintConnectCode' });
  return { code: formatConnectCode(code), expiresAt, extensionIds: [...deps.config.autofill.extensionIds] };
}

const BROWSER_NAMES: Record<ExtensionBrowser, string> = { chrome: 'Chrome', edge: 'Edge', other: 'Browser' };
const OS_NAMES: Record<ExtensionOs, string | null> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  other: null,
};

/** How Settings names a connection: "Chrome on Windows". */
export function connectionLabel(client: ExtensionClient): string {
  const os = OS_NAMES[client.os];
  return os ? `${BROWSER_NAMES[client.browser]} on ${os}` : BROWSER_NAMES[client.browser];
}

/**
 * POST /connect/redeem, in one transaction: claims the code (live and unused, so it works once), refuses a disabled
 * account and a full one, and creates the token with exactly the code's scopes. A refusal after the claim rolls it
 * back, so the code still works once the account has room. `code` is normalized (normalizeConnectCode). v3.0 D2-B (the
 * concurrency audit, D2-0's note): the cap's count and the token's insert hold the person's lock, taken as soon as the
 * claimed code names the person, so two redeems at once never pass the cap together.
 */
export async function redeemConnectCode(
  deps: AppDeps,
  code: string,
  input: { client: ExtensionClient; userAgent: string | null },
): Promise<AutofillRedeemResponse> {
  const hash = hashExtensionSecret(code);
  const redeemed = await deps.db.tx(async (t) => {
    const now = deps.now().toISOString();
    const claimed = await t.one<{ user_id: string; scopes: string }>(
      `UPDATE extension_connect_codes SET used_at = ?
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id, scopes`,
      [now, hash, now],
    );
    // v30 ST3: the refusal is the constant MSG_CONNECT_CODE_EXPIRED.
    if (!claimed) throw refuse(deps, 'not_signed_in', 'MSG_CONNECT_CODE_EXPIRED');
    await t.lockPerson(claimed.user_id);
    const user = await getUserById(deps, claimed.user_id);
    // v34 FIX-API (the final security review, F4): an account whose deletion has not finished says so (as sign-in does),
    // never "ask an administrator to re-enable it", which Admin › Users refuses for it.
    if (user?.disabled_at && (await deletionRequestOf(t, user.id))) {
      throw refuse(deps, 'account_being_deleted', 'MSG_ACCOUNT_BEING_DELETED');
    }
    if (!user || user.disabled_at) throw new AppError('account_disabled', ACCOUNT_DISABLED);
    await assertRoomForExtensionToken(deps, user.id);

    const scopes = readScopes(claimed.scopes);
    const token = await createExtensionToken(deps, user.id, {
      label: connectionLabel(input.client),
      scopes,
      client: input.client,
      userAgent: input.userAgent,
    });
    await t.run('UPDATE extension_connect_codes SET token_id = ? WHERE code_hash = ?', [token.id, hash]);
    return { user, token, scopes };
  }, { label: 'redeemConnectCode' });
  deps.log.debug(`[autofill] account ${redeemed.user.id} connected an extension (token ${redeemed.token.id})`);
  return {
    token: redeemed.token.token,
    tokenId: redeemed.token.id,
    expiresAt: redeemed.token.expiresAt,
    scopes: redeemed.scopes,
    account: { name: redeemed.user.name, email: redeemed.user.email },
    apiVersion: AUTOFILL_API_VERSION,
  };
}

/** GET /session: the token the request came with, its account, and whether TailorIT can run Claude now. */
export async function sessionView(
  deps: Pick<AppDeps, 'db'>,
  user: SessionUser,
  tokenId: string,
  aiAvailable: boolean,
): Promise<AutofillSession> {
  const row = await deps.db.one<{ label: string; scopes: string; expires_at: string }>(
    'SELECT label, scopes, expires_at FROM extension_tokens WHERE id = ? AND user_id = ?',
    [tokenId, user.id],
  );
  // attachBearer has just read this row; it can only be gone if the account was deleted in between.
  if (!row) throw new AppError('not_signed_in', EXTENSION_DISCONNECTED);
  return {
    apiVersion: AUTOFILL_API_VERSION,
    token: { id: tokenId, label: row.label, scopes: readScopes(row.scopes), expiresAt: row.expires_at },
    account: { name: user.name, email: user.email },
    ai: { available: aiAvailable },
  };
}

interface ConnectionRow {
  id: string;
  label: string;
  client: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

/** The browser and extension version the extension named when it connected; nulls when not known. */
function clientOf(json: string): Pick<AutofillTokenItem, 'browser' | 'extensionVersion'> {
  try {
    const client = ExtensionClientSchema.safeParse(JSON.parse(json));
    if (client.success) return { browser: client.data.browser, extensionVersion: client.data.extensionVersion };
  } catch {
    /* unreadable: not known */
  }
  return { browser: null, extensionVersion: null };
}

/** GET /tokens: the account's live connections (neither revoked nor expired), newest first. */
export async function listConnections(deps: Pick<AppDeps, 'db' | 'now'>, userId: string): Promise<AutofillTokenList> {
  // v30 PG-0: the insert order through the dialect (extension_tokens.seq on PostgreSQL).
  const rows = await deps.db.all<ConnectionRow>(
    `SELECT id, label, client, scopes, created_at, last_used_at, expires_at FROM extension_tokens
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, ${deps.db.dialect.seq()} DESC`,
    [userId, deps.now().toISOString()],
  );
  const items = rows.map((row): AutofillTokenItem => {
    const scopes = readScopes(row.scopes);
    return {
      id: row.id,
      label: row.label,
      ...clientOf(row.client),
      scopes,
      signIn: scopes.includes('credentials:read'),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
    };
  });
  return { items, total: items.length };
}

/** Deletes connect codes a day after they expired, used or not. Returns how many. */
export async function pruneConnectCodes(deps: Pick<AppDeps, 'db' | 'now'>): Promise<number> {
  const before = new Date(deps.now().getTime() - KEEP_EXPIRED_CODES_MS).toISOString();
  return (await deps.db.run('DELETE FROM extension_connect_codes WHERE expires_at <= ?', [before])).changes;
}
