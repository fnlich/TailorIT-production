import { randomBytes } from 'node:crypto';
import {
  claimsKnownName,
  knownClientDocument,
  knownClientName,
  OAUTH_UNVERIFIED_APP_NAME,
  recognizeOAuthClient,
  type OAuthClientKind,
  type OAuthRegistration,
} from '@tailorit/shared/oauth';
import type { AppDeps } from '../../core/context';
import { cimdClient, isCimdClientId } from './cimd';
import { OAuthError } from './errors';
import { redirectHostOf, redirectUriProblem, REDIRECT_URIS_MAX } from './redirects';

// v3.1 OAUTH: the AI apps that may ask for access (oauth_clients). Public clients only (OAuth 2.1 §2.1): no secret is
// issued or kept, as Claude and ChatGPT authenticate with PKCE and their registered redirect addresses. Two ways in:
// - Dynamic Client Registration (RFC 7591), POST /oauth/register: the client says its name and redirect addresses and
//   gets an id `dcr_...`. Claude registers once per connection, ChatGPT once per connector.
// - A Client ID Metadata Document: the client id is an https address whose JSON says the same (cimd.ts reads it).
// Either way the name is what the client says; who it is (recognized) comes from where it sends people back, or where
// its document lives (packages/shared/src/oauth recognizeOAuthClient), by exact address only (v31 FIX-AUTH, SEC-5).

/** A client as the authorization server uses it. */
export interface OAuthClient {
  id: string;
  registration: OAuthRegistration;
  /** The name to show (a known app's own name for a registered client it recognizes). */
  name: string;
  redirectUris: string[];
  recognized: OAuthClientKind;
  /** A metadata document's host; null for a registered client. */
  host: string | null;
}

/** The longest name kept. */
const NAME_MAX = 100;
/** The most grant types a client may list (TailorIT reads only the two it supports among them). */
const GRANT_TYPES_MAX = 20;

/** A name a client gave, as TailorIT shows it: no control or format characters, spaces folded, at most NAME_MAX. */
function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

/**
 * The name a client is shown by (v31 FIX-AUTH, SEC-5). A known app: its own name (Claude, ChatGPT), or what its
 * document at that app's exact address says (Claude Code). Any other app: its own words, or its redirect host; but
 * words that claim a known app, its maker or TailorIT ("Claude", "ChatGPT Plus") become OAUTH_UNVERIFIED_APP_NAME, so
 * the consent page never lends their names to a stranger's app (it shows the app as unverified, with its host).
 */
function shownName(recognized: OAuthClientKind, registration: OAuthRegistration, id: string, given: string, firstRedirect: string): string {
  const known = knownClientName(recognized);
  if (known) return registration === 'cimd' && knownClientDocument(id) && given ? given : known;
  const said = given || redirectHostOf(firstRedirect);
  return claimsKnownName(said) ? OAUTH_UNVERIFIED_APP_NAME : said;
}

export interface CheckedMetadata {
  name: string;
  redirectUris: string[];
  recognized: OAuthClientKind;
  /** What is kept beside the name and addresses: the client's own home page, when it gave an https one. */
  metadata: { client_uri?: string };
}

/**
 * A registration body or a metadata document, checked (RFC 7591 §2): its redirect addresses (1 to REDIRECT_URIS_MAX,
 * each https or http on this machine), the grant types and response types TailorIT supports, a name. `id` is the
 * client id it will have (a document's own address). Throws invalid_redirect_uri or invalid_client_metadata.
 */
