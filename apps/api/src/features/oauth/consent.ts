import { isLoopbackAddress, type OAuthConsentAnswer, type OAuthConsentBody, type OAuthRequestView } from '@tailorit/shared/oauth';
import { assertFeature } from '../../core/accounts/entitlements';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { refuse } from '../../core/http/refuse';
import { oauthAddresses } from './addresses';
import { withParams } from './authorize';
import { storedClient } from './clients';
import { grantFor } from './grants';
import { redirectHostOf } from './redirects';
import { hashOAuthSecret, newOAuthSecret } from './tokens';

// v3.1 OAUTH: the consent page's two calls, for the signed-in person in the browser that began the request (its
// `ti_oauth` cookie's hash must be the request's). A request that is unknown, ended (OAUTH_REQUEST_MINUTES), answered
// already or begun in another browser is one refusal, MSG_OAUTH_REQUEST_GONE (404), so a stranger with a request's
// address learns nothing and can answer nothing.
// - GET  /api/oauth/requests/:id: the client's name, its document's host, where the browser goes next, a program on
//   this computer or not, the scopes.
// - POST /api/oauth/consent {request, decision}: Allow (the account's plan must include MCP, FREE_MCP / PAID_MCP) keeps
//   the grant (grants.ts) and a one-time code (OAUTH_CODE_SECONDS) and answers the redirect address with the code,
//   the client's state and `iss`; Cancel answers it with error=access_denied. Either way the request is used up.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

interface RequestRow {
  client_id: string;
  redirect_uri: string;
  scopes: string;
  resource: string;
  state: string | null;
  expires_at: string;
}

const gone = (deps: Deps) => refuse(deps, 'not_found', 'MSG_OAUTH_REQUEST_GONE');

function scopesOfRow(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}

/** GET /api/oauth/requests/:id. */
export async function requestView(deps: Deps, requestId: string, browserSecret: string | null): Promise<OAuthRequestView> {
  if (!browserSecret) throw gone(deps);
  const row = await deps.db.one<RequestRow>(
    `SELECT client_id, redirect_uri, scopes, resource, state, expires_at FROM oauth_requests
      WHERE id_hash = ? AND browser_hash = ? AND decided_at IS NULL AND expires_at > ?`,
    [hashOAuthSecret(requestId), hashOAuthSecret(browserSecret), deps.now().toISOString()],
  );
  const client = row ? await storedClient(deps, row.client_id) : null;
  if (!row || !client) throw gone(deps);
  return {
    client: { name: client.name, kind: client.recognized, registration: client.registration, host: client.host },
    redirectHost: redirectHostOf(row.redirect_uri),
    loopback: isLoopbackAddress(row.redirect_uri),
    scopes: scopesOfRow(row.scopes),
    expiresAt: row.expires_at,
  };
}

/** POST /api/oauth/consent. */
export async function decide(deps: Deps, userId: string, body: OAuthConsentBody, browserSecret: string | null): Promise<OAuthConsentAnswer> {
  if (!browserSecret) throw gone(deps);
  const issuer = oauthAddresses(deps.config).issuer;
  if (body.decision === 'allow') {
    // The plan's MCP access first: a refusal leaves the request open (the person may still Cancel).
    await assertFeature(deps, userId, 'mcp');
  }
  const code = newOAuthSecret();
  const answer = await deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      const now = deps.now();
      const row = await t.one<RequestRow>(
        `UPDATE oauth_requests SET decided_at = ?, decision = ?, user_id = ?
          WHERE id_hash = ? AND browser_hash = ? AND decided_at IS NULL AND expires_at > ?
          RETURNING client_id, redirect_uri, scopes, resource, state, expires_at`,
        [now.toISOString(), body.decision, userId, hashOAuthSecret(body.request), hashOAuthSecret(browserSecret), now.toISOString()],
      );
      if (!row) throw gone(deps);
      const state = row.state ?? undefined;
      if (body.decision === 'deny') {
        return withParams(row.redirect_uri, { error: 'access_denied', error_description: 'the person cancelled', state, iss: issuer });
      }
      const grantId = await grantFor(deps, t, userId, row.client_id, scopesOfRow(row.scopes), row.resource);
      const codeSeconds = constantsOf(deps).get('OAUTH_CODE_SECONDS');
      await t.run('UPDATE oauth_requests SET grant_id = ?, code_hash = ?, code_expires_at = ? WHERE id_hash = ?', [
        grantId,
        hashOAuthSecret(code),
        new Date(now.getTime() + codeSeconds * 1000).toISOString(),
        hashOAuthSecret(body.request),
      ]);
      return withParams(row.redirect_uri, { code, state, iss: issuer });
    },
    { label: 'oauthConsent' },
  );
  deps.log.info(`[oauth] account ${userId} answered a connection request (${body.decision})`);
  return { redirectTo: answer };
}
