#!/usr/bin/env node
// v34 DIRKIT (PLAN G8): checks a deployed TailorIT against what Claude's Connectors Directory asks of a remote MCP
// server, before the operator submits it (docs/directory/CHECKLIST.md). Read only: it sends what Claude would send and
// changes nothing on the server, except that the authorization request it starts waits there until it expires
// (OAUTH_REQUEST_MINUTES), unanswered.
//
//   npm run directory:check -- https://tailorit.example.com [--token <MCP token>] [--via <address>]
//
// - The origin: the https address people open (APP_ORIGIN); the MCP server is its /mcp (a listing leaves MCP_PUBLIC_URL
//   unset: docs/directory/CHECKLIST.md, step 1).
// - --token (or TAILORIT_MCP_TOKEN): an MCP access token of an account on that server (Settings › Integrations ›
//   Advanced makes a personal one), for the checks of tools/list. It is sent to the origin only and never printed; a
//   value that looks like a token anywhere else on the command line is refused without being printed.
// - --via: send every request to this address instead (a web server on this machine, say http://127.0.0.1:3100, or an
//   https address), with the origin's host in Host and X-Forwarded-Host and https in X-Forwarded-Proto, as a tunnel or
//   Caddy would. Plain http only to this machine (127.0.0.0/8, ::1, localhost): the token never crosses a network in
//   clear text. TailorIT believes those headers only from this machine and for APP_ORIGIN's host or a trusted host
//   (TRUSTED_PUBLIC_HOSTS). The DNS check is skipped then. The tests use it (no outside host is ever asked).
//
// v34 FIX-API (the final directory review, D8): also a token Claude would refuse answers 401 invalid_token, Claude Code's
// client document (its loopback callback) reaches the consent page, the token and registration endpoints answer their
// OAuth errors as Claude expects (form-encoded token, JSON registration, within 10 s; nothing is registered), "plain"
// PKCE is not offered, the reserved IP ranges count as not public, and with a token one read-only tool call
// (`instructions`) answers without an error, its result within Claude Code's size and free of the banned wording.
// Each check prints PASS, FAIL (with what to do next), WARN (a decision to make before submitting) or SKIP; the last
// line counts them. Exit codes: 0 when every check ran and none failed (warnings allowed), 1 when a check failed, 2 for
// a wrong command line, 3 when nothing failed but a check was skipped (no token, or --via's DNS check): not complete.
// Runs with tsx's loader (`node --import tsx`, as the npm script does): the expected titles and hints are the API's
// own table (features/mcp/tool-meta.ts), the wording rules the MCP tests' own (features/mcp/wording.ts), the pages,
// icons and OAuth addresses the shared contracts' (@tailorit/shared).
import { createHash, randomBytes } from 'node:crypto';
import { resolve4 as dnsResolve4 } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { MCP_PATH } from '@tailorit/shared/mcp';
import {
  OAUTH_KNOWN_CLIENTS,
  OAUTH_PATHS,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_SCOPE_MCP,
  OAUTH_SCOPE_OFFLINE,
  OAUTH_SERVER_METADATA_PATH,
} from '@tailorit/shared/oauth';
import { BRAND_ICONS, PUBLIC_PAGE_PATHS } from '@tailorit/shared/public-pages';
import { MCP_TOOL_META } from '../apps/api/src/features/mcp/tool-meta.ts';
import {
  bannedWordingIn,
  estimatedTokens,
  MCP_TOOL_NAME_PATTERN,
  MCP_TOOLS_LIST_TOKEN_BUDGET,
  withoutFencedData,
} from '../apps/api/src/features/mcp/wording.ts';

/** Claude waits this long for a discovery, registration or token answer (claude.com/docs/connectors, 2026-11-21). */
export const DISCOVERY_MS = 10_000;
/** Any other request's wait. */
const REQUEST_MS = 30_000;
/** The most of an answer read (the pages and icons are far smaller). */
const BODY_MAX = 4 * 1024 * 1024;
const USER_AGENT = 'TailorIT directory check';
/** The protocol version asked for at initialize (the server answers the one it speaks). */
const PROTOCOL_VERSION = '2025-11-25';

/** Claude's hosted apps (claude.ai, Desktop, mobile): their client document and their one callback. */
const CLAUDE = OAUTH_KNOWN_CLIENTS.find((known) => known.kind === 'claude');
export const CLAUDE_DOCUMENT = CLAUDE.documents.find((address) => address.endsWith('/mcp-oauth-client-metadata'));
export const CLAUDE_CALLBACK = CLAUDE.callbacks[0];
// v34 FIX-API (D8)
/** Claude Code's client document, and a callback of its kind (a loopback address, any port: claude.com/docs/connectors). */
export const CLAUDE_CODE_DOCUMENT = CLAUDE.documents.find((address) => address.endsWith('/claude-code-client-metadata'));
export const CLAUDE_CODE_CALLBACK = 'http://localhost:33418/callback';
/** The read-only tool the token's checks call once (no arguments, every account and plan has it). */
export const SMOKE_TOOL = 'instructions';
/** A tool result's ceiling in tokens: Claude Code's (25,000), the tighter of Claude's limits. */
export const RESULT_TOKENS_MAX = 25_000;

/** What the consent page's error codes mean for a connector, and what to do. */
const PAGE_ERRORS = {
  invalid_client:
    "TailorIT refused Claude's client document or could not read it: the server must reach https://claude.ai over https, and run v3.3.1 or later (Claude's document lists a grant type older releases refused).",
  invalid_redirect: "TailorIT refused Claude's callback address: check OAUTH_KNOWN_CLIENTS and the server's version.",
  invalid_request: 'TailorIT found the authorization request malformed: run this check again; if it stays, look at the API log.',
  temporarily_unavailable: "TailorIT could not read Claude's client document just now: check the server reaches https://claude.ai, then try again.",
};

