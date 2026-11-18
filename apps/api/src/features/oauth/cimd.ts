import { MINUTE_MS } from '@tailorit/shared';
import { knownClientDocument } from '@tailorit/shared/oauth'; // v31 FIX-AUTH
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { assertRedirectAllowed } from '../../core/http/outbound';
import { isAddressRefused } from '../../core/http/reader/address';
import { defaultSiteTransport, type SiteTransport } from '../../core/http/reader/transport';
import { checkClientMetadata, clientOfRow, type OAuthClient } from './clients';
import { OAuthError } from './errors';

// v3.1 OAUTH: OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document; the MCP authorization
// spec 2025-11-25 prefers them). A client id that is an https address names a JSON document at that address saying the
// client's name and redirect addresses; TailorIT reads it when the client first asks, keeps it a while
// (OAUTH_CIMD_CACHE_MINUTES, less when the document's Cache-Control says so) in oauth_clients, and reads it again after.
//
// The read is a request to an address a stranger chose, so (the draft's §6, SSRF):
// - the address: https, a dotted public name (never an IP address, localhost or a local network's name: outbound.ts
//   assertRedirectAllowed), a path, no fragment, user or password, written as a URL parser writes it (the document's
//   client_id must equal it exactly);
// - the connection: the site reader's undici transport (core/http/reader/transport.ts): every address the name resolves
//   to must be public (no private, loopback, link-local or reserved address), checked when the socket is made;
// - no redirect is followed (a document lives at its own address), at most OAUTH_CIMD_MAX_BYTES are read, within
//   OAUTH_CIMD_TIMEOUT_MS;
// - no cookie, no credential, a fixed User-Agent.
// v31 FIX-AUTH (SEC-6): the default https port only (no https://host:22/...); reads are paid per caller address
// (OAUTH_CIMD_FETCHES_PER_MINUTE) and, for all callers together, OAUTH_CIMD_FETCHES_PER_MINUTE_ALL, which the known apps'
// own documents (OAUTH_KNOWN_CLIENTS, exact addresses: ChatGPT's https://chatgpt.com/oauth/client.json) never wait
// for, so strangers cannot use up ChatGPT's turn; and an address whose read failed is not read again for
// OAUTH_CIMD_FAILURE_MINUTES (a known app's document always is).
// It is no crawl of a job site: no robots.txt, no BOT_USER_AGENT (the client asked TailorIT to read it, as the protocol
// says), and it never reads a job board.

/** What the reads say they are. */
export const CIMD_USER_AGENT = 'TailorIT-OAuth (client metadata reader)';

/** The test seam: a transport, and the origins a test's local fixture server answers at (never in production). */
export interface OAuthCimdSeam {
  transport?: SiteTransport;
  /** Origins such as http://127.0.0.1:<port> whose documents may be read though they are no public https names. */
  testOrigins?: readonly string[];
}

declare module '../../core/context' {
  interface AppServices {
    /** v3.1 OAUTH: the client document reader's transport and test origins (tests only). */
    oauthCimd?: OAuthCimdSeam;
  }
}

/** The test origins, honoured only outside production. */
function testOriginsOf(deps: Pick<AppDeps, 'config' | 'services'>): readonly string[] {
  if (deps.config.isProduction) return [];
  return deps.services.oauthCimd?.testOrigins ?? [];
}

function originOf(address: string): string | null {
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

/** Whether a client id is a metadata document's address (an https address, or a test's fixture origin). */
export function isCimdClientId(deps: Pick<AppDeps, 'config' | 'services'>, clientId: string): boolean {
  if (clientId.startsWith('https://')) return true;
  const origin = originOf(clientId);
  return origin !== null && testOriginsOf(deps).includes(origin);
}

/** Why a metadata document's address is not one TailorIT reads, or null. */
export function cimdAddressProblem(deps: Pick<AppDeps, 'config' | 'services'>, clientId: string): string | null {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return 'not an address';
  }
  if (url.href !== clientId) return 'not in its canonical form';
  if (url.hash || url.username || url.password) return 'has a fragment, a user or a password';
  if (url.pathname === '/' || /\/\.\.?(?:\/|$)/.test(url.pathname)) return 'has no path';
  if (testOriginsOf(deps).includes(url.origin)) return null;
  // v31 FIX-AUTH (SEC-6): https on its own port (the URL parser leaves :443 out).
  if (url.port !== '') return 'is not on the default https port';
  try {
    assertRedirectAllowed(url);
  } catch {
    return 'is not a public https address';
  }
  return null;
}

