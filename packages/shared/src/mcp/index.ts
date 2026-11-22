import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';

// v1.5 (work package M; v2.0: Prepare & Queue, v1.5's Prebuild renamed): Prepare with the person's own AI. TailorIT's
// MCP server (Streamable HTTP at POST /mcp on the API, http://127.0.0.1:4100/mcp) lets an AI client the person runs on
// their own plan (Claude Code, another MCP client) write the tailored resumes, cover letters and answers of the kits
// their `mcp` Prepares wait for; TailorIT checks facts and scores and stores the kits. The client authenticates with a personal MCP token made in Settings › Integrations › "Your own AI
// (MCP)". These are the Settings page's routes (session only):
//   GET    /api/mcp/tokens       → McpTokenList
//   POST   /api/mcp/tokens       McpTokenCreateBody → 201 McpTokenCreated (the secret, shown once)
//   DELETE /api/mcp/tokens/:id   → 204 (revoked; a revoked or unknown one is 404)

/** Every personal MCP token starts with this. */
export const MCP_TOKEN_PREFIX = 'tim_';
/** What a token may do. v2.0: Prepare (v1.5's `prebuild`, renamed) is the only use there is. */
export const MCP_SCOPES = ['prepare'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
/**
 * Older scope names a stored token may still hold, read as their v2.0 names (A3): v1.5's tokens say `prebuild`.
 * Migration 0822 rewrites the stored rows; the alias covers any row it did not reach.
 */
export const MCP_SCOPE_ALIASES: Readonly<Record<string, McpScope>> = { prebuild: 'prepare' };

/** A token's stored scopes (the mcp_tokens.scopes JSON array, parsed), as v2.0 reads them: aliases mapped, unknown dropped. */
export function readMcpScopes(stored: unknown): McpScope[] {
  if (!Array.isArray(stored)) return [];
  const named = stored.map((scope) => (typeof scope === 'string' ? (MCP_SCOPE_ALIASES[scope] ?? scope) : null));
  return MCP_SCOPES.filter((scope) => named.includes(scope));
}

/** The longest token name. */
export const MCP_TOKEN_NAME_MAX = 80;
/** The path of the MCP endpoint on the API. */
export const MCP_PATH = '/mcp';
/** The MCP server's name, as `claude mcp add` names it. */
export const MCP_SERVER_NAME = 'tailorit';

/** One token as Settings lists it: never its secret, which is shown once when it is made. */
export const McpTokenItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.enum(MCP_SCOPES)),
  createdAt: z.iso.datetime(),
  /** Written at most once a minute; null until first used. */
  lastUsedAt: z.iso.datetime().nullable(),
});
export type McpTokenItem = z.infer<typeof McpTokenItemSchema>;

// v34 ORIGIN2 (PLAN G7b)
/**
 * Where else Claude and ChatGPT could connect, for a page open at an address their servers cannot reach (this computer,
 * a LAN address): `origins`, this server's fixed public https addresses (APP_ORIGIN, TRUSTED_PUBLIC_HOSTS's https
 * addresses and host names), other than the page's own; `tunnels`, the domains of its trusted tunnel patterns
 * (`trycloudflare.com` for `*.trycloudflare.com`), whose changing addresses only the person knows.
 */
export const McpConnectAtSchema = z.object({ origins: z.array(z.string()), tunnels: z.array(z.string()) });
export type McpConnectAt = z.infer<typeof McpConnectAtSchema>;
// end v34 ORIGIN2

/**
 * The account's live tokens, newest first, and the MCP endpoint's address (MCP_PUBLIC_URL, else <the page's address>/mcp),
 * and (v34 ORIGIN2) where else an AI app could connect (absent from an older server).
 */
export const McpTokenListSchema = z.object({
  items: z.array(McpTokenItemSchema),
  endpoint: z.string(),
  connectAt: McpConnectAtSchema.optional(), // v34 ORIGIN2
});
export type McpTokenList = z.infer<typeof McpTokenListSchema>;

export const McpTokenCreateBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name the token, so you can tell it apart later')
    .max(MCP_TOKEN_NAME_MAX, messageError('MSG_TEXT_TOO_LONG', { max: MCP_TOKEN_NAME_MAX }))
    .refine((name) => !/[\p{Cc}\p{Cf}]/u.test(name), 'Use letters, digits, spaces and punctuation only'),
});
export type McpTokenCreateBody = z.infer<typeof McpTokenCreateBodySchema>;

