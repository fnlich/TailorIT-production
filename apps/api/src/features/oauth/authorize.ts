import { createHash, timingSafeEqual } from 'node:crypto';
import { MINUTE_MS } from '@tailorit/shared';
import { OAUTH_SCOPE_MCP, OAUTH_SCOPES, type OAuthPageError } from '@tailorit/shared/oauth';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { oauthAddresses, resourceOf } from './addresses';
import { clientFor, type OAuthClient } from './clients';
import { OAuthError, single } from './errors';
import { redirectMatches } from './redirects';
import { hashOAuthSecret, newOAuthSecret } from './tokens';

// v3.1 OAUTH: GET /oauth/authorize (OAuth 2.1 §4.1.1, the MCP authorization spec 2025-11-25). In order:
// 1. The client (clients.ts: registered, or its metadata document read now) and the redirect address, which must be
//    one it registered (exactly; on this machine any port). Until both are known nothing is sent to the address: the
//    browser goes to TailorIT's consent page with an error code instead (OAUTH_PAGE_ERRORS).
// 2. Then every other refusal goes back to the client, with its state and TailorIT's `iss` (RFC 9207): response_type
//    `code` only; PKCE with S256 only (code_challenge required); `resource` (RFC 8707) the MCP endpoint or its origin
//    (none: the MCP endpoint); the scopes TailorIT knows (others left out; `mcp` always in). Only to a client TailorIT
//    recognizes (Claude's, ChatGPT's addresses): anyone may register a client, so a refusal never sends the browser
//    on to an unknown client's address unasked (OAuth 2.1 §7.12.2, an open redirector); such a client's browser gets
//    TailorIT's page (invalid_request). After the consent page the person has seen where they go, and they go there.
// 3. The request is kept (oauth_requests, single use, OAUTH_REQUEST_MINUTES), bound to the browser (the SHA-256 of
//    its `ti_oauth` cookie), under the SHA-256 of a random id that only the consent page's address carries; the
//    browser goes to the consent page (/oauth/consent?request=<id>), which asks the person to sign in first.
// v34 ORIGIN (PLAN G7): every address here (the consent page, `iss`, the resource) is the request's public origin's
// (APP_ORIGIN, or a trusted test tunnel's: config/public-origin.ts); the request keeps its issuer and resource
// (oauth_requests.issuer, migration 0053), which the consent answers with and the code exchange holds the client to.

/** The browser binding cookie (httpOnly, SameSite=Lax): the consent must come from the browser that began. */
export const BROWSER_COOKIE = 'ti_oauth';
/** A cookie value or a request id: 32 random bytes in base64url. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The longest `state` kept and sent back. */
const STATE_MAX = 2000;
/** RFC 7636 §4.1: a verifier is 43 to 128 unreserved characters; an S256 challenge is 43 base64url characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** `uri` with `params` added to its query (the ones it has kept). */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  return url.href;
}

/** The scopes a grant gets: the ones TailorIT knows that the client asked for, `mcp` always among them. */
export function scopesOf(asked: string | undefined): string[] {
  const named = new Set((asked ?? '').split(' ').filter(Boolean));
  return OAUTH_SCOPES.filter((scope) => scope === OAUTH_SCOPE_MCP || named.has(scope));
}

/** Whether `verifier` answers the S256 `challenge` (RFC 7636 §4.6), compared in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** What /oauth/authorize answers: where to send the browser. */
export type AuthorizeOutcome =
  | { kind: 'consent'; location: string; requestId: string }
  | { kind: 'client_error'; location: string }
  | { kind: 'page_error'; location: string; error: OAuthPageError };

type Deps = AppDeps;

/**
 * Handles one authorization request. `query` is the request's query; `browserSecret` the browser's binding cookie (made
 * by the caller when it had none); `caller` the caller's network address (limits.ts addressOf), which a client
 * document's read counts against (v31 FIX-AUTH, SEC-6); `origin` the request's public origin (v34 ORIGIN:
 * config/public-origin.ts publicOriginOf), whose issuer and resource the stored request keeps for the consent and the
 * code exchange.
 */
