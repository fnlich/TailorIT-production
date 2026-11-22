import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { oauthAddresses, resourceOf } from './addresses';
import { pkceMatches, SECRET_PATTERN } from './authorize';
import { OAuthError, single } from './errors';
import { hashOAuthSecret, isAccessToken, isRefreshToken, issueTokens, revokeGrant, type IssuedTokens } from './tokens';

// v3.1 OAUTH: POST /oauth/token (OAuth 2.1 §3.2, §4.1.3, §4.3) and POST /oauth/revoke (RFC 7009), for public clients
// (client_id in the body, no secret).
// - authorization_code: the code (used once: a second use revokes the grant it made, OAuth 2.1 §4.1.2), issued to this
//   client, not past OAUTH_CODE_SECONDS, the same redirect address when one is sent, the PKCE verifier of its S256
//   challenge, the same resource when one is sent. Answers an access and a refresh token.
// - refresh_token: rotated (OAuth 2.1 §4.3.1, decision D7): each use spends it and answers a new pair; a spent one used
//   again revokes the whole grant (someone else holds a copy). Only the client it was issued to may use it. A grant
//   issued for another resource (MCP_PUBLIC_URL changed) is refused, so the client asks the person again.
//   v31 FIX-AUTH (decision D13): a spent refresh token used again within OAUTH_REFRESH_REUSE_GRACE_SECONDS of its
//   rotation (a client that retries after a lost answer, two refreshes at the same moment) answers a new pair and
//   revokes the pair its first use made, so one chain lives on. Not when that pair's refresh token was used already
//   (its answer arrived, so the old token is a copy): that, and any reuse after the grace, revokes the grant as before.
// - revoke: an access token ends alone; a refresh token ends its grant. Always 200 (RFC 7009 §2.2).
// A refused code or refresh token is always invalid_grant (RFC 6749 §5.2), never which check failed.

type Deps = AppDeps;

const dead = () => new OAuthError('invalid_grant', 'the code or refresh token is not valid');

/** The parameters of a token request (urlencoded, or JSON), each given once. */
function param(body: Record<string, unknown>, name: string): string | undefined {
  return single(body[name], name);
}

function scopesOf(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}

/** The client a token request names: client_id in the body (a public client sends no secret). */
export function clientIdOf(body: Record<string, unknown>): string {
  const clientId = param(body, 'client_id');
  if (!clientId) throw new OAuthError('invalid_client', 'client_id is required');
  return clientId;
}

/**
 * grant_type=authorization_code. v34 ORIGIN: `origin` is the token request's public origin (config/public-origin.ts):
 * its issuer must be the one the authorization request was made at (oauth_requests.issuer), so a code from one
 * address is never exchanged at another, and a named resource must be the request's own.
 */
