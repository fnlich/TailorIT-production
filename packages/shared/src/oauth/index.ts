import { z } from 'zod';
import { PUBLIC_PAGE_PATHS } from '../public-pages'; // v34 INT-A

interface UrlLike {
  protocol: string;
  hostname: string;
}
// URL and URLSearchParams exist in every browser and in Node; this package's lib types (ES only) do not declare them.
const runtime = globalThis as unknown as {
  URL: new (input: string) => UrlLike;
  URLSearchParams: new (init: Record<string, string>) => { toString(): string };
};

// v3.1 OAUTH (docs/design/v3.1/23-mcp-oauth.md): Claude and ChatGPT connect to TailorIT's MCP server through TailorIT's
// own OAuth 2.1 authorization server, with a consent page, like Notion's MCP integrations. The API serves, outside /api
// (an MCP client reaches them on the address people open, APP_ORIGIN, as Next rewrites and Caddy route them):
//   GET  /.well-known/oauth-protected-resource[/mcp]   the MCP endpoint's metadata (RFC 9728)
//   GET  /.well-known/oauth-authorization-server       the authorization server's metadata (RFC 8414)
//   POST /oauth/register                               Dynamic Client Registration (RFC 7591), public clients only
//   GET  /oauth/authorize                              an authorization request (PKCE S256), then the consent page
//   POST /oauth/token                                  authorization_code and refresh_token (rotated)
//   POST /oauth/revoke                                 token revocation (RFC 7009)
// and for the web, with the session (apps/web/src/features/oauth, the Integrations page):
//   GET    /api/oauth/requests/:id   → OAuthRequestView (the consent page's facts; the browser that started it only)
//   POST   /api/oauth/consent        OAuthConsentBody → OAuthConsentAnswer (where to send the browser next)
//   GET    /api/oauth/grants         → OAuthGrantList (the account's connected AI apps)
//   DELETE /api/oauth/grants/:id     → 204 (every token of that connection stops working at once)

/** An OAuth access token: 1 hour by default (OAUTH_ACCESS_TOKEN_MINUTES). */
export const OAUTH_ACCESS_TOKEN_PREFIX = 'tio_';
/** An OAuth refresh token: rotated at each use, OAUTH_REFRESH_IDLE_DAYS without use and it ends. */
export const OAUTH_REFRESH_TOKEN_PREFIX = 'tir_';

/** The one scope the MCP endpoint asks for: everything the MCP tools do for the account. */
export const OAUTH_SCOPE_MCP = 'mcp';
/** Asked by clients that want a refresh token (Claude adds it when the metadata lists it); TailorIT always gives one. */
export const OAUTH_SCOPE_OFFLINE = 'offline_access';
/** The scopes the authorization server knows; any other a client asks for is left out of the grant. */
export const OAUTH_SCOPES = [OAUTH_SCOPE_MCP, OAUTH_SCOPE_OFFLINE] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** The endpoints' paths, on APP_ORIGIN. */
export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  revoke: '/oauth/revoke',
  /** The web's consent page (apps/web/src/app/(app)/oauth/consent). */
  consent: '/oauth/consent',
} as const;
/** RFC 9728's well-known path; the MCP endpoint's own path follows it (/.well-known/oauth-protected-resource/mcp). */
export const OAUTH_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
/** RFC 8414's well-known path. */
export const OAUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';
/** The paths the API answers outside /api for OAuth (the web's dev rewrites and its sign-in gate name the same list). */
export const OAUTH_API_PATHS = [OAUTH_PATHS.authorize, OAUTH_PATHS.token, OAUTH_PATHS.register, OAUTH_PATHS.revoke] as const;
// v34 ORIGIN (PLAN G8): the public pages (no sign-in) the discovery documents link, on the issuer's origin: the guide
// (resource_documentation, service_documentation), the privacy policy (resource_policy_uri, op_policy_uri) and the
// terms (resource_tos_uri, op_tos_uri). The web builds them (PLAN: HELP the guide, PUBLIC the others). v34 INT-A
// (PUBLIC's exact edit 2): the paths are the public pages' own (@tailorit/shared/public-pages), one source.
export const OAUTH_DOCUMENT_PATHS = {
  guide: PUBLIC_PAGE_PATHS.guide,
  privacy: PUBLIC_PAGE_PATHS.privacy,
  terms: PUBLIC_PAGE_PATHS.terms,
} as const;
// end v34 ORIGIN