export async function authorize(
  deps: Deps,
  query: Record<string, unknown>,
  browserSecret: string,
  caller = 'unknown',
  origin: string = deps.config.appOrigin,
): Promise<AuthorizeOutcome> {
  const addresses = oauthAddresses(deps.config, origin);
  const pageError = (error: OAuthPageError): AuthorizeOutcome => ({
    kind: 'page_error',
    error,
    location: withParams(addresses.consentPage, { error }),
  });

  // 1. The client and its redirect address.
  let clientId: string | undefined;
  let redirectUri: string | undefined;
  try {
    clientId = single(query.client_id, 'client_id');
    redirectUri = single(query.redirect_uri, 'redirect_uri');
  } catch {
    return pageError('invalid_request');
  }
  if (!clientId) return pageError('invalid_request');
  let client: OAuthClient;
  try {
    client = await clientFor(deps, clientId, caller);
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    if (error.error === 'temporarily_unavailable') return pageError('temporarily_unavailable');
    // v3.3.1: info, not debug, so the reason shows in the server's log when a connector cannot sign in (a fixed
    // technical phrase: never the client's address or anything a person typed).
    deps.log.info(`[oauth] an authorization request named a client TailorIT does not know (${error.message})`);
    return pageError('invalid_client');
  }
  // OAuth 2.1 §4.1.1: the address may be left out only when the client registered exactly one.
  const target = redirectUri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!target || !client.redirectUris.some((registered) => redirectMatches(registered, target))) return pageError('invalid_redirect');

  // 2. Every other refusal goes back to the client.
  let state: string | undefined;
  const back = (error: string, description: string): AuthorizeOutcome =>
    client.recognized === 'other'
      ? pageError('invalid_request')
      : {
          kind: 'client_error',
          location: withParams(target, { error, error_description: description, state, iss: addresses.issuer }),
        };
  try {
    state = single(query.state, 'state');
    if (state !== undefined && state.length > STATE_MAX) {
      state = undefined;
      return back('invalid_request', 'state is too long');
    }
    const responseType = single(query.response_type, 'response_type');
    if (responseType !== 'code') return back('unsupported_response_type', 'response_type must be code');
    const challenge = single(query.code_challenge, 'code_challenge');
    const method = single(query.code_challenge_method, 'code_challenge_method');
    if (!challenge) return back('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method S256');
    if (method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
    if (!CHALLENGE.test(challenge)) return back('invalid_request', 'code_challenge is not an S256 challenge');
    const resource = resourceOf(addresses, single(query.resource, 'resource'));
    if (resource === null) return back('invalid_target', 'resource must be this MCP server');
    const scopes = scopesOf(single(query.scope, 'scope'));

    // 3. The request, bound to this browser.
    const requestId = newOAuthSecret();
    const now = deps.now();
    // v34 ORIGIN (migration 0053): the issuer beside the resource, both of this request's public origin.
    await deps.db.run(
      `INSERT INTO oauth_requests(id_hash, client_id, redirect_uri, code_challenge, scopes, resource, issuer, state,
         browser_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hashOAuthSecret(requestId),
        client.id,
        target,
        challenge,
        JSON.stringify(scopes),
        resource,
        addresses.issuer,
        state ?? null,
        hashOAuthSecret(browserSecret),
        now.toISOString(),
        new Date(now.getTime() + constantsOf(deps).get('OAUTH_REQUEST_MINUTES') * MINUTE_MS).toISOString(),
      ],
    );
    deps.log.debug(`[oauth] an authorization request of a ${client.recognized} client waits for consent`);
    return { kind: 'consent', requestId, location: withParams(addresses.consentPage, { request: requestId }) };
  } catch (error) {
    if (error instanceof OAuthError) return back(error.error, error.message);
    throw error;
  }
}