/** The new token: `token` is its secret, answered this once and stored nowhere. */
export const McpTokenCreatedSchema = McpTokenItemSchema.extend({ token: z.string() });
export type McpTokenCreated = z.infer<typeof McpTokenCreatedSchema>;

/**
 * The MCP endpoint's address, from the API's port (4100 by default) and the host clients dial (`host`, in URL form: an
 * IPv6 address in brackets). By default 127.0.0.1, not localhost: the API listens on 127.0.0.1 by default (API_HOST),
 * and a client that resolves localhost to IPv6 (::1) first cannot reach it. The API's Settings route answers the
 * address .env sets (MCP_PUBLIC_URL, else API_HOST and API_PORT: apps/api/src/config/addresses.ts).
 */
export function mcpEndpointUrl(apiPort = 4100, host = '127.0.0.1'): string {
  return `http://${host}:${apiPort}${MCP_PATH}`;
}

/** The Claude Code command that adds TailorIT's MCP server with `token`. */
export function claudeCodeCommand(token: string, url = mcpEndpointUrl()): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
}

/** The environment variable the client configuration's bridge reads the Authorization header from. */
export const MCP_AUTH_ENV = 'TAILORIT_AUTH';

/**
 * The MCP client configuration (the `mcpServers` block of Claude Desktop's claude_desktop_config.json and most other
 * clients) for `token`: the mcp-remote bridge, run with npx on this machine, carrying the token as the Authorization
 * header. Claude Desktop reaches a server on this machine only through a local command (its remote connectors run in
 * Anthropic's cloud), so a plain `type: http` entry does not work there; the owner confirmed this one does (2026-11-10).
 * The header has no space after "Authorization:" and the token sits in `env`, because Claude Desktop on Windows breaks
 * an argument that holds a space; mcp-remote fills `${TAILORIT_AUTH}` from that variable.
 */