/** A wrong command line (exit 2). */
export class UsageError extends Error {}

// ------------------------------------------------------------------------------------------------- the transport

/**
 * @typedef {{ status: number, headers: Record<string, string>, setCookies: string[], body: Buffer, ms: number }} Answer
 * @typedef {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} SendOptions
 * @typedef {(url: string, options?: SendOptions) => Promise<Answer>} Transport
 */

/**
 * One request at a time over node:http(s), redirects never followed, no cookie but those a check passes. With `via`,
 * every request goes there instead, naming the address it was for in Host and X-Forwarded-Host, its scheme in
 * X-Forwarded-Proto.
 * @param {{ via?: string | null, timeoutMs?: number }} [options]
 * @returns {Transport}
 */
export function httpTransport({ via = null, timeoutMs = REQUEST_MS } = {}) {
  const hop = via ? new URL(via) : null;
  return (url, options = {}) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const headers = { 'user-agent': USER_AGENT, ...(options.headers ?? {}) };
      let connect = target;
      if (hop) {
        headers.host = target.host;
        headers['x-forwarded-host'] = target.host;
        headers['x-forwarded-proto'] = target.protocol.slice(0, -1);
        connect = hop;
      }
      if (options.body !== undefined) headers['content-length'] = String(Buffer.byteLength(options.body));
      const send = connect.protocol === 'https:' ? httpsRequest : httpRequest;
      const started = performance.now();
      const wait = options.timeoutMs ?? timeoutMs;
      const req = send(
        {
          hostname: connect.hostname.replace(/^\[|\]$/g, ''),
          port: connect.port || undefined,
          method: options.method ?? 'GET',
          path: `${target.pathname}${target.search}`,
          headers,
          timeout: wait,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > BODY_MAX) {
              req.destroy(new Error(`its answer is over ${BODY_MAX / 1024 / 1024} MB`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const flat = {};
            for (const [name, value] of Object.entries(res.headers)) {
              if (name !== 'set-cookie' && value !== undefined) flat[name] = Array.isArray(value) ? value.join(', ') : String(value);
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: flat,
              setCookies: res.headers['set-cookie'] ?? [],
              body: Buffer.concat(chunks),
              ms: Math.round(performance.now() - started),
            });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`no answer within ${Math.round(wait / 1000)} s`)));
      req.on('error', reject);
      req.end(options.body);
    });
}

// ------------------------------------------------------------------------------------------------- helpers

/**
 * Whether a command-line value may be a token (TailorIT's prefixes, or a long run of token characters with no dot or
 * colon, which no address has): such a value is never printed.
 */
export function looksLikeToken(text) {
  const value = String(text ?? '').trim().replace(/^-+/, '');
  return /^ti[a-z]_/i.test(value) || /^[A-Za-z0-9_~+/=-]{20,}$/.test(value);
}

/** A value to quote in a refusal: itself, or a note when it may be a token. */
const quoted = (text) => (looksLikeToken(text) ? 'a value that looks like a token (not printed)' : `"${text ?? ''}"`);

/** A token given where an address or a second origin goes. */
const STRAY_TOKEN = 'A value that looks like a token was given on its own (not printed): pass a token after --token, or in TAILORIT_MCP_TOKEN.';

/** Whether `hostname` is this machine (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

/** The https origin a person opens, from what was typed ("https://Example.com/" -> "https://example.com"). */
export function canonicalOrigin(text) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    if (looksLikeToken(text)) throw new UsageError(STRAY_TOKEN);
    throw new UsageError(`${quoted(text)} is not an address. Give the https address people open, such as https://tailorit.example.com.`);
  }
  if (url.protocol !== 'https:') throw new UsageError('The directory lists https servers only: give the https address people open.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new UsageError('Give the origin alone (https://tailorit.example.com), without a path, query or sign-in.');
  }
  return url.origin;
}

const textOf = (answer) => answer.body.toString('utf8');
const isRedirect = (status) => status >= 300 && status < 400;
const isHtml = (answer) => /^text\/html\b/i.test(answer.headers['content-type'] ?? '');

/** The answer's JSON, or an Error saying what came instead. */
function jsonOf(answer, what) {
  if (answer.status !== 200) throw new Error(`${what} answered ${answer.status}${isRedirect(answer.status) ? ` (a redirect to ${answer.headers.location ?? '?'})` : ''}, not 200 with JSON.`);
  try {
    return JSON.parse(textOf(answer));
  } catch {
    throw new Error(`${what} answered 200 but not with JSON (${answer.headers['content-type'] ?? 'no content type'}).`);
  }
}

/** An Error's sentence, for a FAIL line. */
function problemOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

/** A list of things, cut after `max` with how many more. */
function listed(items, max = 6) {
  if (items.length <= max) return items.join('; ');
  return `${items.slice(0, max).join('; ')}; and ${items.length - max} more`;
}

/**
 * Whether an IPv4 address is one Claude refuses to connect to (private, loopback, link-local, shared or reserved). v34
 * FIX-API (D8): the IETF protocol range 192.0.0.0/24 and the documentation ranges 192.0.2.0/24, 198.51.100.0/24 and
 * 203.0.113.0/24 too.
 */
