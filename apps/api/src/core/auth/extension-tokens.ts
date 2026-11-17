import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Role } from '@tailorit/shared';
import {
  AUTOFILL_API_HEADER,
  AUTOFILL_API_VERSION,
  EXTENSION_SCOPES,
  type ExtensionClient,
  type ExtensionScope,
} from '@tailorit/shared/autofill';
import { constantsOf } from '../constants/service';
import type { AppDeps, SessionUser } from '../context';
import { AppError, conflict, forbidden } from '../http/errors';
import { refuse } from '../http/refuse';
import { DAY_MS } from '@tailorit/shared';

// The TailorIT Autofill extension's credential (work package AF). The extension's service worker exchanges a one-time
// connect code (features/autofill) for a token, `tia_` and 32 random bytes in base64url, and sends it as
// `Authorization: Bearer`. As for sessions, the database keeps only its SHA-256: the input is random, not a password,
// so a fast hash is right. A token expires at a fixed time (AUTOFILL_TOKEN_TTL_DAYS) and is never extended; signing
// out of the web app leaves it alone (it is a separate device credential).
//
// A request that presents a tia_ bearer belongs to the token alone (attachBearer): its cookie is never read, even
// when the token is bad, the Origin check does not apply (no page can make a browser attach the header), and it
// reaches only the routes tokenScope lists. Any other Authorization header (a proxy's Basic auth, another system's
// bearer) is not ours, and the cookie works as usual. This module sits in core, beside session.ts, because the
// middleware is global.

export const EXTENSION_TOKEN_PREFIX = 'tia_';
/** The code exchange reads no cookie, so originCheck lets it through when its Origin is absent or
 *  chrome-extension://… (core/http/middleware.ts). */
export const CONNECT_REDEEM_PATH = '/api/autofill/connect/redeem';
/** What a token that no longer works gets (401 `not_signed_in`); the extension then shows itself disconnected. */
export const EXTENSION_DISCONNECTED =
  'This browser is no longer connected to TailorIT. Connect the extension again from Settings › Autofill.';

/** Why a token was revoked: from Settings, from the extension's Disconnect, or by an administrator's disable. */
export type RevokeReason = 'user' | 'extension' | 'account_disabled';

/** 32 random bytes in base64url are 43 characters. */
const TOKEN = /^tia_[A-Za-z0-9_-]{43}$/;
/** An Authorization header's bearer, and whatever follows it. */
const BEARER = /^Bearer[ \t]+(\S+)(.*)$/i;
/** `last_used_at` is written at most this often per token, so ordinary reads do not all become writes. */
const LAST_USED_EVERY_MS = 60_000;

/** The SHA-256 of a token or of a normalized connect code: all the database keeps of either. */
export function hashExtensionSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** AUTOFILL_TOKEN_TTL_DAYS in milliseconds. */
export function extensionTokenTtlMs(deps: Pick<AppDeps, 'config'>): number {
  return deps.config.autofill.tokenTtlDays * DAY_MS;
}

export type PresentedToken = { kind: 'none' } | { kind: 'malformed' } | { kind: 'token'; token: string };

/**
 * The TailorIT bearer a request presents. 'none': no Authorization header, another scheme, or another system's bearer
 * (not ours: the cookie still works). 'malformed': a bearer that starts with tia_ but is not one of ours.
 */
export function readExtensionToken(req: Request): PresentedToken {
  const match = BEARER.exec(req.get('authorization') ?? '');
  if (!match || !match[1]!.startsWith(EXTENSION_TOKEN_PREFIX)) return { kind: 'none' };
  if (!TOKEN.test(match[1]!) || match[2]!.trim() !== '') return { kind: 'malformed' };
  return { kind: 'token', token: match[1]! };
}

/** Stored scopes (a JSON array) as the scopes this server knows, in EXTENSION_SCOPES order. */
export function readScopes(json: string): ExtensionScope[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? EXTENSION_SCOPES.filter((scope) => value.includes(scope)) : [];
  } catch {
    return [];
  }
}

/** The SQL of liveExtensionTokenCount. */
export const LIVE_TOKEN_COUNT_SQL =
  'SELECT count(*) AS n FROM extension_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?';
/** The SQL of extensionTokenLive. */
export const TOKEN_LIVE_SQL = 'SELECT 1 AS one FROM extension_tokens WHERE id = ? AND revoked_at IS NULL AND expires_at > ?';

/** How many tokens of an account still work (neither revoked nor expired). */
export async function liveExtensionTokenCount(deps: Pick<AppDeps, 'db' | 'now'>, userId: string): Promise<number> {
  return (await deps.db.one<{ n: number }>(LIVE_TOKEN_COUNT_SQL, [userId, deps.now().toISOString()]))!.n;
}

/** Whether a token still works: it is there, neither revoked nor expired (its account's state aside). */
export async function extensionTokenLive(deps: Pick<AppDeps, 'db' | 'now'>, tokenId: string): Promise<boolean> {
  return (await deps.db.one(TOKEN_LIVE_SQL, [tokenId, deps.now().toISOString()])) !== undefined;
}

