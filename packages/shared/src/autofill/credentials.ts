import { z } from 'zod';
import { HostNameSchema, InstantSchema } from './common';

// The person's job-site sign-in (version 3), for Sign-in mode Auto: an email and a password for the applicant-tracking
// sites that make an applicant sign in or create an account (Workday and others), one for every site (host `*`) and
// optionally one per site. Saved in Settings › Autofill › "Job-site sign-in" (the session only: the list never holds a
// password), kept encrypted in TailorIT (AES-256-GCM, its key in a file in TailorIT's data folder, never in the
// database), and read by the extension's worker only for an Auto sign-in (GET /api/autofill/credentials, scope
// credentials:read), which holds it in memory for that sign-in and types it into the page's password field only. A
// password is never logged, never in an error, and never stored by the extension.

/** The host of the sign-in used on every site that has none of its own (only the hosts below). */
export const AUTOFILL_ANY_HOST = '*';

/**
 * The applicant-tracking sites the every-site sign-in (`*`) is used on, by their domain: Workday's two (`myworkdayjobs`,
 * `myworkdaysite`), iCIMS, Taleo, SuccessFactors in both regions, Oracle Recruiting Cloud (and, version 6, its
 * government cloud), SmartRecruiters, (version 6) UltiPro, ClearCompany and ADP Workforce Now, and (version 7) Paycom,
 * the ones whose own sign-in and create-account pages Sign-in mode Auto fills or presses. A domain alone is not enough:
 * signInHostCovered
 * holds each to the hosts that serve the candidate's sign-in (see there), never the bare domain, its www, an API or a
 * storage host where anyone's uploads are served (Oracle Object Storage is under oraclecloud.com), and on a host that
 * also serves an employer's employee pages, to its candidate paths alone. Any other site gets a sign-in only when the
 * person saved one for that exact host (404 otherwise). The extension uses the same rule.
 */
export const AUTOFILL_SIGN_IN_HOST_SUFFIXES: readonly string[] = [
  'myworkdayjobs.com',
  'myworkdaysite.com',
  'icims.com',
  'taleo.net',
  'successfactors.com',
  'successfactors.eu',
  'oraclecloud.com',
  'smartrecruiters.com',
  'oraclegovcloud.com',
  'ultipro.com',
  // jr7 7a: recruiting.ultipro.ca, one of UKG's candidate-only recruiting hosts.
  'ultipro.ca',
  'clearcompany.com',
  'adp.com',
  // jr7 (version 7): www.paycomonline.net's candidate portal pages alone.
  'paycomonline.net',
];

/**
 * The candidate sign-in hosts under each domain of AUTOFILL_SIGN_IN_HOST_SUFFIXES, as patterns over the whole host:
 * - Workday: a tenant's host, `<tenant>.wd<n>.myworkdayjobs.com` (or `myworkdaysite.com`; the tenant may sit directly
 *   below the domain on older sites), never `www`; `wd<n>.myworkdaysite.com`, which serves every tenant on it (the
 *   tenant in the path), is one host, so one sign-in saved for it covers all of them;
 * - iCIMS: a company's portal, `careers-<company>.icims.com` or `<company>.icims.com`, never `www`, `api` or `login`;
 *   and (version 5) `login.icims.com`, iCIMS's own sign-in ("Log back in" sends every portal's candidate there);
 * - Taleo: a company's portal, `<company>.taleo.net`, never `www` or `tbe`; and (version 5) a Taleo Business Edition
 *   portal, `<company>.tbe.taleo.net`;
 * - SuccessFactors: the career sites alone, `career<n>.successfactors.com` / `.eu` (`career`, `career2`, `career012`);
 * - Oracle Recruiting Cloud: a Fusion Applications tenant, `<tenant>.fa.<region>.oraclecloud.com` (`.fa.ocs.`
 *   included) or (version 5) `<tenant>.fa.oraclecloud.com` with no region (JPMC's), never Object Storage or another
 *   Oracle Cloud service; and (version 6) a tenant on Oracle's government cloud, `<tenant>.fa.ocs.oraclegovcloud.com`,
 *   by the same tenant rule (the whole tenant host, as the commercial cloud's);
 * - SmartRecruiters: `jobs.smartrecruiters.com` and `careers.smartrecruiters.com`;
 * - (version 6) UltiPro: `recruiting.ultipro.com`, UKG Pro Recruiting's candidate host (its account step is there);
 *   and (jr7 7a, additive within version 6: the owner's snapshot7 of 2026-11-11) its other candidate-only recruiting
 *   hosts, `recruiting2.ultipro.com` and `recruiting.ultipro.ca`, whose account step is theirs too; never another
 *   `<n>.ultipro.com` or `ultipro.ca` host, an employer's UKG Pro for its staff.
 */