export function isNonPublicIpv4(address) {
  const [a, b, c] = address.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** A PNG's width and height from its IHDR chunk, or null. */
export function pngSize(body) {
  const signature = '89504e470d0a1a0a';
  if (body.length < 24 || body.subarray(0, 8).toString('hex') !== signature || body.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

/** `cookie: name=value; ...` from Set-Cookie lines. */
const cookieHeader = (lines) => lines.map((line) => line.split(';')[0].trim()).filter(Boolean).join('; ');

/** Canonical JSON (keys sorted), to compare hints. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The JSON-RPC message of an MCP answer (JSON, or the last `data:` of an event stream). */
function rpcMessage(answer, method) {
  if (answer.status === 401) throw new Error(`${method} answered 401: the token was refused (expired, revoked, or made for another address). Make a new one on this server.`);
  if (answer.status === 403) {
    // The MCP endpoint's refusals (features/mcp/endpoint.ts): -32001 the account's plan, -32000 the address or a page.
    let refusal = null;
    try {
      refusal = JSON.parse(textOf(answer))?.error ?? null;
    } catch {
      refusal = null;
    }
    const said = typeof refusal?.message === 'string' && refusal.message.trim() ? ` ("${refusal.message.trim().slice(0, 200)}")` : '';
    if (refusal?.code === -32001) {
      throw new Error(`${method} answered 403${said}: this account's plan does not include the MCP server. Turn FREE_MCP and PAID_MCP on (Admin › Constants), or use a token of an account whose plan has it.`);
    }
    throw new Error(`${method} answered 403${said}: TailorIT refused the address the request was sent to. Check APP_ORIGIN, and that the proxy in front passes the Host it was sent.`);
  }
  if (answer.status !== 200) throw new Error(`${method} answered ${answer.status}, not 200.`);
  const text = textOf(answer);
  let message;
  try {
    if (/text\/event-stream/i.test(answer.headers['content-type'] ?? '')) {
      const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
      message = JSON.parse(data.at(-1) ?? '');
    } else {
      message = JSON.parse(text);
    }
  } catch {
    throw new Error(`${method} answered no JSON-RPC message.`);
  }
  if (message.error) throw new Error(`${method} was refused: ${message.error.message ?? message.error.code}.`);
  return message.result;
}

// ------------------------------------------------------------------------------------------------- the checks

/**
 * @typedef {{ id: string, title: string, ok: boolean | null | 'warn', detail?: string }} CheckResult
 * ok: true passed, false failed, null skipped, 'warn' passed with a decision to make (WARN).
 */

/**
 * Runs every check against `origin`. `transport` sends the requests (httpTransport by default); `resolve4` looks the
 * name up (null: skip that check, as --via does). Never throws for a server's answer: each check reports its own.
 * @param {{ origin: string, token?: string | null, transport?: Transport, resolve4?: ((host: string) => Promise<string[]>) | null }} options
 * @returns {Promise<CheckResult[]>}
 */
export async function checkDirectory(options) {
  const origin = canonicalOrigin(options.origin);
  const send = options.transport ?? httpTransport();
  const resolve4 = options.resolve4 === undefined ? dnsResolve4 : options.resolve4;
  const token = options.token?.trim() || null;
  const mcpUrl = `${origin}${MCP_PATH}`;
  const metadataUrl = `${origin}${OAUTH_PROTECTED_RESOURCE_PATH}${MCP_PATH}`;
  /** @type {CheckResult[]} */
  const results = [];
  const shared = { resource: null, server: null, mcp: null, constants: null };

  const pass = (detail) => ({ ok: true, detail });
  const fail = (detail) => ({ ok: false, detail });
  const skip = (detail) => ({ ok: null, detail });
  const warn = (detail) => ({ ok: 'warn', detail });
  /** Where a listing's MCP address must be (CHECKLIST.md, step 1). */
  const oneAddress = 'a listing keeps /mcp on this origin and leaves MCP_PUBLIC_URL unset (CHECKLIST.md, step 1)';
  async function check(id, title, run) {
    let outcome;
    try {
      outcome = await run();
    } catch (error) {
      outcome = fail(problemOf(error));
    }
    results.push({ id, title, ...outcome });
  }
  /** GET `url` with no cookie; a failure says which address. */
  const get = (url, extra = {}) =>
    send(url, { headers: { accept: extra.accept ?? '*/*', ...(extra.headers ?? {}) }, timeoutMs: extra.timeoutMs }).catch((error) => {
      throw new Error(`${url}: ${problemOf(error)}`);
    });

  await check('ipv4', 'The name has a public IPv4 address (Claude connects over IPv4 only)', async () => {
    if (resolve4 === null) return skip('--via: the name is not looked up.');
    const host = new URL(origin).hostname;
    if (isIP(host)) return fail('The address is an IP address: the directory lists a domain name the operator owns.');
    let addresses;
    try {
      addresses = await resolve4(host);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) return fail(`${host} has no A record: give it one (Claude does not connect over IPv6).`);
    const inside = addresses.filter(isNonPublicIpv4);
    if (inside.length > 0) return fail(`${host} resolves to ${listed(inside)}, which Claude refuses (a private, shared or reserved address).`);
    return pass(`${host}: ${listed(addresses)}.`);
  });

  await check('resource-metadata', `Protected resource metadata (${OAUTH_PROTECTED_RESOURCE_PATH}${MCP_PATH})`, async () => {
    const answer = await get(metadataUrl, { accept: 'application/json', timeoutMs: DISCOVERY_MS });
    const document = jsonOf(answer, metadataUrl);
    shared.resource = document;
    const problems = [];
    if (document.resource !== mcpUrl) {
      problems.push(`resource is ${JSON.stringify(document.resource)}, not ${mcpUrl} exactly (${oneAddress})`);
    }
    const servers = Array.isArray(document.authorization_servers) ? document.authorization_servers : [];
    if (servers[0] !== origin) problems.push(`authorization_servers starts with ${JSON.stringify(servers[0] ?? null)}, not this server's issuer ${origin} (Claude uses the first only)`);
    if (!Array.isArray(document.scopes_supported) || !document.scopes_supported.includes(OAUTH_SCOPE_MCP)) problems.push(`scopes_supported does not list "${OAUTH_SCOPE_MCP}"`);
    if (problems.length > 0) return fail(`${listed(problems)}.`);
    return pass(`resource ${mcpUrl}; issuer first (${answer.ms} ms).`);
  });

  await check('server-metadata', `Authorization server metadata (${OAUTH_SERVER_METADATA_PATH})`, async () => {
    const issuer = shared.resource?.authorization_servers?.[0] ?? origin;
    const url = `${String(issuer).replace(/\/+$/, '')}${OAUTH_SERVER_METADATA_PATH}`;
    const answer = await get(url, { accept: 'application/json', timeoutMs: DISCOVERY_MS });
    const document = jsonOf(answer, url);
    shared.server = document;
    const problems = [];
    const lists = (field, value) => Array.isArray(document[field]) && document[field].includes(value);
    if (document.issuer !== issuer) problems.push(`issuer is ${JSON.stringify(document.issuer)}, not ${issuer}`);
    for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      const value = document[field];
      if (typeof value !== 'string' || !value.startsWith(`${origin}/`)) problems.push(`${field} is ${JSON.stringify(value ?? null)}, not an https address on ${origin}`);
    }
    if (document.client_id_metadata_document_supported !== true) problems.push('client_id_metadata_document_supported is not true (Claude then registers instead of using its client document)');
    if (!lists('token_endpoint_auth_methods_supported', 'none')) problems.push('token_endpoint_auth_methods_supported does not list "none"');
    if (!lists('code_challenge_methods_supported', 'S256')) problems.push('code_challenge_methods_supported does not list "S256"');
    // v34 FIX-API (D8): "plain" lets whoever sees the authorization request exchange its code; Claude uses S256 only.
    if (lists('code_challenge_methods_supported', 'plain')) problems.push('code_challenge_methods_supported lists "plain" (offer S256 only)');
    if (!lists('scopes_supported', OAUTH_SCOPE_OFFLINE)) problems.push(`scopes_supported does not list "${OAUTH_SCOPE_OFFLINE}" (Claude asks for it to stay connected)`);
    if (!lists('response_types_supported', 'code')) problems.push('response_types_supported does not list "code"');
    for (const grant of ['authorization_code', 'refresh_token']) if (!lists('grant_types_supported', grant)) problems.push(`grant_types_supported does not list "${grant}"`);
    if (problems.length > 0) return fail(`${listed(problems)}.`);
    return pass(`issuer ${issuer}; client documents, registration, public clients, S256 and offline_access (${answer.ms} ms).`);
  });

  await check('discovery-links', 'The documentation, privacy and terms links open without signing in', async () => {
    const named = [
      ['resource_documentation', shared.resource],
      ['resource_policy_uri', shared.resource],
      ['resource_tos_uri', shared.resource],
      ['service_documentation', shared.server],
      ['op_policy_uri', shared.server],
      ['op_tos_uri', shared.server],
    ];
    if (!shared.resource || !shared.server) return skip('the discovery documents did not read (above).');
    const problems = [];
    const links = new Set();
    for (const [field, document] of named) {
      const value = document[field];
      if (typeof value !== 'string' || !value.startsWith('https://')) problems.push(`${field} is ${JSON.stringify(value ?? null)}, not an https address`);
      else links.add(value);
    }
    for (const link of links) {
      const answer = await get(link, { accept: 'text/html' });
      if (answer.status !== 200 || !isHtml(answer)) {
        problems.push(`${link} answered ${answer.status}${isRedirect(answer.status) ? ` (to ${answer.headers.location ?? '?'}: it must open without signing in)` : ''}`);
      }
    }
    if (problems.length > 0) return fail(`${listed(problems)}.`);
    return pass(`${[...links].join(', ')}.`);
  });

  await check('challenge', `${MCP_PATH} without a token answers 401 and points at the metadata`, async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: USER_AGENT, version: '1' } } });
    const answer = await send(mcpUrl, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body });
    if (answer.status !== 401) {
      const why = isRedirect(answer.status) ? ` (a redirect to ${answer.headers.location ?? '?'}: Claude drops the token on a redirect to another host; give the final address)` : '';
      return fail(`It answered ${answer.status}${why}, not 401.`);
    }
    const challenge = answer.headers['www-authenticate'] ?? '';
    if (!/^Bearer\b/i.test(challenge)) return fail('The 401 has no "WWW-Authenticate: Bearer" header.');
    const pointer = /resource_metadata="([^"]*)"/i.exec(challenge)?.[1] ?? null;
    if (pointer !== metadataUrl) return fail(`WWW-Authenticate's resource_metadata is ${JSON.stringify(pointer)}, not ${metadataUrl} (${oneAddress}).`);
    return pass(`WWW-Authenticate: ${challenge}`);
  });

  // v34 FIX-API (D8): Claude refreshes on a 401 that says invalid_token; a 403 or a 429 there would end its connection.
  await check('bad-token', `${MCP_PATH} with a token it does not know answers 401 invalid_token`, async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: USER_AGENT, version: '1' } } });
    const madeUp = `tim_${randomBytes(32).toString('base64url')}`;
    const answer = await send(mcpUrl, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${madeUp}` }, body });
    if (answer.status !== 401) return fail(`It answered ${answer.status}, not 401: Claude refreshes its token on a 401 and gives up on anything else.`);
    const challenge = answer.headers['www-authenticate'] ?? '';
    const problems = [];
    if (!/^Bearer\b/i.test(challenge)) problems.push('no "WWW-Authenticate: Bearer" header');
    if (!/error="invalid_token"/i.test(challenge)) problems.push('no error="invalid_token" in WWW-Authenticate');
    const pointer = /resource_metadata="([^"]*)"/i.exec(challenge)?.[1] ?? null;
    if (pointer !== metadataUrl) problems.push(`resource_metadata is ${JSON.stringify(pointer)}, not ${metadataUrl}`);
    if (problems.length > 0) return fail(`The 401 has ${listed(problems)}.`);
    return pass('401 with error="invalid_token" and the metadata address (Claude refreshes, then signs in again).');
  });

  /** v34 FIX-API (D8): an authorization request as `document`'s app sends it reaches the consent page (Claude's, Claude Code's). */
  const reachesConsent = async (document, callback) => {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: document,
      redirect_uri: callback,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomBytes(16).toString('base64url'),
      resource: mcpUrl,
      scope: `${OAUTH_SCOPE_MCP} ${OAUTH_SCOPE_OFFLINE}`,
    });
    const endpoint = typeof shared.server?.authorization_endpoint === 'string' ? shared.server.authorization_endpoint : `${origin}${OAUTH_PATHS.authorize}`;
    const answer = await get(`${endpoint}?${query}`, { accept: 'text/html' });
    if (!isRedirect(answer.status) || !answer.headers.location) return fail(`The authorization request answered ${answer.status}, not a redirect to the consent page.`);
    const next = new URL(answer.headers.location, endpoint);
    const where = `${next.origin}${next.pathname}`;
    if (where === callback) {
      return fail(`TailorIT sent the browser back to Claude with "${next.searchParams.get('error')}": ${next.searchParams.get('error_description') ?? 'no description'}.`);
    }
    if (where !== `${origin}${OAUTH_PATHS.consent}`) return fail(`TailorIT sent the browser to ${where}, not its consent page ${origin}${OAUTH_PATHS.consent}.`);
    const error = next.searchParams.get('error');
    if (error) return fail(`The consent page opened with "${error}": ${PAGE_ERRORS[error] ?? 'see the API log.'}`);
    if (!next.searchParams.get('request')) return fail('The consent page address carries no request.');
    // As a browser: the page with the binding cookie authorize set. Signed out, it asks to sign in first.
    const page = await get(next.href, { accept: 'text/html', headers: { cookie: cookieHeader(answer.setCookies) } });
    if (page.status === 200 && isHtml(page)) return pass('The consent page opened (nothing was allowed).');
    if (isRedirect(page.status) && page.headers.location) {
      const signIn = new URL(page.headers.location, next.href);
      if (signIn.origin === origin) {
        const login = await get(signIn.href, { accept: 'text/html' });
        if (login.status === 200 && isHtml(login)) return pass(`The consent page opened and asks to sign in first (${signIn.pathname}); nothing was allowed.`);
        return fail(`The consent page's sign-in (${signIn.pathname}) answered ${login.status}.`);
      }
    }
    return fail(`The consent page answered ${page.status}${page.headers.location ? ` (to ${page.headers.location})` : ''}.`);
  };
  await check('claude-client', "Claude's client document is accepted (the sign-in reaches the consent page)", () => reachesConsent(CLAUDE_DOCUMENT, CLAUDE_CALLBACK));
  // v34 FIX-API (D8): Claude Code signs in with its own document and a loopback callback (any port).
  await check('claude-code-client', "Claude Code's client document is accepted, with its loopback callback", () =>
    reachesConsent(CLAUDE_CODE_DOCUMENT, CLAUDE_CODE_CALLBACK),
  );

  // v34 FIX-API (D8): the token endpoint takes a form and answers OAuth's errors as JSON; registration takes JSON. Both
  // within Claude's 10 s. Nothing is made: a refresh token nobody holds, a registration with no callback.
  await check('oauth-endpoints', 'The token and registration endpoints answer as Claude expects (form-encoded token, JSON registration, 10 s)', async () => {
    const problems = [];
    const tokenUrl = typeof shared.server?.token_endpoint === 'string' ? shared.server.token_endpoint : `${origin}${OAUTH_PATHS.token}`;
    // As Claude's apps refresh: their client document as client_id (a public client: no secret).
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: randomBytes(32).toString('base64url'), client_id: CLAUDE_DOCUMENT }).toString();
    const token = await send(tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form, timeoutMs: DISCOVERY_MS });
    let tokenError = null;
    try {
      tokenError = JSON.parse(textOf(token))?.error ?? null;
    } catch {
      tokenError = null;
    }
    if (token.status !== 400 || tokenError !== 'invalid_grant') {
      problems.push(`${tokenUrl} answered a refresh token it does not know with ${token.status}${tokenError ? ` ${tokenError}` : ' and no OAuth error'}, not 400 invalid_grant (Claude then signs in again)`);
    }
    const registerUrl = typeof shared.server?.registration_endpoint === 'string' ? shared.server.registration_endpoint : `${origin}${OAUTH_PATHS.register}`;
    const register = await send(registerUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: USER_AGENT, redirect_uris: [], token_endpoint_auth_method: 'none' }),
      timeoutMs: DISCOVERY_MS,
    });
    let registerError = null;
    try {
      registerError = JSON.parse(textOf(register))?.error ?? null;
    } catch {
      registerError = null;
    }
    if (register.status !== 400 || !['invalid_redirect_uri', 'invalid_client_metadata'].includes(registerError)) {
      problems.push(`${registerUrl} answered a registration with no callback with ${register.status}${registerError ? ` ${registerError}` : ' and no OAuth error'}, not 400 invalid_redirect_uri (JSON)`);
    }
    if (problems.length > 0) return fail(`${listed(problems)}.`);
    return pass(`token: 400 invalid_grant (${token.ms} ms); registration: 400 ${registerError} (${register.ms} ms).`);
  });

  await check('public-pages', 'The public pages open without signing in', async () => {
    const problems = [];
    for (const path of Object.values(PUBLIC_PAGE_PATHS)) {
      const answer = await get(`${origin}${path}`, { accept: 'text/html' });
      if (answer.status !== 200 || !isHtml(answer)) {
        problems.push(`${path} answered ${answer.status}${isRedirect(answer.status) ? ` (to ${answer.headers.location ?? '?'})` : ''}`);
      }
    }
    if (problems.length > 0) return fail(`${listed(problems)}: the directory needs them open to everyone.`);
    return pass(`${Object.values(PUBLIC_PAGE_PATHS).join(', ')}.`);
  });

  await check('icons', 'The brand icons are there (the listing uses the 512 px PNG)', async () => {
    const problems = [];
    for (const icon of Object.values(BRAND_ICONS)) {
      const answer = await get(`${origin}${icon.path}`, { accept: icon.mimeType });
      const type = (answer.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (answer.status !== 200) {
        problems.push(`${icon.path} answered ${answer.status}`);
      } else if (type !== icon.mimeType) {
        problems.push(`${icon.path} is ${type || 'no type'}, not ${icon.mimeType}`);
      } else if (icon.mimeType === 'image/png') {
        const size = pngSize(answer.body);
        if (!size || `${size.width}x${size.height}` !== icon.size) problems.push(`${icon.path} is ${size ? `${size.width}x${size.height}` : 'no PNG'}, not ${icon.size}`);
      } else if (!/<svg\b/i.test(textOf(answer))) {
        problems.push(`${icon.path} holds no SVG drawing`);
      }
    }
    if (problems.length > 0) return fail(`${listed(problems)}: the release ships them in apps/web/public/brand; deploy the web with that folder and let the proxy pass /brand/ to it.`);
    return pass(`${Object.values(BRAND_ICONS).map((icon) => icon.path).join(', ')}.`);
  });

  await check('operator', 'The operator details are set and every plan has the connector (CONTACT_EMAIL, OPERATOR_*, FREE_MCP, PAID_MCP, PAID_AI_JOB_SEARCH)', async () => {
    const url = `${origin}/api/constants/public`;
    const values = jsonOf(await get(url, { accept: 'application/json' }), url)?.values ?? {};
    shared.constants = values;
    const problems = [];
    // The listing says every plan connects and AI job search comes with Paid (LISTING.md, Use cases).
    for (const [key, what] of [
      ['FREE_MCP', 'a Free account from the directory is refused at the consent page and at /mcp'],
      ['PAID_MCP', 'a Paid account from the directory is refused at the consent page and at /mcp'],
      ['PAID_AI_JOB_SEARCH', 'ai_search_jobs refuses every account, which the listing says Paid has'],
    ]) {
      if (values[key] !== true) problems.push(`${key} is off (${what})`);
    }
    // The contact address is the constant ADMIN_CONTACT_EMAIL, set by CONTACT_EMAIL in .env or in Admin › Constants.
    const email = typeof values.ADMIN_CONTACT_EMAIL === 'string' ? values.ADMIN_CONTACT_EMAIL.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push('CONTACT_EMAIL is not set (the support contact; the privacy page names it)');
    if (typeof values.OPERATOR_NAME !== 'string' || !values.OPERATOR_NAME.trim()) problems.push('OPERATOR_NAME is not set (the company the listing and the policies name)');
    let website = null;
    try {
      website = new URL(String(values.OPERATOR_WEBSITE ?? ''));
    } catch {
      website = null;
    }
    if (!website || website.protocol !== 'https:') problems.push('OPERATOR_WEBSITE is not an https address (the listing asks for the company website)');
    if (problems.length > 0) return fail(`${listed(problems)}. Set them in Admin › Constants or .env.`);
    return pass(`${values.OPERATOR_NAME}, ${website.href}, ${email}; the connector on Free and Paid, AI job search on Paid.`);
  });

  await check('report-text', 'report_unsupported keeps no words of the request (MCP_REPORT_REQUEST_TEXT off)', async () => {
    if (!shared.constants) return skip('the public constants did not read (above).');
    if (shared.constants.MCP_REPORT_REQUEST_TEXT === false) return pass('A report keeps what TailorIT lacks and the tools tried, never what the person asked.');
    return warn(
      "MCP_REPORT_REQUEST_TEXT is on: a report keeps a summary of what the person asked. The directory asks for no conversation data beyond what a tool needs: turn it off in Admin › Constants before you submit, or keep it and ask Anthropic first (CHECKLIST.md, step 6).",
    );
  });

  // ----------------------------------------------------------------------------------------- with a token: MCP

  const noToken = 'no --token: give an MCP token of an account on this server to check tools/list.';
  if (!token) {
    for (const [id, title] of MCP_CHECKS) results.push({ id, title, ok: null, detail: noToken });
    return results;
  }
  const titleOf = (id) => MCP_CHECKS.find(([key]) => key === id)[1];
  /** One JSON-RPC call; `version` the protocol version initialize agreed (sent on every later request). */
  let version = null;
  let sessionId = null;
  let nextId = 1;
  const rpc = async (method, params, notification = false) => {
    const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${token}` };
    if (version) headers['mcp-protocol-version'] = version;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const message = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params };
    const answer = await send(mcpUrl, { method: 'POST', headers, body: JSON.stringify(message) });
    sessionId ??= answer.headers['mcp-session-id'] ?? null;
    if (notification) return null;
    return rpcMessage(answer, method);
  };

  await check('mcp-initialize', titleOf('mcp-initialize'), async () => {
    const result = await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: USER_AGENT, version: '1' } });
    version = result?.protocolVersion ?? null;
    await rpc('notifications/initialized', {}, true);
    const info = result?.serverInfo ?? {};
    const problems = [];
    if (typeof info.title !== 'string' || !info.title.trim()) problems.push('serverInfo has no title');
    if (typeof info.version !== 'string' || !info.version.trim()) problems.push('serverInfo has no version');
    if (info.websiteUrl !== origin) problems.push(`serverInfo.websiteUrl is ${JSON.stringify(info.websiteUrl ?? null)}, not ${origin}`);
    const icons = Array.isArray(info.icons) ? info.icons.map((icon) => icon?.src) : [];
    const missing = Object.values(BRAND_ICONS).filter((icon) => !icons.includes(`${origin}${icon.path}`)).map((icon) => icon.path);
    if (missing.length > 0) problems.push(`serverInfo.icons leaves out ${listed(missing)}`);
    shared.mcp = { instructions: typeof result?.instructions === 'string' ? result.instructions : '' };
    if (problems.length > 0) return fail(`${listed(problems)}.`);
    return pass(`${info.title} ${info.version} (protocol ${version}), ${info.websiteUrl}, ${icons.length} icons.`);
  });
  if (!shared.mcp) {
    for (const [id, title] of MCP_CHECKS.slice(1)) results.push({ id, title, ok: null, detail: 'initialize did not succeed (above).' });
    return results;
  }

  let tools = [];
  let prompts = [];
  let listProblem = null;
  try {
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await rpc('tools/list', cursor ? { cursor } : {});
      tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    const listedPrompts = await rpc('prompts/list', {}).catch(() => ({ prompts: [] }));
    prompts = Array.isArray(listedPrompts?.prompts) ? listedPrompts.prompts : [];
  } catch (error) {
    listProblem = problemOf(error);
    tools = [];
  }
  if (listProblem) {
    for (const [id, title] of MCP_CHECKS.slice(1)) results.push({ id, title, ok: false, detail: listProblem });
    return results;
  }

  await check('tool-names', titleOf('tool-names'), async () => {
    if (tools.length === 0) return fail('tools/list holds no tool.');
    const bad = tools.filter((tool) => typeof tool.name !== 'string' || !MCP_TOOL_NAME_PATTERN.test(tool.name)).map((tool) => JSON.stringify(tool.name));
    if (bad.length > 0) return fail(`${listed(bad)}: a name is 1 to 64 letters, digits, _ or -.`);
    return pass(`${tools.length} tools.`);
  });

  await check('tool-hints', titleOf('tool-hints'), async () => {
    const problems = [];
    const served = new Set();
    for (const tool of tools) {
      served.add(tool.name);
      const hints = tool.annotations ?? {};
      if (typeof tool.title !== 'string' || !tool.title.trim()) problems.push(`${tool.name} has no title`);
      const says = hints.readOnlyHint === true || (hints.readOnlyHint === false && typeof hints.destructiveHint === 'boolean');
      if (!says) problems.push(`${tool.name} says neither readOnlyHint true nor, as a change, destructiveHint`);
      const pinned = MCP_TOOL_META[tool.name];
      if (!pinned) {
        problems.push(`${tool.name} is not in this checkout's features/mcp/tool-meta.ts (the server runs another release?)`);
        continue;
      }
      if (tool.title !== pinned.title) problems.push(`${tool.name}'s title is ${JSON.stringify(tool.title ?? null)}, not ${JSON.stringify(pinned.title)}`);
      if (canonical(hints) !== canonical(pinned.annotations)) problems.push(`${tool.name}'s hints are ${canonical(hints)}, not ${canonical(pinned.annotations)}`);
    }
    const absent = Object.keys(MCP_TOOL_META).filter((name) => !served.has(name));
    if (absent.length > 0) problems.push(`not served: ${listed(absent)} (the server runs another release?)`);
    if (problems.length > 0) return fail(`${listed(problems)}.`);
    return pass(`${tools.length} titles and hints equal tool-meta.ts.`);
  });

  await check('wording', titleOf('wording'), async () => {
    const texts = [
      ...tools.map((tool) => [`tool ${tool.name}`, JSON.stringify({ title: tool.title, description: tool.description, inputSchema: tool.inputSchema })]),
      ...prompts.map((prompt) => [`prompt ${prompt.name}`, JSON.stringify(prompt)]),
      ['the instructions', shared.mcp.instructions],
    ];
    const found = [];
    for (const [where, text] of texts) {
      for (const finding of bannedWordingIn(withoutFencedData(text))) found.push(`${where} ${finding.why} ("${finding.words}")`);
    }
    if (found.length > 0) return fail(`${listed(found)}.`);
    return pass(`${tools.length} tools, ${prompts.length} prompts and the instructions.`);
  });

  await check('tools-size', titleOf('tools-size'), async () => {
    const text = JSON.stringify({ tools });
    const tokens = estimatedTokens(text);
    const line = `${text.length.toLocaleString('en-US')} characters, about ${tokens.toLocaleString('en-US')} tokens (TailorIT's budget: ${MCP_TOOLS_LIST_TOKEN_BUDGET.toLocaleString('en-US')})`;
    return tokens <= MCP_TOOLS_LIST_TOKEN_BUDGET ? pass(`${line}.`) : fail(`${line}: the descriptions need a trim.`);
  });

  // v34 FIX-API (D8): the directory asks every tool to answer valid parameters with a success; one read-only call shows
  // the tools answer at all, and its result is scanned as the descriptions are (tool results are where the old
  // instruction-like lines lived) and held to Claude Code's size.
  await check('tool-call', titleOf('tool-call'), async () => {
    const result = await rpc('tools/call', { name: SMOKE_TOOL, arguments: {} });
    const text = (Array.isArray(result?.content) ? result.content : []).filter((part) => part?.type === 'text').map((part) => String(part.text)).join('\n');
    if (result?.isError) return fail(`${SMOKE_TOOL} answered an error for valid arguments ("${text.slice(0, 200)}"): every tool must answer them with a success.`);
    if (!text.trim()) return fail(`${SMOKE_TOOL} answered no text.`);
    const tokens = estimatedTokens(text);
    if (tokens > RESULT_TOKENS_MAX) return fail(`${SMOKE_TOOL}'s answer is about ${tokens.toLocaleString('en-US')} tokens, over Claude Code's ${RESULT_TOKENS_MAX.toLocaleString('en-US')}.`);
    const found = bannedWordingIn(withoutFencedData(text)).map((finding) => `${finding.why} ("${finding.words}")`);
    if (found.length > 0) return fail(`${SMOKE_TOOL}'s answer ${listed(found)}.`);
    return pass(`${SMOKE_TOOL}: ${text.length.toLocaleString('en-US')} characters, about ${tokens.toLocaleString('en-US')} tokens, no error and no such wording.`);
  });

  return results;
}