/**
 * Refuses (409) one more connection to an account that already has EXTENSION_TOKENS_PER_ACCOUNT live (not revoked, not
 * expired) tokens, in MSG_EXTENSION_TOKENS_MAX's words (v30 INT-0: both constants, an admin may change them). A "check,
 * then write": call it inside the tx that creates the token, after `lockPerson(userId)`.
 */
export async function assertRoomForExtensionToken(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  userId: string,
): Promise<void> {
  const max = constantsOf(deps).get('EXTENSION_TOKENS_PER_ACCOUNT');
  if ((await liveExtensionTokenCount(deps, userId)) >= max) throw refuse(deps, 'conflict', 'MSG_EXTENSION_TOKENS_MAX', { max });
}

export interface CreatedExtensionToken {
  /** The raw token: answered once, to the extension's worker, and stored nowhere. */
  token: string;
  id: string;
  expiresAt: string;
}

export interface NewExtensionToken {
  label: string;
  scopes: readonly ExtensionScope[];
  client: ExtensionClient;
  userAgent: string | null;
}

/** The SQL of createExtensionToken. */
export const INSERT_TOKEN_SQL = `INSERT INTO extension_tokens(id, user_id, token_hash, label, scopes, client, user_agent,
  created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** A new token's secret, id, expiry and the row's values (createExtensionToken and its twin). */
export function newExtensionTokenRow(
  deps: Pick<AppDeps, 'now' | 'config'>,
  userId: string,
  input: NewExtensionToken,
): { created: CreatedExtensionToken; values: Array<string | null> } {
  const token = `${EXTENSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + extensionTokenTtlMs(deps)).toISOString();
  const values = [
    id,
    userId,
    hashExtensionSecret(token),
    input.label,
    JSON.stringify(input.scopes),
    JSON.stringify(input.client),
    input.userAgent?.slice(0, 500) ?? null,
    now.toISOString(),
    expiresAt,
  ];
  return { created: { token, id, expiresAt }, values };
}

/** Stores a new token for `userId` with exactly `scopes`. The expiry is fixed here and never extended. */
export async function createExtensionToken(
  deps: Pick<AppDeps, 'db' | 'now' | 'config'>,
  userId: string,
  input: NewExtensionToken,
): Promise<CreatedExtensionToken> {
  const { created, values } = newExtensionTokenRow(deps, userId, input);
  await deps.db.run(INSERT_TOKEN_SQL, values);
  return created;
}

interface TokenRow {
  id: string;
  user_id: string;
  scopes: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  email: string;
  name: string;
  role: Role;
  disabled_at: string | null;
}

/**
 * The account and scopes behind a token, or null when it is unknown, revoked or expired, or its account is disabled
 * (so disabling takes effect on the next request). A token that ended keeps its row until the prune.
 */
export async function resolveExtensionToken(
  deps: Pick<AppDeps, 'db' | 'now'>,
  token: string,
): Promise<{ user: SessionUser; tokenId: string; scopes: ExtensionScope[] } | null> {
  const row = await deps.db.one<TokenRow>(
    `SELECT t.id, t.user_id, t.scopes, t.expires_at, t.last_used_at, t.revoked_at, u.email, u.name, u.role,
       u.disabled_at
     FROM extension_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    [hashExtensionSecret(token)],
  );
  if (!row || row.revoked_at || row.disabled_at) return null;

  const now = deps.now();
  if (Date.parse(row.expires_at) <= now.getTime()) return null;
  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : Number.NaN;
  if (Number.isNaN(lastUsed) || now.getTime() - lastUsed >= LAST_USED_EVERY_MS) {
    await deps.db.run('UPDATE extension_tokens SET last_used_at = ? WHERE id = ?', [now.toISOString(), row.id]);
  }
  return {
    user: { id: row.user_id, email: row.email, name: row.name, role: row.role },
    tokenId: row.id,
    scopes: readScopes(row.scopes),
  };
}

/** The SQL of revokeExtensionToken: now, reason, token id, user id, now. */
export const REVOKE_TOKEN_SQL = `UPDATE extension_tokens SET revoked_at = ?, revoked_reason = ?
  WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`;

/** Revokes one live token of `userId`. False when the account has no live token with that id. */
export async function revokeExtensionToken(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  tokenId: string,
  reason: RevokeReason,
): Promise<boolean> {
  const now = deps.now().toISOString();
  return (await deps.db.run(REVOKE_TOKEN_SQL, [now, reason, tokenId, userId, now])).changes > 0;
}

/** Revokes every live token of an account (an administrator disabled it). Returns how many there were. */
export async function revokeExtensionTokensForUser(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  reason: RevokeReason,
): Promise<number> {
  const now = deps.now().toISOString();
  const { changes } = await deps.db.run(
    `UPDATE extension_tokens SET revoked_at = ?, revoked_reason = ?
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    [now, reason, userId, now],
  );
  return changes;
}

