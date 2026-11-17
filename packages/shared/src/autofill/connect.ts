import { z } from 'zod';
import { InstantSchema } from './common';

// Connecting the extension. The Settings page mints a one-time connect code (POST /api/autofill/connect), the
// extension's worker exchanges it for a token (POST /api/autofill/connect/redeem, no cookie and no Authorization
// header), and the token reaches only /api/autofill/* (and its own AI tasks) with exactly the scopes the code carried.
// A token is a separate device credential: signing out of the web app does not revoke it; Settings, the extension's
// Disconnect and an admin's disable do.

/**
 * What a token may do. `profile:sensitive` (work authorization and self-identification answers) is granted only when
 * the person ticked "Let this browser read work authorization and self-identification answers" at connect time.
 * `jobs:add` adds a posting to TailorIT's jobs and the person's tracker, and `letters:write` finds or writes the
 * person's cover letter for a form and reads it as a PDF (both API version 2). Version 3: `profile:write` saves the
 * autofill profile from the side panel's "Autofill information" (the sensitive part only with `profile:sensitive`
 * too), `tracker:write` marks a job Applied in the person's tracker, `agent:run` takes jobs from the auto-apply queue
 * and reports how each went, and `credentials:read` reads the job-site sign-in the person saved in Settings ›
 * Autofill, for Sign-in mode Auto: granted only when the person ticked "Let this browser sign in to job sites for me"
 * at connect time (`allowSignIn`), as `profile:sensitive` is. A token keeps the scopes its code carried: one made
 * before a scope existed, or without the box ticked, is refused where it is needed (403, "Connect the extension
 * again").
 */
export const EXTENSION_SCOPES = [
  'profile:read',
  'profile:sensitive',
  'resumes:read',
  'jobs:lookup',
  'ai:run',
  'answers:write',
  'jobs:add',
  'letters:write',
  'profile:write',
  'tracker:write',
  'agent:run',
  'credentials:read',
] as const;
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number];

/** A Chrome extension id: 32 letters from a to p. */
export const ExtensionIdSchema = z.string().regex(/^[a-p]{32}$/);
/** `tia_` and 32 random bytes in base64url. Only its SHA-256 is stored; redeem answers the token itself, once. */
export const ExtensionTokenSchema = z.string().regex(/^tia_[A-Za-z0-9_-]{43}$/);

/** Crockford's base32 (the digits and the capitals but I, L, O and U), 16 characters: 80 random bits. */
const CONNECT_CODE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/**
 * A connect code as the person typed or pasted it, as it is hashed and stored: upper case, spaces and dashes dropped,
 * O read as 0 and I and L as 1 (Crockford's rule). Null when it cannot be a code.
 */
export function normalizeConnectCode(text: string): string | null {
  const code = text.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CONNECT_CODE.test(code) ? code : null;
}

/** A normalized code as the Settings page shows it, in groups of four: "K7QM-2XRD-9VHT-PA3C". */
export function formatConnectCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** A connect code as the server answers it (formatConnectCode's form). */
export const ConnectCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/);

/** POST /api/autofill/connect (the Settings page only), from the "Connect the extension" button and its checkbox. */
export const AutofillConnectBodySchema = z.object({
  /** Grant `profile:sensitive`. */
  includeSensitive: z.boolean(),
  /**
   * Grant `credentials:read` (version 3): the connection may read the job-site sign-in saved in Settings › Autofill,
   * for Sign-in mode Auto. Absent: false.
   */
  allowSignIn: z.boolean().default(false),
});
export type AutofillConnectBody = z.infer<typeof AutofillConnectBodySchema>;

/** POST /api/autofill/connect's answer (201): the code lives 10 minutes and works once. */
export const AutofillConnectResponseSchema = z.object({
  code: ConnectCodeSchema,
  expiresAt: InstantSchema,
  /** The extensions the page offers the code to (`chrome.runtime.sendMessage`); empty: the page shows the code. */
  extensionIds: z.array(ExtensionIdSchema),
});
export type AutofillConnectResponse = z.infer<typeof AutofillConnectResponseSchema>;

