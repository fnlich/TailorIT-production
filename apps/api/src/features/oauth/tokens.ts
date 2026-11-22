import { createHash, randomBytes } from 'node:crypto';
import { MINUTE_MS, DAY_MS, type Role } from '@tailorit/shared';
import { OAUTH_ACCESS_TOKEN_PREFIX, OAUTH_REFRESH_TOKEN_PREFIX, OAUTH_SCOPE_MCP } from '@tailorit/shared/oauth';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps, SessionUser } from '../../core/context';
import type { DbQueries } from '../../core/db/types';

// v3.1 OAUTH (decision D7): the tokens a connected AI app holds. Opaque random secrets, like the personal `tim_`
// tokens: `tio_` access tokens (OAUTH_ACCESS_TOKEN_MINUTES, 1 hour) and `tir_` refresh tokens (OAUTH_REFRESH_IDLE_DAYS,
// 30 days, a new one at each use). Only their SHA-256 is stored (the input is 32 random bytes, not a password: a fast
// hash is right); the secrets are answered once, to the client's token request, and never logged. Each token belongs
// to a grant (one person's yes to one client) and names the resource it was issued for (`audience`, RFC 8707): the MCP
// endpoint accepts only its own.

/** 32 random bytes in base64url are 43 characters. */
const ACCESS = /^tio_[A-Za-z0-9_-]{43}$/;
const REFRESH = /^tir_[A-Za-z0-9_-]{43}$/;
/** A grant's `last_used_at` is written at most this often. */
const LAST_USED_EVERY_MS = MINUTE_MS;

export function hashOAuthSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A new random secret: `prefix` then 32 bytes in base64url. */
export function newOAuthSecret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export const isAccessToken = (value: string): boolean => ACCESS.test(value);
export const isRefreshToken = (value: string): boolean => REFRESH.test(value);

/** The token endpoint's answer (RFC 6749 §5.1). */
export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/**
 * Issues an access token and a refresh token for `grant` (inside the caller's transaction): `rotatedFrom` is the
 * refresh token's hash they replace, null for a code exchange.
 */
export async function issueTokens(
  deps: Deps,
  q: DbQueries,
  grant: { id: string; scopes: readonly string[]; audience: string },
  rotatedFrom: string | null,
): Promise<IssuedTokens> {
  const constants = constantsOf(deps);
  const now = deps.now();
  const accessSeconds = constants.get('OAUTH_ACCESS_TOKEN_MINUTES') * 60;
  const access = newOAuthSecret(OAUTH_ACCESS_TOKEN_PREFIX);
  const refresh = newOAuthSecret(OAUTH_REFRESH_TOKEN_PREFIX);
  const created = now.toISOString();
  await q.run(
    `INSERT INTO oauth_tokens(token_hash, kind, grant_id, audience, created_at, expires_at, rotated_from)
     VALUES (?, 'access', ?, ?, ?, ?, ?), (?, 'refresh', ?, ?, ?, ?, ?)`,
    [
      hashOAuthSecret(access),
      grant.id,
      grant.audience,
      created,
      new Date(now.getTime() + accessSeconds * 1000).toISOString(),
      rotatedFrom,
      hashOAuthSecret(refresh),
      grant.id,
      grant.audience,
      created,
      new Date(now.getTime() + constants.get('OAUTH_REFRESH_IDLE_DAYS') * DAY_MS).toISOString(),
      rotatedFrom,
    ],
  );
  return { access_token: access, token_type: 'Bearer', expires_in: accessSeconds, refresh_token: refresh, scope: grant.scopes.join(' ') };
}

/** Why a grant was revoked (oauth_grants.revoked_reason). */
export type RevokeReason = 'person' | 'client' | 'refresh_reused' | 'code_reused' | 'unused';

/** Revokes a grant and every token it issued; false when it was revoked already. */
export async function revokeGrant(deps: Pick<AppDeps, 'now'>, q: DbQueries, grantId: string, reason: RevokeReason): Promise<boolean> {
  const at = deps.now().toISOString();
  const { changes } = await q.run('UPDATE oauth_grants SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL', [
    at,
    reason,
    grantId,
  ]);
  await q.run('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', [at, grantId]);
  return changes > 0;
}

/** Who an access token acts for. */
export interface OAuthAccess {
  user: SessionUser;
  grantId: string;
  scopes: string[];
}

/**
 * The account behind an access token, or null when it is not one of ours, unknown, expired, revoked, issued for another
 * resource than `audience`, its grant revoked or its account disabled. Writes the grant's `last_used_at` at most once a
 * minute.
 */
export async function resolveOAuthAccessToken(deps: Pick<AppDeps, 'db' | 'now'>, token: string, audience: string): Promise<OAuthAccess | null> {
  const checked = await checkOAuthAccessToken(deps, token, audience);
  return checked.ok ? checked.access : null;
}

// v34 ORIGIN (PLAN G8)
/**
 * An access token checked: the account behind it, or why not, telling a token TailorIT issued (`known`: expired,
 * revoked, for another address, its grant or account ended) from one it never issued or that is no token at all. The
 * MCP endpoint counts only the latter toward its failed-token limit per address, so the people behind one shared
 * address (Claude's servers) whose tokens expire are never held back as if they were guessing.
 */
export type OAuthAccessCheck = { ok: true; access: OAuthAccess } | { ok: false; known: boolean };

export async function checkOAuthAccessToken(deps: Pick<AppDeps, 'db' | 'now'>, token: string, audience: string): Promise<OAuthAccessCheck> {
  const access = await readAccessToken(deps, token, audience);
  return access === 'unknown' ? { ok: false, known: false } : access === 'refused' ? { ok: false, known: true } : { ok: true, access };
}
// end v34 ORIGIN

async function readAccessToken(deps: Pick<AppDeps, 'db' | 'now'>, token: string, audience: string): Promise<OAuthAccess | 'unknown' | 'refused'> {
  if (!isAccessToken(token)) return 'unknown';
  const row = await deps.db.one<{
    kind: string;
    audience: string;
    expires_at: string;
    revoked_at: string | null;
    grant_id: string;
    scopes: string;
    grant_revoked: string | null;
    last_used_at: string | null;
    user_id: string;
    email: string;
    name: string;
    role: Role;
    disabled_at: string | null;
  }>(
    `SELECT t.kind, t.audience, t.expires_at, t.revoked_at, g.id AS grant_id, g.scopes, g.revoked_at AS grant_revoked,
            g.last_used_at, u.id AS user_id, u.email, u.name, u.role, u.disabled_at
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
      WHERE t.token_hash = ?`,
    [hashOAuthSecret(token)],
  );
  const now = deps.now();
  // A refresh token sent as an access token is no access token: unknown, like any string TailorIT never issued as one.
  if (!row || row.kind !== 'access') return 'unknown';
  if (row.revoked_at || row.grant_revoked || row.disabled_at) return 'refused';
  if (Date.parse(row.expires_at) <= now.getTime() || row.audience !== audience) return 'refused';
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    scopes = Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    scopes = [];
  }
  if (!scopes.includes(OAUTH_SCOPE_MCP)) return 'refused';
  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : Number.NaN;
  if (Number.isNaN(lastUsed) || now.getTime() - lastUsed >= LAST_USED_EVERY_MS) {
    await deps.db.run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', [now.toISOString(), row.grant_id]);
  }
  return { user: { id: row.user_id, email: row.email, name: row.name, role: row.role }, grantId: row.grant_id, scopes };
}