export function genericMcpConfig(token: string, url = mcpEndpointUrl()): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${' + MCP_AUTH_ENV + '}'],
          env: { [MCP_AUTH_ENV]: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

// v1.5 Q1: the person's own AI (MCP) settings, per account (migration 0817's mcp_settings; none stored: the defaults).
// Settings › Integrations › "Your own AI (MCP)" and the MCP tool prepare_settings (v1.5's prebuild_settings) both read
// and write them:
//   GET /api/mcp/settings          → McpSettings
//   PUT /api/mcp/settings          McpSettingsBody (any of its fields) → McpSettings, as saved
//   POST /api/mcp/settings/pending McpPendingDecision → McpSettings (v34 MCPDIR: the person's OK to their AI's request)
// - reviseRounds: how many revision rounds prepare_save_resume asks the person's AI for after its first resume, while
//   TailorIT's check still finds something to fix (0 to 5). TailorIT's own Prepare keeps its two.
// - promptMode: whose prompts the MCP tools' next steps point to: TailorIT's (prepare_prompt, the default) or the
//   person's own. Every save normalizes what it is sent to TailorIT's structure strictly, whichever it is.

/** The revision rounds a person may set, and the default. */
export const MCP_REVISE_ROUNDS = { min: 0, max: 5, default: 2 } as const;
/** TailorIT's prompts (prepare_prompt) or the person's own. */
export const MCP_PROMPT_MODES = ['tailorit', 'own-prompt'] as const;
export type McpPromptMode = (typeof MCP_PROMPT_MODES)[number];

const ReviseRoundsSchema = z
  .number()
  .int('Use a whole number')
  .min(MCP_REVISE_ROUNDS.min, `Use ${MCP_REVISE_ROUNDS.min} to ${MCP_REVISE_ROUNDS.max}`)
  .max(MCP_REVISE_ROUNDS.max, `Use ${MCP_REVISE_ROUNDS.min} to ${MCP_REVISE_ROUNDS.max}`);

// v2.0 (docs/design/v2.0/07-mcp.md): customInstructions, the person's own words for their AI, served after TailorIT's
// default instructions and appended to every prepare_prompt step. Plain text, at most
// MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS (4000: mcp_settings.custom_instructions' CHECK, 0824), control characters but
// line breaks and tabs removed; never logged. They cannot change the platform's rules: the server enforces those.

/** The custom instructions' technical ceiling: MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS' own maximum, the column's CHECK. */
export const MCP_CUSTOM_INSTRUCTIONS_MAX = PUBLIC_CONSTANT_SPECS.MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS.max;

/** Plain text: line ends as "\n", control and format characters removed but line breaks and tabs. */
export function cleanCustomInstructions(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' || char === '\t' ? char : ''));
}

const CustomInstructionsSchema = z
  .string()
  .overwrite(cleanCustomInstructions)
  .max(MCP_CUSTOM_INSTRUCTIONS_MAX, messageError('MSG_TEXT_TOO_LONG', { max: MCP_CUSTOM_INSTRUCTIONS_MAX }));

export const McpSettingsSchema = z.object({
  reviseRounds: ReviseRoundsSchema,
  promptMode: z.enum(MCP_PROMPT_MODES),
  /** v2.0: '' for none. An older answer without it reads as none. */
  customInstructions: CustomInstructionsSchema.default(''),
  /**
   * v34 MCPDIR: custom instructions the person's AI asked for (set_prepare_settings), waiting for the person's OK in
   * Settings › Integrations; absent when nothing waits. Every prompt keeps customInstructions until then.
   */
  pendingCustomInstructions: CustomInstructionsSchema.optional(),
});
export type McpSettings = z.infer<typeof McpSettingsSchema>;

/** v34 MCPDIR: POST /api/mcp/settings/pending: the person's OK (approve) or no (discard) to their AI's request. */
export const McpPendingDecisionSchema = z.object({ decision: z.enum(['approve', 'discard']) });
export type McpPendingDecision = z.infer<typeof McpPendingDecisionSchema>;

export const McpSettingsBodySchema = z
  .object({
    reviseRounds: ReviseRoundsSchema.optional(),
    promptMode: z.enum(MCP_PROMPT_MODES).optional(),
    customInstructions: CustomInstructionsSchema.optional(),
  })
  .refine(
    (body) => body.reviseRounds !== undefined || body.promptMode !== undefined || body.customInstructions !== undefined,
    'Send reviseRounds, promptMode or customInstructions',
  );
export type McpSettingsBody = z.infer<typeof McpSettingsBodySchema>;

/** What an account has before it changes anything. */
export const DEFAULT_MCP_SETTINGS: McpSettings = {
  reviseRounds: MCP_REVISE_ROUNDS.default,
  promptMode: 'tailorit',
  customInstructions: '',
};
// end v1.5 Q1
// v1.5 Q2: what the person's AI could not do (report_unsupported), listed in Settings › Integrations:
//   GET    /api/mcp/unsupported       → McpUnsupportedList (newest first)
//   DELETE /api/mcp/unsupported/:id   → 204 (another account's or an unknown one: 404)
//   DELETE /api/mcp/unsupported       → {removed}

/** The longest request and missing texts a report keeps. */
export const MCP_REPORT_REQUEST_MAX = 500;
export const MCP_REPORT_MISSING_MAX = 300;
/** Reports one token may send an hour (the newest an account keeps is the constant MCP_REPORTS_KEPT, v30 ST2). */
export const MCP_REPORTS_PER_HOUR = 20;

export const McpUnsupportedItemSchema = z.object({
  id: z.string(),
  /** What the person asked, in their AI's words (plain text). */
  request: z.string().max(MCP_REPORT_REQUEST_MAX),
  /** What TailorIT lacks to do it (plain text). */
  missing: z.string().max(MCP_REPORT_MISSING_MAX),
  /** The tools the AI tried first. */
  triedTools: z.array(z.string()),
  /** The token that sent it; null once the token is gone. */
  tokenName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type McpUnsupportedItem = z.infer<typeof McpUnsupportedItemSchema>;

export const McpUnsupportedListSchema = z.object({ items: z.array(McpUnsupportedItemSchema) });
export type McpUnsupportedList = z.infer<typeof McpUnsupportedListSchema>;

export const McpUnsupportedClearedSchema = z.object({ removed: z.number().int().nonnegative() });
export type McpUnsupportedCleared = z.infer<typeof McpUnsupportedClearedSchema>;
// end v1.5 Q2