/** The checks that need a token, in order. */
const MCP_CHECKS = [
  ['mcp-initialize', 'MCP initialize with the token (serverInfo: title, version, website, icons)'],
  ['tool-names', 'Tool names (64 characters at most)'],
  ['tool-hints', 'Every tool has a title and the hints of tool-meta.ts'],
  ['wording', 'No wording that reads as prompt injection (titles, descriptions, prompts, instructions)'],
  ['tools-size', 'The tools/list size'],
  ['tool-call', `A read-only tool answers valid arguments (${SMOKE_TOOL}): no error, its result within size and wording`], // v34 FIX-API (D8)
];

// ------------------------------------------------------------------------------------------------- the command

/** The exit code of a run: 1 a failure, 3 a skip (not complete), else 0 (warnings allowed). 2 is a wrong command line. */
export function exitCodeOf(results) {
  if (results.some((result) => result.ok === false)) return 1;
  if (results.some((result) => result.ok === null)) return 3;
  return 0;
}

const LABELS = new Map([[true, 'PASS'], [false, 'FAIL'], [null, 'SKIP'], ['warn', 'WARN']]);

/** The lines a person reads. */
export function formatResults(origin, results, via = null) {
  const lines = [`TailorIT directory check of ${origin}${via ? ` (through ${via})` : ''}`];
  for (const result of results) {
    lines.push(`${LABELS.get(result.ok) ?? 'SKIP'}  ${result.title}`);
    if (result.detail) lines.push(`      ${result.detail}`);
  }
  const count = (ok) => results.filter((result) => result.ok === ok).length;
  const [failed, skipped, warned] = [count(false), count(null), count('warn')];
  const verdict =
    failed > 0
      ? `Not ready: ${failed} failed.`
      : skipped > 0
        ? `Not complete: ${skipped} skipped.`
        : warned > 0
          ? `Every check ran and none failed; read the ${warned === 1 ? 'warning' : 'warnings'}.`
          : 'Every check passed.';
  lines.push(
    `${results.length} checks: ${count(true)} passed, ${failed} failed, ${skipped} skipped, ${warned} ${warned === 1 ? 'warning' : 'warnings'}. ${verdict}`,
  );
  return lines;
}