// ------------------------------------------------------------------------------------------------------- clients

/** Who an OAuth client is, as TailorIT recognizes it: by where it sends people back, or where its document lives. */
export const OAUTH_CLIENT_KINDS = ['claude', 'chatgpt', 'other'] as const;
export type OAuthClientKind = (typeof OAUTH_CLIENT_KINDS)[number];
/** How a client introduced itself: Dynamic Client Registration, or a Client ID Metadata Document (its https address). */
export const OAUTH_REGISTRATIONS = ['dcr', 'cimd'] as const;
export type OAuthRegistration = (typeof OAUTH_REGISTRATIONS)[number];

/**
 * The AI apps TailorIT knows, by their exact documented addresses only (v31 FIX-AUTH, SEC-5): Claude's callback
 * https://claude.ai/api/mcp/auth_callback and Claude Code's metadata document https://claude.ai/oauth/claude-code-client-metadata
 * (claude.com/docs/connectors/building/authentication, read 2026-11-17 and again 2026-11-18: no claude.com callback is
 * documented); v3.3.1: the document Claude's own apps (claude.ai, Desktop, mobile) send as their client_id,
 * https://claude.ai/oauth/mcp-oauth-client-metadata (read 2026-11-21: its client_id is its address, one redirect address,
 * the callback above, token_endpoint_auth_method none); ChatGPT's callback https://chatgpt.com/connector_platform_oauth_redirect and its document
 * https://chatgpt.com/oauth/client.json (developers.openai.com/plugins/build/auth, read 2026-11-17). Another path or
 * another host under those names is not the app: chatgpt.com/aip/g-.../oauth/callback, for one, is a third party's GPT.
 */
export const OAUTH_KNOWN_CLIENTS: ReadonlyArray<{
  kind: Exclude<OAuthClientKind, 'other'>;
  name: string;
  /** The app's own callbacks (its redirect addresses), exactly. */
  callbacks: readonly string[];
  /** The app's own Client ID Metadata Documents, exactly. */
  documents: readonly string[];
}> = [
  {
    kind: 'claude',
    name: 'Claude',
    callbacks: ['https://claude.ai/api/mcp/auth_callback'],
    documents: ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai/oauth/claude-code-client-metadata'],
  },
  {
    kind: 'chatgpt',
    name: 'ChatGPT',
    callbacks: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    documents: ['https://chatgpt.com/oauth/client.json'],
  },
];

/** The known app whose callbacks include `uri` exactly, or null. */
function knownByCallback(uri: string) {
  return OAUTH_KNOWN_CLIENTS.find((known) => known.callbacks.includes(uri)) ?? null;
}

/** The known app whose metadata documents include `address` exactly, or null. */
export function knownClientDocument(address: string): Exclude<OAuthClientKind, 'other'> | null {
  return OAUTH_KNOWN_CLIENTS.find((known) => known.documents.includes(address))?.kind ?? null;
}