export const EXTENSION_BROWSERS = ['chrome', 'edge', 'other'] as const;
export type ExtensionBrowser = (typeof EXTENSION_BROWSERS)[number];
export const EXTENSION_OSES = ['windows', 'mac', 'linux', 'chromeos', 'other'] as const;
export type ExtensionOs = (typeof EXTENSION_OSES)[number];

/** The browser the token is for, which names the connection in Settings ("Chrome on Windows"). */
export const ExtensionClientSchema = z.object({
  browser: z.enum(EXTENSION_BROWSERS),
  /** The extension's manifest version ("0.1.0"). */
  extensionVersion: z.string().regex(/^\d{1,5}(?:\.\d{1,5}){0,3}$/),
  os: z.enum(EXTENSION_OSES),
});
export type ExtensionClient = z.infer<typeof ExtensionClientSchema>;

/**
 * POST /api/autofill/connect/redeem: the extension's worker, with no cookie and no Authorization header (a token sent
 * along, even a revoked one, makes the request that token's: 401 when it no longer works). A wrong, used or expired
 * code is refused (401 `not_signed_in`); one that cannot be a code at all is 400.
 */
export const AutofillRedeemBodySchema = z.object({
  /** As typed or as the page sent it; the server reads it through normalizeConnectCode. */
  code: z
    .string()
    .max(64, { abort: true })
    .refine((text) => normalizeConnectCode(text) !== null, 'Enter the 16-character code from Settings › Autofill'),
  client: ExtensionClientSchema,
});
export type AutofillRedeemBody = z.infer<typeof AutofillRedeemBodySchema>;

/** The account a token belongs to, as the extension shows it. */
export const AutofillAccountSchema = z.object({ name: z.string(), email: z.string() });
export type AutofillAccount = z.infer<typeof AutofillAccountSchema>;

/** Redeem's answer: the only time the token is sent. It expires at a fixed time (90 days); it is never extended. */
export const AutofillRedeemResponseSchema = z.object({
  token: ExtensionTokenSchema,
  tokenId: z.string(),
  expiresAt: InstantSchema,
  /** Exactly the code's scopes. */
  scopes: z.array(z.enum(EXTENSION_SCOPES)),
  account: AutofillAccountSchema,
  apiVersion: z.number().int(),
});
export type AutofillRedeemResponse = z.infer<typeof AutofillRedeemResponseSchema>;

/** GET /api/autofill/session (a token only): who is connected. DELETE on the same path disconnects (204). */
export const AutofillSessionSchema = z.object({
  /** The extension refuses to fill against another major version. */
  apiVersion: z.number().int(),
  token: z.object({
    id: z.string(),
    label: z.string(),
    scopes: z.array(z.enum(EXTENSION_SCOPES)),
    expiresAt: InstantSchema,
  }),
  account: AutofillAccountSchema,
  /** Whether TailorIT can run Claude now (the AI steps are skipped when it cannot). */
  ai: z.object({ available: z.boolean() }),
});
export type AutofillSession = z.infer<typeof AutofillSessionSchema>;

/** One connected browser on Settings › Autofill › Extension. */
export const AutofillTokenItemSchema = z.object({
  id: z.string(),
  /** "Chrome on Windows". */
  label: z.string(),
  /** From the client the extension named at redeem; null when it is not known. */
  browser: z.enum(EXTENSION_BROWSERS).nullable(),
  extensionVersion: z.string().nullable(),
  scopes: z.array(z.enum(EXTENSION_SCOPES)),
  /** It may read the job-site sign-in (`credentials:read`, version 3): the person allowed it when connecting. */
  signIn: z.boolean(),
  createdAt: InstantSchema,
  /** Written at most once a minute; null until first used. */
  lastUsedAt: InstantSchema.nullable(),
  expiresAt: InstantSchema,
});
export type AutofillTokenItem = z.infer<typeof AutofillTokenItemSchema>;

/** GET /api/autofill/tokens (the Settings page only). DELETE /api/autofill/tokens/:id disconnects one (204). */
export const AutofillTokenListSchema = z.object({
  items: z.array(AutofillTokenItemSchema),
  total: z.number().int().nonnegative(),
});
export type AutofillTokenList = z.infer<typeof AutofillTokenListSchema>;