const SIGN_IN_HOSTS: readonly RegExp[] = [
  /^(?!www\.)[a-z0-9-]+(?:\.wd\d{1,3})?\.myworkday(?:jobs|site)\.com$/,
  /^(?!(?:www|api|login)\.)[a-z0-9-]+\.icims\.com$/,
  /^login\.icims\.com$/,
  /^(?!(?:www|tbe)\.)[a-z0-9-]+\.taleo\.net$/,
  /^[a-z0-9-]+\.tbe\.taleo\.net$/,
  /^career\d{0,3}\.successfactors\.(?:com|eu)$/,
  /^[a-z0-9-]+\.fa(?:\.[a-z0-9-]+)?\.oraclecloud\.com$/,
  /^(?:jobs|careers)\.smartrecruiters\.com$/,
  /^[a-z0-9-]+\.fa\.ocs\.oraclegovcloud\.com$/,
  /^recruiting2?\.ultipro\.com$/,
  /^recruiting\.ultipro\.ca$/,
];

/**
 * Version 6: the candidate sign-in hosts that also serve an employer's employee pages, each covered under its candidate
 * paths alone (compared as written, as Chrome's match patterns and the extension's host list compare them), never on
 * any other path of the host:
 * - ADP Workforce Now: `workforcenow.adp.com` under `/mascsr/default/mdf/recruitment/` (the guest page, whose Continue
 *   mails the code) and `/mascsr/applicant/mdf/recruitment/` (the application's steps);
 * - ClearCompany: a tenant's host, `<tenant>.clearcompany.com`, never its `cc-` file hosts or `www`, under `/careers/`
 *   (the application's account step);
 * - (jr7, version 7) Paycom: `www.paycomonline.net`, whose employee pages (/v4/ee/, /v4/cl/) share the host, at its
 *   candidate portal's two pages alone, matched whole (`pattern`, anchored): a posting,
 *   /v4/ats/web.php/portal/<client key: 32 hexadecimal digits>/jobs/<n>, where Apply opens the contact dialog whose
 *   "Continue To Application" makes the candidate's account (pressed on Sign-in Auto alone), and the application page,
 *   …/portal/<client key>/applications; one trailing slash allowed, as the extension's host list reads them.
 */
const SIGN_IN_PATH_HOSTS: ReadonlyArray<{ host: RegExp; paths: readonly string[]; pattern?: RegExp }> = [
  { host: /^workforcenow\.adp\.com$/, paths: ['/mascsr/default/mdf/recruitment/', '/mascsr/applicant/mdf/recruitment/'] },
  { host: /^(?!(?:cc-|www\.))[a-z0-9-]+\.clearcompany\.com$/, paths: ['/careers/'] },
  {
    host: /^www\.paycomonline\.net$/,
    paths: [],
    pattern: /^\/v4\/ats\/web\.php\/portal\/[A-Fa-f0-9]{32}\/(?:jobs\/\d{1,15}|applications)\/?$/,
  },
];

/** The longest page path a credential request names (version 6). */
export const AUTOFILL_SIGN_IN_PATH_MAX = 2048;

/**
 * Whether a page's path is one a candidate path can be read from: '/' first, no query or fragment, no backslash, space
 * or control character, no dot segment ('.', '..') and no percent-encoded dot, slash or backslash (which a server may
 * read as one).
 */
