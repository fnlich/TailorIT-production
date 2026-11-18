import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  MCP_SCOPES,
  MCP_TOKEN_PREFIX,
  readMcpScopes,
  type McpScope,
  type McpTokenCreated,
  type McpTokenItem,
  type McpTokenList,
} from '@tailorit/shared/mcp';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps, SessionUser } from '../../core/context';
import type { Role } from '@tailorit/shared';
import { refuse } from '../../core/http/refuse';
import { OAUTH_ACCESS_TOKEN_PREFIX } from '@tailorit/shared/oauth'; // v31 OAUTH
import { oauthAddresses } from '../oauth/addresses'; // v31 OAUTH
import { resolveOAuthAccessToken } from '../oauth/tokens'; // v31 OAUTH

// Personal MCP tokens (v1.5 M, migration 0816): `tim_` and 32 random bytes in base64url, made in Settings and given to
// the person's own AI client. Only the SHA-256 is stored (the input is random, not a password: a fast hash is right);
// the secret is answered once, to the Settings page that made it. A token works until it is revoked or its account is
// disabled; it never reaches any /api route (the MCP endpoint reads it itself, features/mcp/endpoint.ts), and an
// extension token (tia_) or a session cookie never reaches the MCP endpoint.

/** 32 random bytes in base64url are 43 characters. v31 OAUTH: or an OAuth access token (`tio_`, features/oauth). */
const TOKEN = /^ti[mo]_[A-Za-z0-9_-]{43}$/;
/** An Authorization header's bearer, and whatever follows it. */
const BEARER = /^Bearer[ \t]+(\S+)(.*)$/i;
/** `last_used_at` is written at most this often per token. */
const LAST_USED_EVERY_MS = 60_000;

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The bearer an MCP request presents (a personal `tim_` token or an OAuth `tio_` one): null when there is none, or it
 *  is not shaped like one of ours. */
export function presentedMcpToken(authorization: string | undefined): string | null {
  const match = BEARER.exec(authorization ?? '');
  if (!match || match[2]!.trim() !== '' || !TOKEN.test(match[1]!)) return null;
  return match[1]!;
}

function readScopes(json: string): McpScope[] {
  try {
    const value: unknown = JSON.parse(json);
    // v2.0: a v1.5 token's stored `prepare` reads as `prepare` (readMcpScopes, A3).
    return readMcpScopes(value);
  } catch {
    return [];
  }
}

interface TokenRow {
  id: string;
  name: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
}

const itemOf = (row: TokenRow): McpTokenItem => ({
  id: row.id,
  name: row.name,
  scopes: readScopes(row.scopes),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/** The account's live tokens, newest first, and the endpoint the API answers MCP on (MCP_PUBLIC_URL, else API_HOST and
 *  API_PORT: config/addresses.ts), which Settings puts in its setup snippets. */
export async function listMcpTokens(deps: Pick<AppDeps, 'db' | 'config'>, userId: string): Promise<McpTokenList> {
  const rows = await deps.db.all<TokenRow>(
    `SELECT id, name, scopes, created_at, last_used_at FROM mcp_tokens
      WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id`,
    [userId],
  );
  return { items: rows.map(itemOf), endpoint: deps.config.mcp.endpoint };
}

/**
 * Makes a token for `userId` (409 past MCP_TOKENS_PER_ACCOUNT live ones, the constant read now); its secret is in the
 * answer and nowhere else. v3.0 D2: the count and the insert run in one transaction behind the person's lock, so two
 * creates at once never pass the cap.
 */
export async function createMcpToken(
  deps: Pick<AppDeps, 'db' | 'now' | 'config' | 'log' | 'services'>,
  userId: string,
  name: string,
): Promise<McpTokenCreated> {
  const max = constantsOf(deps).get('MCP_TOKENS_PER_ACCOUNT');
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const row: TokenRow = {
    id: randomUUID(),
    name,
    scopes: JSON.stringify(MCP_SCOPES),
    created_at: deps.now().toISOString(),
    last_used_at: null,
  };
  await deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      const live = await t.one<{ n: number }>('SELECT count(*) AS n FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL', [userId]);
      // v2.0 P5: the constant MCP_TOKENS_PER_ACCOUNT (10 by default); v2.0 FIX-C (REQ-3): its refusal MSG_MCP_TOKENS_MAX.
      if ((live?.n ?? 0) >= max) throw refuse(deps, 'conflict', 'MSG_MCP_TOKENS_MAX', { max });
      await t.run('INSERT INTO mcp_tokens(id, user_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        row.id,
        userId,
        row.name,
        hashMcpToken(token),
        row.scopes,
        row.created_at,
      ]);
    },
    { label: 'createMcpToken' },
  );
  return { ...itemOf(row), token };
}