export async function exchangeCode(deps: Deps, body: Record<string, unknown>, origin: string = deps.config.appOrigin): Promise<IssuedTokens> {
  const clientId = clientIdOf(body);
  const code = param(body, 'code');
  const verifier = param(body, 'code_verifier');
  const redirectUri = param(body, 'redirect_uri');
  const resourceNamed = param(body, 'resource');
  if (!code || !SECRET_PATTERN.test(code)) throw dead();
  if (!verifier) throw new OAuthError('invalid_request', 'code_verifier is required (PKCE)');
  const codeHash = hashOAuthSecret(code);
  const row = await deps.db.one<{
    client_id: string;
    redirect_uri: string;
    resource: string;
    issuer: string | null;
    code_challenge: string;
    code_expires_at: string;
    code_used_at: string | null;
    grant_id: string;
    scopes: string;
    grant_resource: string;
    grant_revoked: string | null;
    disabled_at: string | null;
  }>(
    `SELECT r.client_id, r.redirect_uri, r.resource, r.issuer, r.code_challenge, r.code_expires_at, r.code_used_at,
            r.grant_id, g.scopes, g.resource AS grant_resource, g.revoked_at AS grant_revoked, u.disabled_at
       FROM oauth_requests r JOIN oauth_grants g ON g.id = r.grant_id JOIN users u ON u.id = g.user_id
      WHERE r.code_hash = ?`,
    [codeHash],
  );
  if (!row || row.client_id !== clientId) throw dead();
  if (row.code_used_at) {
    // A code used twice: whoever holds the copy, the grant it made ends (OAuth 2.1 §4.1.2).
    await deps.db.tx((t) => revokeGrant(deps, t, row.grant_id, 'code_reused'), { label: 'oauthCodeReused' });
    deps.log.info(`[oauth] a code was used twice: grant ${row.grant_id} revoked`);
    throw dead();
  }
  if (Date.parse(row.code_expires_at) <= deps.now().getTime() || row.grant_revoked || row.disabled_at) throw dead();
  if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw dead();
  // v34 ORIGIN: the code is exchanged at the address it was issued at (a request kept before 0053: APP_ORIGIN's).
  if ((row.issuer ?? oauthAddresses(deps.config).issuer) !== oauthAddresses(deps.config, origin).issuer) throw dead();
  // v34 ORIGIN (review, security 1): the grant moved to another address since this code's Allow (a later consent there).
  if (row.grant_resource !== row.resource) throw dead();
  if (resourceNamed !== undefined && resourceOf({ resource: row.resource }, resourceNamed) !== row.resource) {
    throw new OAuthError('invalid_target', 'resource is not the one this code was issued for');
  }
  if (!pkceMatches(verifier, row.code_challenge)) throw dead();
  const issued = await deps.db.tx(
    async (t) => {
      const claimed = await t.run('UPDATE oauth_requests SET code_used_at = ? WHERE code_hash = ? AND code_used_at IS NULL', [
        deps.now().toISOString(),
        codeHash,
      ]);
      if (claimed.changes === 0) return null;
      return issueTokens(deps, t, { id: row.grant_id, scopes: scopesOf(row.scopes), audience: row.resource }, null);
    },
    { label: 'oauthExchangeCode' },
  );
  if (!issued) {
    // Another request used it at the same moment.
    await deps.db.tx((t) => revokeGrant(deps, t, row.grant_id, 'code_reused'), { label: 'oauthCodeReused' });
    throw dead();
  }
  deps.log.debug(`[oauth] grant ${row.grant_id}: a code was exchanged`);
  return issued;
}

/**
 * grant_type=refresh_token. v34 ORIGIN: `origin` is the token request's public origin: a grant issued for the MCP
 * endpoint of another address (another tunnel, a changed MCP_PUBLIC_URL) is refused, so the client asks again. The
 * refresh token's own audience must be this address's resource and its grant's (a token from before the grant moved
 * is refused without ending the grant that moved), and the new pair keeps that audience (review, security 1).
 */
