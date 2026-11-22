import { randomUUID } from 'node:crypto';
import type { OAuthGrantItem, OAuthGrantList } from '@tailorit/shared/oauth';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types';
import { refuse } from '../../core/http/refuse';
import { clientOfRow } from './clients';
import { redirectHostOf } from './redirects';
import { revokeGrant } from './tokens';

// v3.1 OAUTH: grants, one person's yes to one AI app (oauth_grants). A second consent to the same app reuses its live
// grant (the unique index idx_oauth_grants_live), so the Integrations page lists each app once however often it
// reconnects; OAUTH_GRANTS_PER_ACCOUNT caps the apps. The person's list (GET /api/oauth/grants) shows the grants with a
// token that still works, and Disconnect (DELETE /api/oauth/grants/:id) ends every token of one at once.
// v31 FIX-AUTH (BEH-11): the cap counts what the list shows, the grants with a token that still works, and the ones
// whose code is still waiting to be exchanged (an Allow of the last OAUTH_CODE_SECONDS). An Allow the app never
// exchanged (a closed tab, an app error) ends with its code: it no longer counts, though the daily housekeeping revokes
// it only after OAUTH_RECORD_KEEP_DAYS.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** A token of the grant still works: an access token not expired, or a refresh token not spent nor expired. */
const HAS_LIVE_TOKEN = `EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.revoked_at IS NULL
  AND t.rotated_at IS NULL AND t.expires_at > ?)`;
/** v31 FIX-AUTH (BEH-11): an Allow's code of the grant still waits to be exchanged (unused, not expired). */
const HAS_WAITING_CODE = `EXISTS (SELECT 1 FROM oauth_requests r WHERE r.grant_id = g.id AND r.code_used_at IS NULL
  AND r.code_expires_at > ?)`;

/**
 * The person's live grant to `clientId`, its scopes and resource brought up to this consent, or a new one. Inside the
 * caller's transaction, after its lockPerson (the cap's check, then write). Refuses past OAUTH_GRANTS_PER_ACCOUNT.
 */
export async function grantFor(
  deps: Deps,
  t: DbTx,
  userId: string,
  clientId: string,
  scopes: readonly string[],
  resource: string,
): Promise<string> {
  const live = await t.one<{ id: string }>('SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL', [
    userId,
    clientId,
  ]);
  if (live) {
    await t.run('UPDATE oauth_grants SET scopes = ?, resource = ? WHERE id = ?', [JSON.stringify(scopes), resource, live.id]);
    // v34 ORIGIN (the ORIGIN security review, finding 1): a consent at another address of the MCP endpoint (another
    // tunnel, a changed MCP_PUBLIC_URL) moves the grant there; the tokens issued for the old address end now, so the
    // first connection really stops (exchange.ts also refuses a refresh token issued for another address).
    await t.run('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND audience <> ? AND revoked_at IS NULL', [
      deps.now().toISOString(),
      live.id,
      resource,
    ]);
    return live.id;
  }
  const max = constantsOf(deps).get('OAUTH_GRANTS_PER_ACCOUNT');
  const now = deps.now().toISOString();
  const count = await t.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM oauth_grants g
      WHERE g.user_id = ? AND g.revoked_at IS NULL AND (${HAS_LIVE_TOKEN} OR ${HAS_WAITING_CODE})`,
    [userId, now, now],
  );
  if ((count?.n ?? 0) >= max) throw refuse(deps, 'conflict', 'MSG_OAUTH_GRANTS_MAX', { max });
  const id = randomUUID();
  await t.run(
    'INSERT INTO oauth_grants(id, user_id, client_id, scopes, resource, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, clientId, JSON.stringify(scopes), resource, deps.now().toISOString()],
  );
  return id;
}

/** GET /api/oauth/grants: the person's connected AI apps, newest first. */
export async function listGrants(deps: Pick<AppDeps, 'db' | 'now'>, userId: string): Promise<OAuthGrantList> {
  const rows = await deps.db.all<{
    id: string;
    scopes: string;
    created_at: string;
    last_used_at: string | null;
    client_id: string;
    kind: 'dcr' | 'cimd';
    name: string;
    redirect_uris: string;
    recognized: OAuthGrantItem['clientKind'];
  }>(
    `SELECT g.id, g.scopes, g.created_at, g.last_used_at, c.id AS client_id, c.kind, c.name, c.redirect_uris, c.recognized
       FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
      WHERE g.user_id = ? AND g.revoked_at IS NULL AND ${HAS_LIVE_TOKEN}
      ORDER BY g.created_at DESC, g.id`,
    [userId, deps.now().toISOString()],
  );
  return {
    items: rows.map((row) => {
      const client = clientOfRow({ id: row.client_id, kind: row.kind, name: row.name, redirect_uris: row.redirect_uris, recognized: row.recognized });
      let scopes: unknown = [];
      try {
        scopes = JSON.parse(row.scopes);
      } catch {
        scopes = [];
      }
      return {
        id: row.id,
        clientName: client.name,
        clientKind: client.recognized,
        registration: client.registration,
        clientHost: client.host,
        redirectHost: client.redirectUris[0] ? redirectHostOf(client.redirectUris[0]) : '',
        scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [],
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      };
    }),
  };
}

/** DELETE /api/oauth/grants/:id: revokes one live grant of the person and all its tokens; false when there is none. */
export async function revokeGrantOf(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, grantId: string): Promise<boolean> {
  return deps.db.tx(
    async (t) => {
      const grant = await t.one<{ id: string }>('SELECT id FROM oauth_grants WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [
        grantId,
        userId,
      ]);
      if (!grant) return false;
      return revokeGrant(deps, t, grant.id, 'person');
    },
    { label: 'revokeOAuthGrant' },
  );
}