/** Revokes one live token of the account; false when it has none with that id. */
export async function revokeMcpToken(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, tokenId: string): Promise<boolean> {
  const result = await deps.db.run('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [
    deps.now().toISOString(),
    tokenId,
    userId,
  ]);
  return result.changes > 0;
}

/** Who an MCP token acts for. */
export interface McpCaller {
  user: SessionUser;
  /**
   * The credential's key: a personal token's id, or (v31 OAUTH) `oauth:<grant id>` for an OAuth access token, so a
   * connected app's rate limits and reports follow its grant across token refreshes (credentialColumns).
   */
  tokenId: string;
  scopes: McpScope[];
  // v31 OAUTH
  /** How it authenticated: a personal token (Settings) or an OAuth access token (Claude, ChatGPT). */
  via: 'personal' | 'oauth';
  // end v31 OAUTH
}

// v31 OAUTH
/** The prefix of an OAuth caller's tokenId. */
const OAUTH_KEY = 'oauth:';

/** The resource OAuth tokens must be issued for: the MCP endpoint (features/oauth/addresses.ts). */
const oauthResource = (config: AppDeps['config']) => oauthAddresses(config).resource;

/** A caller's tokenId as the columns that name it (mcp_unsupported_reports.token_id or .grant_id). */
export function credentialColumns(tokenId: string | null): { tokenId: string | null; grantId: string | null } {
  if (tokenId?.startsWith(OAUTH_KEY)) return { tokenId: null, grantId: tokenId.slice(OAUTH_KEY.length) };
  return { tokenId, grantId: null };
}
// end v31 OAUTH

/**
 * The account behind a token, or null when it is unknown or revoked, or its account is disabled (so a disable takes
 * effect on the next request). Writes `last_used_at` at most once a minute.
 */
export async function resolveMcpToken(deps: Pick<AppDeps, 'db' | 'now' | 'config'>, token: string): Promise<McpCaller | null> {
  // v31 OAUTH: an OAuth access token, issued for this MCP endpoint (its audience) and its grant's scope `mcp`, acts
  // for the grant's account with the personal token's one scope.
  if (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const access = await resolveOAuthAccessToken(deps, token, oauthResource(deps.config));
    return access ? { user: access.user, tokenId: `${OAUTH_KEY}${access.grantId}`, scopes: ['prepare'], via: 'oauth' } : null;
  }
  // end v31 OAUTH
  const row = await deps.db.one<{
    id: string;
    user_id: string;
    scopes: string;
    last_used_at: string | null;
    revoked_at: string | null;
    email: string;
    name: string;
    role: Role;
    disabled_at: string | null;
  }>(
    `SELECT t.id, t.user_id, t.scopes, t.last_used_at, t.revoked_at, u.email, u.name, u.role, u.disabled_at
       FROM mcp_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    [hashMcpToken(token)],
  );
  if (!row || row.revoked_at || row.disabled_at) return null;
  const now = deps.now();
  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : Number.NaN;
  if (Number.isNaN(lastUsed) || now.getTime() - lastUsed >= LAST_USED_EVERY_MS) {
    await deps.db.run('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?', [now.toISOString(), row.id]);
  }
  return {
    user: { id: row.user_id, email: row.email, name: row.name, role: row.role },
    tokenId: row.id,
    scopes: readScopes(row.scopes),
    via: 'personal',
  };
}