/**
 * Expires every live connect code of an account (an administrator disabled it), so none minted before the disable
 * becomes a token once the account is enabled again. The prune drops the rows a day later. Returns how many.
 */
export async function expireConnectCodesForUser(deps: Pick<AppDeps, 'db' | 'now'>, userId: string): Promise<number> {
  const now = deps.now().toISOString();
  const { changes } = await deps.db.run(
    `UPDATE extension_connect_codes SET expires_at = ?
     WHERE user_id = ? AND used_at IS NULL AND expires_at > ?`,
    [now, userId, now],
  );
  return changes;
}

/** Deletes the tokens revoked or expired more than EXTENSION_TOKEN_KEEP_DAYS (30) ago. Returns how many. */
export async function pruneExtensionTokens(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): Promise<number> {
  const before = new Date(deps.now().getTime() - constantsOf(deps).get('EXTENSION_TOKEN_KEEP_DAYS') * DAY_MS).toISOString();
  return (await deps.db.run('DELETE FROM extension_tokens WHERE revoked_at <= ? OR expires_at <= ?', [before, before])).changes;
}

/**
 * Identifies a request that presents a tia_ bearer; runs before originCheck and attachUser. Such a request is the
 * token's alone: `authVia` becomes 'token' at once, so attachUser never reads its cookie, and a token that does not
 * work is refused here (401) instead of falling back to the cookie. Other requests pass untouched.
 */
export function attachBearer(deps: AppDeps): RequestHandler {
  return async (req, res, next) => {
    const presented = readExtensionToken(req);
    if (presented.kind === 'none') return next();
    // Every answer to a request that presents a tia_ bearer names this server's version, refusals included: the
    // extension decides that versions differ only from this header, never from a status.
    res.setHeader(AUTOFILL_API_HEADER, String(AUTOFILL_API_VERSION));
    // From here the request is the token's or nobody's: attachUser leaves the cookie alone, even when this fails.
    req.authVia = 'token';
    let resolved: Awaited<ReturnType<typeof resolveExtensionToken>> = null;
    try {
      resolved = presented.kind === 'token' ? await resolveExtensionToken(deps, presented.token) : null;
    } catch (error) {
      deps.log.error('[auth] could not read an extension token', error); // the error only, never the token
      return next(new AppError('internal', 'Something went wrong on our side. Please try again.'));
    }
    if (!resolved) return next(new AppError('not_signed_in', EXTENSION_DISCONNECTED));
    req.user = resolved.user;
    req.extensionToken = { id: resolved.tokenId, scopes: resolved.scopes };
    next();
  };
}

/**
 * The only routes an extension token reaches. Anchored and case-sensitive on purpose: Express matches routes
 * case-insensitively, so a path this list refuses can never route somewhere it did not mean. Lower-case letters,
 * digits, '-' and '/' only: no dot segments, no percent-encoding.
 */
const TOKEN_ROUTES: ReadonlyArray<{ methods: ReadonlySet<string>; path: RegExp }> = [
  { methods: new Set(['GET', 'POST', 'PUT', 'DELETE']), path: /^\/api\/autofill\/[a-z0-9/-]+$/ },
  { methods: new Set(['GET', 'DELETE']), path: /^\/api\/ai\/tasks\/[0-9a-f-]{36}$/ },
  // v5 (Jobright parity, Phase 2): a task's streamed view, read only.
  { methods: new Set(['GET']), path: /^\/api\/ai\/tasks\/[0-9a-f-]{36}\/stream$/ },
];

/** The 409's sentence. The request's own header is repeated only when it is a plain number. */
function versionMessage(req: Request): string {
  const sent = req.get(AUTOFILL_API_HEADER)?.trim() ?? '';
  const speaks = /^\d{1,4}$/.test(sent) ? `speaks autofill API ${sent}` : 'does not say which autofill API it speaks';
  return (
    `This TailorIT extension ${speaks}; this server speaks ${AUTOFILL_API_VERSION}. ` +
    'Update the extension or TailorIT.'
  );
}

/**
 * After attachUser: a token request reaches only TOKEN_ROUTES (403 elsewhere), and only with the version this server
 * speaks in its X-TailorIT-Autofill-Api header (409 `conflict` when it is missing or names another), so AI-task
 * polling is covered too. Session and anonymous requests pass untouched.
 */
export const tokenScope: RequestHandler = (req, _res, next) => {
  if (req.authVia !== 'token') return next();
  const ok = !req.path.includes('//') && TOKEN_ROUTES.some((r) => r.methods.has(req.method) && r.path.test(req.path));
  if (!ok) return next(forbidden('The TailorIT extension cannot use that part of TailorIT.'));
  if (req.get(AUTOFILL_API_HEADER) !== String(AUTOFILL_API_VERSION)) return next(conflict(versionMessage(req)));
  next();
};