export async function refreshTokens(deps: Deps, body: Record<string, unknown>, origin: string = deps.config.appOrigin): Promise<IssuedTokens> {
  const clientId = clientIdOf(body);
  const token = param(body, 'refresh_token');
  const resourceNamed = param(body, 'resource');
  const scopeNamed = param(body, 'scope');
  if (!token || !isRefreshToken(token)) throw dead();
  const tokenHash = hashOAuthSecret(token);
  const row = await deps.db.one<{
    expires_at: string;
    rotated_at: string | null;
    revoked_at: string | null;
    audience: string;
    grant_id: string;
    client_id: string;
    scopes: string;
    resource: string;
    grant_revoked: string | null;
    disabled_at: string | null;
  }>(
    `SELECT t.expires_at, t.rotated_at, t.revoked_at, t.audience, g.id AS grant_id, g.client_id, g.scopes, g.resource,
            g.revoked_at AS grant_revoked, u.disabled_at
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
      WHERE t.token_hash = ? AND t.kind = 'refresh'`,
    [tokenHash],
  );
  if (!row || row.client_id !== clientId) throw dead();
  if (row.grant_revoked || row.disabled_at || Date.parse(row.expires_at) <= deps.now().getTime()) throw dead();
  const addresses = oauthAddresses(deps.config, origin); // v34 ORIGIN: this request's address
  // v34 ORIGIN (review, security 1): issued for another address than this request's, or than its grant's (the grant
  // moved since: grants.ts revoked it then). Refused before the reuse check below, so it never ends the grant.
  if (row.audience !== addresses.resource || row.audience !== row.resource) throw dead();
  if (row.revoked_at) {
    // v31 FIX-AUTH (D13): a refresh token ends alone only when a reuse within the grace replaced the pair it belongs
    // to. Used again, it is a copy beside the chain that lives on: the grant ends, as for any reuse.
    await deps.db.tx((t) => revokeGrant(deps, t, row.grant_id, 'refresh_reused'), { label: 'oauthRefreshReused' });
    deps.log.info(`[oauth] a replaced refresh token was used again: grant ${row.grant_id} revoked`);
    throw dead();
  }
  // Issued for another address of the MCP endpoint: the client must ask the person again.
  if (row.resource !== addresses.resource) throw dead();
  if (resourceNamed !== undefined && resourceOf(addresses, resourceNamed) !== row.resource) {
    throw new OAuthError('invalid_target', 'resource is not the one this grant is for');
  }
  const granted = scopesOf(row.scopes);
  let scopes = granted;
  if (scopeNamed !== undefined) {
    const asked = scopeNamed.split(' ').filter(Boolean);
    if (asked.some((scope) => !granted.includes(scope))) throw new OAuthError('invalid_scope', 'scope asks for more than was granted');
    scopes = granted.filter((scope) => asked.includes(scope));
  }
  const graceMs = constantsOf(deps).get('OAUTH_REFRESH_REUSE_GRACE_SECONDS') * 1000;
  const answer = await deps.db.tx(
    async (t): Promise<{ issued: IssuedTokens; graced: boolean } | null> => {
      // The token's row, locked: two refreshes of one token take turns, the second sees the first one's rotation.
      const current = await t.one<{ rotated_at: string | null; revoked_at: string | null }>(
        "SELECT rotated_at, revoked_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' FOR UPDATE",
        [tokenHash],
      );
      if (!current || current.revoked_at) return null;
      const now = deps.now();
      if (current.rotated_at === null) {
        await t.run('UPDATE oauth_tokens SET rotated_at = ? WHERE token_hash = ?', [now.toISOString(), tokenHash]);
        return { issued: await issueTokens(deps, t, { id: row.grant_id, scopes, audience: row.audience }, tokenHash), graced: false };
      }
      // D13: spent within the grace, and the pair its first use made not used to refresh since: that pair ends, a new
      // one answers.
      if (graceMs === 0 || now.getTime() - Date.parse(current.rotated_at) > graceMs) return null;
      const successorUsed = await t.one<{ used: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM oauth_tokens WHERE rotated_from = ? AND kind = 'refresh' AND rotated_at IS NOT NULL) AS used",
        [tokenHash],
      );
      if (successorUsed?.used) return null;
      await t.run('UPDATE oauth_tokens SET revoked_at = ? WHERE rotated_from = ? AND revoked_at IS NULL', [now.toISOString(), tokenHash]);
      return { issued: await issueTokens(deps, t, { id: row.grant_id, scopes, audience: row.audience }, tokenHash), graced: true };
    },
    { label: 'oauthRefresh' },
  );
  if (!answer) {
    // A spent refresh token used again (after the grace, or after its successor was used): someone holds a copy.
    await deps.db.tx((t) => revokeGrant(deps, t, row.grant_id, 'refresh_reused'), { label: 'oauthRefreshReused' });
    deps.log.info(`[oauth] a spent refresh token was used again: grant ${row.grant_id} revoked`);
    throw dead();
  }
  const issued = answer.issued;
  if (answer.graced) deps.log.info(`[oauth] grant ${row.grant_id}: a spent refresh token was used again within the grace: new pair`);
  deps.log.debug(`[oauth] grant ${row.grant_id}: tokens refreshed`);
  return issued;
}

/** POST /oauth/revoke: ends the token when it is ours (and the client's, when it names itself). */
export async function revokeToken(deps: Deps, body: Record<string, unknown>): Promise<void> {
  const token = param(body, 'token');
  const clientId = param(body, 'client_id');
  if (!token) throw new OAuthError('invalid_request', 'token is required');
  if (!isAccessToken(token) && !isRefreshToken(token)) return;
  const row = await deps.db.one<{ kind: 'access' | 'refresh'; grant_id: string; client_id: string }>(
    `SELECT t.kind, t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?`,
    [hashOAuthSecret(token)],
  );
  if (!row || (clientId !== undefined && clientId !== row.client_id)) return;
  if (row.kind === 'access') {
    await deps.db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [
      deps.now().toISOString(),
      hashOAuthSecret(token),
    ]);
    return;
  }
  await deps.db.tx((t) => revokeGrant(deps, t, row.grant_id, 'client'), { label: 'oauthRevoke' });
  deps.log.debug(`[oauth] grant ${row.grant_id}: revoked by its client`);
}