/** Whether `address` is an http(s) address on this machine (localhost, 127.x.x.x, [::1]): a native app's callback. */
export function isLoopbackAddress(address: string): boolean {
  let url: UrlLike;
  try {
    url = new runtime.URL(address);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Which app a client is (v31 FIX-AUTH, SEC-5): a metadata document at one of a known app's exact document addresses is
 * that app's; any client (registered, or a document elsewhere) is a known app only when every address it sends people
 * back to is one of that app's exact callbacks, as its name is whatever it said it was. Anything else is `other`: the
 * consent page shows it as an app TailorIT could not verify, with its host.
 */
export function recognizeOAuthClient(client: { id: string; registration: OAuthRegistration; redirectUris: readonly string[] }): OAuthClientKind {
  if (client.registration === 'cimd') {
    const byDocument = knownClientDocument(client.id);
    if (byDocument) return byDocument;
  }
  if (client.redirectUris.length === 0) return 'other';
  const kinds = new Set(client.redirectUris.map((uri) => knownByCallback(uri)?.kind ?? 'other'));
  return kinds.size === 1 ? [...kinds][0]! : 'other';
}

/** The name an unverified app is shown by when its own name claims a known app or TailorIT (SEC-5). */
export const OAUTH_UNVERIFIED_APP_NAME = 'Unverified app';

/** Latin look-alikes of the letters in the names below (Cyrillic and Greek), folded before the comparison. */
const LOOK_ALIKES: Record<string, string> = {
  а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', х: 'x', у: 'y', і: 'i', ӏ: 'l', ԁ: 'd', һ: 'h', ո: 'n', т: 't', г: 'r',
  α: 'a', ε: 'e', ο: 'o', ρ: 'p', τ: 't', ι: 'i', ν: 'v', κ: 'k', η: 'n', υ: 'u',
};
/** The names an unverified app may not use: the known apps', their makers' and TailorIT's own. */
const RESERVED_NAMES = ['claude', 'chatgpt', 'openai', 'anthropic', 'tailorit'];

/**
 * Whether a client's own name claims to be a known app, its maker or TailorIT ("Claude", "C l a u d e", "ChatGPT Plus",
 * "TailorIT Connector"), letters folded: case, accents, look-alike letters, and everything that is no letter or digit.
 */
export function claimsKnownName(name: string): boolean {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/./gu, (letter) => LOOK_ALIKES[letter] ?? letter)
    .replace(/[^\p{L}\p{N}]/gu, '');
  return RESERVED_NAMES.some((reserved) => folded.includes(reserved));
}

/** The known app's own name for `kind` (Claude, ChatGPT), or null for another app. */
export function knownClientName(kind: OAuthClientKind): string | null {
  return OAUTH_KNOWN_CLIENTS.find((known) => known.kind === kind)?.name ?? null;
}

// ------------------------------------------------------------------------------------------- connecting, the links

/**
 * Claude's "Add custom connector" dialog, prefilled with TailorIT's name and MCP address
 * (claude.com/docs/connectors/building/directory-vs-custom, read 2026-11-17). `owner`: the organization-wide dialog a
 * Team or Enterprise owner uses. The person still confirms in Claude, then TailorIT's consent page opens.
 */
export function claudeConnectorLink(name: string, mcpUrl: string, options: { owner?: boolean } = {}): string {
  const base = options.owner ? 'https://claude.ai/admin-settings/connectors' : 'https://claude.ai/customize/connectors';
  const query = new runtime.URLSearchParams({ modal: 'add-custom-connector', connectorName: name, connectorUrl: mcpUrl });
  return `${base}?${query.toString()}`;
}

/** ChatGPT's plugins page: + then "Add custom MCP server" (no prefilled link exists; read 2026-11-17). */
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins';

/**
 * IPv4 ranges Claude's and ChatGPT's servers can never reach (v31 FIX-AUTH, REQ-5): this network, private, carrier-grade
 * NAT, loopback, link-local, the IETF and documentation ranges, benchmarking, multicast and reserved. The API's SSRF
 * guard keeps its own fuller list (apps/api/src/core/http/reader/address.ts), on Node's BlockList, which the browser
 * lacks; this one only decides whether the Connect dialog opens the apps or explains why it cannot.
 */
const UNREACHABLE_V4: ReadonlyArray<readonly [network: string, prefix: number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** A dotted IPv4 address as a number, or null (a URL parser writes every IPv4 host this way: 10.1 is 10.0.0.1). */
function ipv4Number(host: string): number | null {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

/** Whether `host` is an IPv4 address in one of UNREACHABLE_V4's ranges. */
function unreachableIpv4(host: string): boolean {
  const address = ipv4Number(host);
  if (address === null) return false;
  return UNREACHABLE_V4.some(([network, prefix]) => {
    const size = 2 ** (32 - prefix);
    const start = ipv4Number(network)!;
    return address >= start && address < start + size;
  });
}

/** Names that only a local network answers: localhost, .local (mDNS), .internal, .lan, .home, home.arpa, .corp ... */
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|lan|internal|intranet|home|home\.arpa|corp|localdomain)$/;

/**
 * Whether Claude and ChatGPT can reach TailorIT at `appOrigin` (APP_ORIGIN): only a public https address. On a local or
 * plain http address the Integrations page explains this instead of opening them (DEPLOYMENT.md). Not reachable (v31
 * FIX-AUTH, REQ-5): http, a single-label name, a local network's name (LOCAL_NAME), a loopback, private, link-local,
 * carrier-grade NAT or other non-public IPv4 address (UNREACHABLE_V4), and any IPv6 address written as the host (a
 * public site is reached by its name).
 */
export function connectorsReachable(appOrigin: string): boolean {
  let url: UrlLike;
  try {
    url = new runtime.URL(appOrigin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (isLoopbackAddress(appOrigin) || host.startsWith('[') || !host.includes('.')) return false;
  if (unreachableIpv4(host)) return false;
  return !LOCAL_NAME.test(host);
}

// ------------------------------------------------------------------------------------------------- the contracts

/** The consent page's facts about one authorization request (GET /api/oauth/requests/:id). */
export const OAuthRequestViewSchema = z.object({
  client: z.object({
    /** The name to show: a known app's own name, else what the client said it is. */
    name: z.string(),
    kind: z.enum(OAUTH_CLIENT_KINDS),
    registration: z.enum(OAUTH_REGISTRATIONS),
    /** A metadata document's host (where the client's description lives); null for a registered client. */
    host: z.string().nullable(),
  }),
  /** Where the browser goes after Allow or Cancel: the redirect address's host (with its port on this machine). */
  redirectHost: z.string(),
  /** The redirect goes to a program on this computer (http://localhost, 127.0.0.1): any program could listen there. */
  loopback: z.boolean(),
  scopes: z.array(z.string()),
  expiresAt: z.iso.datetime(),
});
export type OAuthRequestView = z.infer<typeof OAuthRequestViewSchema>;

/** POST /api/oauth/consent. */
export const OAuthConsentBodySchema = z.object({
  request: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  decision: z.enum(['allow', 'deny']),
});
export type OAuthConsentBody = z.infer<typeof OAuthConsentBodySchema>;

/** Where the consent page sends the browser: the client's redirect address with the code (or the refusal), state and iss. */
export const OAuthConsentAnswerSchema = z.object({ redirectTo: z.string() });
export type OAuthConsentAnswer = z.infer<typeof OAuthConsentAnswerSchema>;

/** One connected AI app (GET /api/oauth/grants), never a token. */
export const OAuthGrantItemSchema = z.object({
  id: z.string(),
  clientName: z.string(),
  clientKind: z.enum(OAUTH_CLIENT_KINDS),
  registration: z.enum(OAUTH_REGISTRATIONS),
  /** A metadata document's host; null for a registered client. */
  clientHost: z.string().nullable(),
  /** Where the client sends people back (its first redirect address's host). */
  redirectHost: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.iso.datetime(),
  /** Written at most once a minute; null until its first MCP call. */
  lastUsedAt: z.iso.datetime().nullable(),
});
export type OAuthGrantItem = z.infer<typeof OAuthGrantItemSchema>;

export const OAuthGrantListSchema = z.object({ items: z.array(OAuthGrantItemSchema) });
export type OAuthGrantList = z.infer<typeof OAuthGrantListSchema>;

/** The consent page's error codes in its address (/oauth/consent?error=...), when no client can be sent back to. */
export const OAUTH_PAGE_ERRORS = ['invalid_client', 'invalid_redirect', 'invalid_request', 'temporarily_unavailable'] as const;
export type OAuthPageError = (typeof OAUTH_PAGE_ERRORS)[number];