/**
 * v31 FIX-AUTH (SEC-6): the reads of the last minute, all callers together (`all`) and per caller address (`byAddress`),
 * and the addresses whose read failed with when they may be read again (`failed`), per app (one process; a test's
 * context has its own). The maps drop ended entries as they grow.
 */
interface ReadBook {
  all: number[];
  byAddress: Map<string, number[]>;
  failed: Map<string, number>;
}
const booksOf = new WeakMap<object, ReadBook>();
/** Past this many entries a map is pruned (ended entries first, then the oldest). */
const BOOK_ENTRIES_MAX = 10_000;

function bookOf(deps: Pick<AppDeps, 'services'>): ReadBook {
  let book = booksOf.get(deps.services);
  if (!book) {
    book = { all: [], byAddress: new Map(), failed: new Map() };
    booksOf.set(deps.services, book);
  }
  return book;
}

/** Drops the reads older than a minute from the front of `reads` (oldest first). */
function lastMinute(reads: number[], now: number): number[] {
  while (reads.length > 0 && now - reads[0]! >= MINUTE_MS) reads.shift();
  return reads;
}

function tooMany(oldest: number, now: number): OAuthError {
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000));
  return new OAuthError('temporarily_unavailable', 'too many client documents read; try again soon', { retryAfterSeconds });
}

/** One read's turn for `caller`: its own budget, then (other than a known app's document) everyone's. */
function takeReadTurn(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, clientId: string, caller: string): void {
  const now = deps.now().getTime();
  const constants = constantsOf(deps);
  const book = bookOf(deps);
  if (book.byAddress.size > BOOK_ENTRIES_MAX) {
    for (const [address, reads] of book.byAddress) if (lastMinute(reads, now).length === 0) book.byAddress.delete(address);
  }
  const mine = lastMinute(book.byAddress.get(caller) ?? [], now);
  if (mine.length >= constants.get('OAUTH_CIMD_FETCHES_PER_MINUTE')) throw tooMany(mine[0]!, now);
  if (knownClientDocument(clientId) === null) {
    const all = lastMinute(book.all, now);
    if (all.length >= constants.get('OAUTH_CIMD_FETCHES_PER_MINUTE_ALL')) throw tooMany(all[0]!, now);
    all.push(now);
  }
  mine.push(now);
  book.byAddress.set(caller, mine);
}

/** Whether `clientId`'s document failed to read lately (never for a known app's own document). */
function failedLately(deps: Pick<AppDeps, 'now' | 'services'>, clientId: string): boolean {
  const until = bookOf(deps).failed.get(clientId);
  return until !== undefined && until > deps.now().getTime() && knownClientDocument(clientId) === null;
}

/** Keeps a failed read for OAUTH_CIMD_FAILURE_MINUTES. */
function rememberFailure(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, clientId: string): void {
  if (knownClientDocument(clientId) !== null) return;
  const now = deps.now().getTime();
  const { failed } = bookOf(deps);
  if (failed.size >= BOOK_ENTRIES_MAX) {
    for (const [address, until] of failed) if (until <= now) failed.delete(address);
    while (failed.size >= BOOK_ENTRIES_MAX) failed.delete(failed.keys().next().value as string);
  }
  failed.delete(clientId);
  failed.set(clientId, now + constantsOf(deps).get('OAUTH_CIMD_FAILURE_MINUTES') * MINUTE_MS);
}

/** How long a document is kept: its max-age when smaller, at least a minute, at most OAUTH_CIMD_CACHE_MINUTES. */
function keepMs(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, cacheControl: string | null): number {
  const most = constantsOf(deps).get('OAUTH_CIMD_CACHE_MINUTES') * MINUTE_MS;
  const header = (cacheControl ?? '').toLowerCase();
  if (/\b(?:no-store|no-cache)\b/.test(header)) return MINUTE_MS;
  const maxAge = /\bmax-age=(\d+)/.exec(header);
  if (!maxAge) return most;
  return Math.min(most, Math.max(MINUTE_MS, Number(maxAge[1]) * 1000));
}

interface CachedRow {
  id: string;
  kind: 'cimd';
  name: string;
  redirect_uris: string;
  recognized: OAuthClient['recognized'];
  expires_at: string | null;
}