const USAGE = [
  'Usage: npm run directory:check -- <https origin> [--token <MCP token>] [--via <address>]',
  '  <https origin>  the address people open, such as https://tailorit.example.com',
  '  --token         an MCP token of an account there (or TAILORIT_MCP_TOKEN), for the tools/list checks',
  '  --via           send the requests to this address instead, naming the origin in Host: https, or http on this',
  '                  machine only (127.0.0.1, ::1, localhost)',
  'Exit codes: 0 every check ran and none failed, 1 a check failed, 2 a wrong command line, 3 a check was skipped.',
].join('\n');

/** The command line's options. */
export function parseArguments(argv, env = {}) {
  const options = { origin: null, token: env.TAILORIT_MCP_TOKEN?.trim() || null, via: null, help: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const given = inline ?? argv[++at];
      if (given === undefined || given === '') throw new UsageError(`${name} needs a value.`);
      return given;
    };
    if (name === '--help' || name === '-h') options.help = true;
    else if (name === '--token') options.token = value();
    else if (name === '--via') options.via = value();
    // L2 (review): a value that may be a token is never printed.
    else if (name.startsWith('-')) throw new UsageError(/^--?[a-z][a-z-]*$/i.test(name) ? `Unknown option ${name}.` : 'An unknown option was given (not printed).');
    else if (options.origin === null) options.origin = name;
    else throw new UsageError(looksLikeToken(name) ? STRAY_TOKEN : 'Give one origin only (a second address was given).');
  }
  if (options.help) return options;
  if (options.origin === null) throw new UsageError('Give the https address to check.');
  options.origin = canonicalOrigin(options.origin);
  if (options.via !== null) {
    let via;
    try {
      via = new URL(options.via);
    } catch {
      throw new UsageError(`--via: ${quoted(options.via)} is not an address.`);
    }
    if ((via.protocol !== 'http:' && via.protocol !== 'https:') || (via.pathname !== '/' && via.pathname !== '') || via.search || via.username) {
      throw new UsageError('--via takes an origin alone, such as http://127.0.0.1:3100.');
    }
    // L3 (review): the token goes to `via`: plain http only to this machine.
    if (via.protocol === 'http:' && !isLoopbackHost(via.hostname)) {
      throw new UsageError('--via sends the token there: give an https address, or http on this machine only (127.0.0.1, ::1, localhost).');
    }
    options.via = via.origin;
  }
  return options;
}

/** Runs the command; answers its exit code. `io` holds what it prints to and how it sends (tests pass their own). */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  let options;
  try {
    options = parseArguments(argv, io.env ?? process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(error.message);
    err(USAGE);
    return 2;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  const transport = io.transport ?? httpTransport({ via: options.via });
  const results = await checkDirectory({
    origin: options.origin,
    token: options.token,
    transport,
    resolve4: options.via ? null : io.resolve4,
  });
  for (const line of formatResults(options.origin, results, options.via)) out(line);
  return exitCodeOf(results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exit(1);
    },
  );
}