export function checkClientMetadata(input: unknown, registration: OAuthRegistration, id: string): CheckedMetadata {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OAuthError('invalid_client_metadata', 'the client metadata must be a JSON object');
  }
  const body = input as Record<string, unknown>;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > REDIRECT_URIS_MAX) {
    throw new OAuthError('invalid_redirect_uri', `redirect_uris must list 1 to ${REDIRECT_URIS_MAX} addresses`);
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthError('invalid_redirect_uri', `a redirect address ${problem}`);
  }
  const redirectUris = [...new Set(uris as string[])];
  // v3.3.1: a client may list grant types TailorIT does not support (Claude's own document lists
  // urn:ietf:params:oauth:grant-type:jwt-bearer beside authorization_code and refresh_token); they are ignored, as RFC 7591
  // §2 lets a server do, and /oauth/token still answers unsupported_grant_type for any but the two it supports.
  if (body.grant_types !== undefined) {
    if (
      !Array.isArray(body.grant_types) ||
      body.grant_types.length > GRANT_TYPES_MAX ||
      !body.grant_types.every((type) => typeof type === 'string' && type.length > 0 && type.length <= 200)
    ) {
      throw new OAuthError('invalid_client_metadata', 'grant_types must be a list of grant type names');
    }
    if (!body.grant_types.includes('authorization_code')) {
      throw new OAuthError('invalid_client_metadata', 'grant_types must include authorization_code');
    }
  }
  if (body.response_types !== undefined) {
    if (!Array.isArray(body.response_types) || body.response_types.length === 0 || !body.response_types.every((type) => type === 'code')) {
      throw new OAuthError('invalid_client_metadata', 'response_types may hold code only');
    }
  }
  const recognized = recognizeOAuthClient({ id, registration, redirectUris });
  const name = shownName(recognized, registration, id, cleanName(body.client_name), redirectUris[0]!);
  const metadata: CheckedMetadata['metadata'] = {};
  if (typeof body.client_uri === 'string' && body.client_uri.length <= 500 && body.client_uri.startsWith('https://')) {
    metadata.client_uri = body.client_uri;
  }
  return { name, redirectUris, recognized, metadata };
}

/** RFC 7591's answer for a registered client. */
export interface RegistrationAnswer {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
}

/** POST /oauth/register: keeps a new public client and answers its id. */
export async function registerClient(deps: Pick<AppDeps, 'db' | 'now'>, body: unknown): Promise<RegistrationAnswer> {
  const id = `dcr_${randomBytes(24).toString('base64url')}`;
  const checked = checkClientMetadata(body, 'dcr', id);
  const now = deps.now();
  await deps.db.run(
    `INSERT INTO oauth_clients(id, kind, name, redirect_uris, recognized, metadata, created_at)
     VALUES (?, 'dcr', ?, ?, ?, ?, ?)`,
    [id, checked.name, JSON.stringify(checked.redirectUris), checked.recognized, JSON.stringify(checked.metadata), now.toISOString()],
  );
  return {
    client_id: id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: checked.name,
    redirect_uris: checked.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

interface ClientRow {
  id: string;
  kind: OAuthRegistration;
  name: string;
  redirect_uris: string;
  recognized: OAuthClientKind;
}

/**
 * A stored client row as an OAuthClient. v31 FIX-AUTH (SEC-5): who it is and its shown name are worked out again from
 * its id and redirect addresses by today's rules, so a row kept under an earlier, looser rule never shows as a known app.
 */
export function clientOfRow(row: ClientRow): OAuthClient {
  let uris: unknown = [];
  try {
    uris = JSON.parse(row.redirect_uris);
  } catch {
    uris = [];
  }
  const redirectUris = Array.isArray(uris) ? uris.filter((uri): uri is string => typeof uri === 'string') : [];
  const recognized = recognizeOAuthClient({ id: row.id, registration: row.kind, redirectUris });
  const name =
    recognized === row.recognized || row.name === '' || redirectUris.length === 0
      ? row.name
      : shownName(recognized, row.kind, row.id, row.name, redirectUris[0]!);
  return {
    id: row.id,
    registration: row.kind,
    name: recognized === 'other' && claimsKnownName(name) ? OAUTH_UNVERIFIED_APP_NAME : name,
    redirectUris,
    recognized,
    host: row.kind === 'cimd' ? new URL(row.id).host : null,
  };
}

/** A registered client by its id. */
export async function storedClient(deps: Pick<AppDeps, 'db'>, id: string): Promise<OAuthClient | null> {
  const row = await deps.db.one<ClientRow>('SELECT id, kind, name, redirect_uris, recognized FROM oauth_clients WHERE id = ?', [id]);
  return row ? clientOfRow(row) : null;
}

/**
 * The client a `client_id` names: a registered one (`dcr_...`), or the metadata document at its address (read, or
 * kept from a recent read; `caller`, the asking network address, pays for a read: cimd.ts). Throws invalid_client for
 * one TailorIT does not know or cannot read.
 */
export async function clientFor(deps: AppDeps, clientId: string, caller = 'unknown'): Promise<OAuthClient> {
  if (clientId.length === 0 || clientId.length > 2000) throw new OAuthError('invalid_client', 'unknown client_id');
  if (isCimdClientId(deps, clientId)) return cimdClient(deps, clientId, caller);
  const client = clientId.startsWith('dcr_') ? await storedClient(deps, clientId) : null;
  if (!client || client.registration !== 'dcr') throw new OAuthError('invalid_client', 'unknown client_id');
  return client;
}