/** Reads the document at `clientId` and checks it; throws invalid_client (or temporarily_unavailable) otherwise. */
async function readDocument(deps: AppDeps, clientId: string, caller: string): Promise<{ body: unknown; cacheControl: string | null }> {
  takeReadTurn(deps, clientId, caller);
  const transport = deps.services.oauthCimd?.transport ?? defaultSiteTransport();
  const constants = constantsOf(deps);
  let answer;
  try {
    answer = await transport.get(clientId, {
      headers: { accept: 'application/json', 'user-agent': CIMD_USER_AGENT },
      signal: AbortSignal.timeout(constants.get('OAUTH_CIMD_TIMEOUT_MS')),
      maxBytes: constants.get('OAUTH_CIMD_MAX_BYTES'),
    });
  } catch (error) {
    const why = isAddressRefused(error) ? 'an address that is not public' : error instanceof Error ? error.name : 'unknown';
    deps.log.info(`[oauth] a client document was not read (${why})`);
    throw new OAuthError('invalid_client', isAddressRefused(error) ? 'the client document is not at a public address' : 'the client document could not be read');
  }
  if (answer.status >= 300 && answer.status < 400) {
    throw new OAuthError('invalid_client', 'the client document redirects; TailorIT reads it at its own address only');
  }
  if (answer.status !== 200) throw new OAuthError('invalid_client', `the client document answered ${answer.status}`);
  if (answer.tooLarge) throw new OAuthError('invalid_client', 'the client document is too large');
  let body: unknown;
  try {
    body = JSON.parse(answer.body.toString('utf8'));
  } catch {
    throw new OAuthError('invalid_client', 'the client document is not JSON');
  }
  return { body, cacheControl: answer.headers.get('cache-control') };
}

/**
 * The client a metadata document's address names: kept from a recent read, else read now (and kept). Throws
 * invalid_client for an address TailorIT does not read, a document it cannot read, or one that does not describe
 * this client (its client_id is not its address, a secret in it, a redirect address OAuth 2.1 does not allow).
 */
export async function cimdClient(deps: AppDeps, clientId: string, caller = 'unknown'): Promise<OAuthClient> {
  const problem = cimdAddressProblem(deps, clientId);
  if (problem) throw new OAuthError('invalid_client', `the client_id address ${problem}`);
  const now = deps.now();
  const cached = await deps.db.one<CachedRow>(
    "SELECT id, kind, name, redirect_uris, recognized, expires_at FROM oauth_clients WHERE id = ? AND kind = 'cimd'",
    [clientId],
  );
  if (cached?.expires_at && Date.parse(cached.expires_at) > now.getTime()) return clientOfRow(cached);
  // v31 FIX-AUTH (SEC-6): a document that just failed is not read again for a while.
  if (failedLately(deps, clientId)) throw new OAuthError('invalid_client', 'the client document could not be read lately; try again later');
  try {
    return await readAndKeep(deps, clientId, caller);
  } catch (error) {
    if (error instanceof OAuthError && error.error === 'invalid_client') rememberFailure(deps, clientId);
    throw error;
  }
}

/** Reads the document at `clientId`, checks it and keeps it in oauth_clients. */
async function readAndKeep(deps: AppDeps, clientId: string, caller: string): Promise<OAuthClient> {
  const { body, cacheControl } = await readDocument(deps, clientId, caller);
  const document = body as Record<string, unknown> | null;
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new OAuthError('invalid_client', 'the client document is not a JSON object');
  }
  if (document.client_id !== clientId) throw new OAuthError('invalid_client', "the client document's client_id is not its address");
  if ('client_secret' in document || 'client_secret_expires_at' in document) {
    throw new OAuthError('invalid_client', 'a client document holds no secret');
  }
  let checked;
  try {
    checked = checkClientMetadata(document, 'cimd', clientId);
  } catch (error) {
    throw new OAuthError('invalid_client', error instanceof Error ? `the client document: ${error.message}` : 'the client document is not valid');
  }
  const fetchedAt = deps.now();
  const expiresAt = new Date(fetchedAt.getTime() + keepMs(deps, cacheControl));
  await deps.db.run(
    `INSERT INTO oauth_clients(id, kind, name, redirect_uris, recognized, metadata, created_at, fetched_at, expires_at)
     VALUES (?, 'cimd', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris,
       recognized = excluded.recognized, metadata = excluded.metadata, fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    [
      clientId,
      checked.name,
      JSON.stringify(checked.redirectUris),
      checked.recognized,
      JSON.stringify(checked.metadata),
      fetchedAt.toISOString(),
      fetchedAt.toISOString(),
      expiresAt.toISOString(),
    ],
  );
  return {
    id: clientId,
    registration: 'cimd',
    name: checked.name,
    redirectUris: checked.redirectUris,
    recognized: checked.recognized,
    host: new URL(clientId).host,
  };
}