function plainPath(path: string): boolean {
  if (path.length > AUTOFILL_SIGN_IN_PATH_MAX || !path.startsWith('/')) return false;
  if (/[?#\\\s\p{Cc}]/u.test(path) || /%(?:2e|2f|5c)/i.test(path)) return false;
  return !path.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * True when the every-site sign-in covers a page on `host` (a host name, compared in lower case): a candidate sign-in
 * host of one of AUTOFILL_SIGN_IN_HOST_SUFFIXES' domains, by SIGN_IN_HOSTS' patterns; or (version 6) one of
 * SIGN_IN_PATH_HOSTS whose candidate paths `path` (the page's path: its pathname alone) is under, or (version 7,
 * Paycom) whose candidate page pattern it matches whole. Such a host is never covered without a path, nor for a path
 * that is not plain (plainPath): no employee page is ever covered.
 */
export function signInHostCovered(host: string, path?: string): boolean {
  const name = host.toLowerCase();
  if (SIGN_IN_HOSTS.some((pattern) => pattern.test(name))) return true;
  const scoped = SIGN_IN_PATH_HOSTS.find((rule) => rule.host.test(name));
  if (scoped === undefined || path === undefined || !plainPath(path)) return false;
  return scoped.paths.some((prefix) => path.startsWith(prefix)) || (scoped.pattern?.test(path) ?? false);
}

/** Caps: the email, the password, and the sign-ins an account may save. */
export const AUTOFILL_SIGN_IN_LIMITS = { email: 254, password: 256, saved: 50 } as const;

/** A sign-in's site: `*` (every site) or one host name ("acme.wd5.myworkdayjobs.com"). */
export const AutofillSignInHostSchema = z.union([z.literal(AUTOFILL_ANY_HOST), HostNameSchema]);

/** A sign-in's id: TailorIT's random UUID in lower case. */
export const AutofillSignInIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const EmailSchema = z.email('Enter a valid email address').max(AUTOFILL_SIGN_IN_LIMITS.email, 'Use at most 254 characters');
/** As typed: never trimmed or changed; no line break. */
const PasswordSchema = z
  .string()
  .min(1, 'Enter the password')
  .max(AUTOFILL_SIGN_IN_LIMITS.password, 'Use at most 256 characters')
  .regex(/^[^\r\n]*$/, 'A password has no line break');

/**
 * GET /api/autofill/credentials?host=&path= (scope credentials:read): the page's host name, exactly as the page has it,
 * and (version 6, optional) its path, the pathname alone (no query, no fragment), which the every-site sign-in needs on
 * a host it covers by its candidate paths (ADP Workforce Now, ClearCompany: signInHostCovered). TailorIT never stores or
 * logs the path.
 */
export const AutofillCredentialQuerySchema = z.object({
  host: HostNameSchema,
  path: z
    .string()
    .max(AUTOFILL_SIGN_IN_PATH_MAX)
    .regex(/^\/[^?#\s]*$/, "A page's path, from its first '/', with no query or fragment")
    .optional(),
});
export type AutofillCredentialQuery = z.infer<typeof AutofillCredentialQuerySchema>;

/**
 * Its answer (Cache-Control: no-store): the sign-in saved for that host, else, for a page signInHostCovered covers (by
 * its host, and on a path-scoped host by `path`), the one for every site (`host` says which); 404 `not_found`
 * otherwise. The extension keeps it in memory for one sign-in and never stores it.
 */
export const AutofillCredentialSchema = z.object({
  host: AutofillSignInHostSchema,
  email: EmailSchema,
  password: PasswordSchema,
});
export type AutofillCredential = z.infer<typeof AutofillCredentialSchema>;

/** One saved sign-in on Settings › Autofill: never its password. */
export const AutofillSignInItemSchema = z.object({
  id: AutofillSignInIdSchema,
  host: AutofillSignInHostSchema,
  email: z.string(),
  updatedAt: InstantSchema,
  /** The site the extension last read it for (the host it asked with), and when; null until it is first read. */
  lastReadHost: z.string().nullable(),
  lastReadAt: InstantSchema.nullable(),
});
export type AutofillSignInItem = z.infer<typeof AutofillSignInItemSchema>;

/** GET /api/autofill/sign-ins (the Settings page only): every site's sign-in, `*` first, then by host. */
export const AutofillSignInListSchema = z.object({
  items: z.array(AutofillSignInItemSchema),
  total: z.number().int().nonnegative(),
  /** AUTOFILL_SIGN_IN_LIMITS.saved. */
  limit: z.number().int().positive(),
});
export type AutofillSignInList = z.infer<typeof AutofillSignInListSchema>;

/**
 * PUT /api/autofill/sign-ins (the Settings page only): saves the sign-in for `host`, replacing the one there. Without
 * `password` the saved password is kept (an email changed alone); a new host needs one (400). 409 `conflict` past
 * AUTOFILL_SIGN_IN_LIMITS.saved. Answers the item (no password). DELETE /api/autofill/sign-ins/:id removes one (204;
 * 404 for another account's or none).
 */
export const PutAutofillSignInBodySchema = z.object({
  host: AutofillSignInHostSchema,
  email: EmailSchema,
  password: PasswordSchema.optional(),
});
export type PutAutofillSignInBody = z.infer<typeof PutAutofillSignInBodySchema>;
