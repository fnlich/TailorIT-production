import { z } from 'zod';

// The small types every autofill schema shares. This folder is TailorIT's contract with its browser extension,
// TailorIT Autofill, which copies the non-test files byte for byte into its own repository: so they import only zod
// and each other, touch no Node or DOM API (URL is reached through a guarded globalThis cast), and use plain z.object,
// which strips unknown keys, so a new optional field breaks neither side.

/** ISO 3166-1 alpha-2, upper case ("US", "GB"). */
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code, like US');
/** A month ("2021-09") or, when only the year is known, a year ("2021"). */
export const YearMonthSchema = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, 'Use the format YYYY-MM or YYYY');
export const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use the format YYYY-MM-DD');
/** An ISO-8601 UTC timestamp, as the server writes them ("2026-10-22T12:00:00.000Z"). */
export const InstantSchema = z.iso.datetime();
/** '' or an http(s) link. */
export const WebUrlSchema = z.union([
  z.literal(''),
  z
    .string()
    .max(300, 'Use at most 300 characters')
    .regex(/^https?:\/\/\S+$/i, 'Enter a link that starts with https://'),
]);
export const textOf = (max: number) => z.string().max(max, `Use at most ${max} characters`);

/**
 * A site's host name as `location.hostname` writes it (version 3): lower-case letters, digits and hyphens in labels of
 * at most 63 characters, joined by dots, at most 253 in all ("acme.wd5.myworkdayjobs.com"). No scheme, port, path or
 * query: a request that names a site never carries more of its address.
 */
export const HostNameSchema = z
  .string()
  .max(253, 'Use at most 253 characters')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    "Enter the site's host name in lower case, like acme.wd5.myworkdayjobs.com",
  );

/** The three states of a sensitive answer; see `sensitive()`. */
export const SENSITIVE_ANSWER_STATES = ['not_provided', 'declined', 'value'] as const;
export type SensitiveAnswerState = (typeof SENSITIVE_ANSWER_STATES)[number];

/**
 * A sensitive answer (work authorization, self-identification, pay, age): never inferred, never logged, never sent
 * to Claude. `not_provided`: leave the question blank and flag it. `declined`: choose the form's "Decline / Prefer not
 * to say" option, else leave it blank. `value`: fill exactly this.
 */
export function sensitive<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('state', [
    z.object({ state: z.literal('not_provided') }),
    z.object({ state: z.literal('declined') }),
    z.object({ state: z.literal('value'), value }),
  ]);
}
export type SensitiveAnswer<T> = { state: 'not_provided' } | { state: 'declined' } | { state: 'value'; value: T };

/**
 * The kinds of form field the extension tells apart: the specification's list plus a lone 'checkbox' (consent, "I
 * currently work here"). Equals the extension's FIELD_KINDS; both repositories' contract tests check it. Used by the
 * AI classification and the saved answers (later phases).
 */
export const AUTOFILL_FIELD_KINDS = [
  'text',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'checkbox-group',
  'combobox',
  'multiselect',
  'typeahead-remote',
  'date',
  'file',
] as const;
export type AutofillFieldKind = (typeof AUTOFILL_FIELD_KINDS)[number];

/**
 * Every non-2xx answer has this body (TailorIT's ApiErrorBody). `code` is kept a string, so a code added later never
 * breaks the extension's parse: it acts on the ones it knows (`not_signed_in`: the token is dead; `ai_busy`: finish
 * polling the task in flight, then retry) and shows `message` for the rest.
 */
export const AutofillErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Per-field messages of a refused body, keyed by the field's path ("profile.name.first"). */
    fields: z.record(z.string(), z.string()).optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
    requestId: z.string().optional(),
    /** Version 9: when a daily limit resets (the closed reports' cap: automatic reports wait until then). */
    resetAt: InstantSchema.optional(),
  }),
});
export type AutofillErrorBody = z.infer<typeof AutofillErrorBodySchema>;
