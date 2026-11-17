import { z } from 'zod';
import { AUTOFILL_FIELD_CATEGORIES, OptionSetHashSchema } from './ai';
import { InstantSchema } from './common';
import { ATS_KINDS } from './lookup';

// Saved answers (Requirement F): when the person fixes or fills a field the extension flagged, it offers to save the
// answer, and the next form asking the same question with the same options gets it, before any rule. TailorIT keeps
// them per account (GET, PUT and DELETE /api/autofill/answers); the extension reads them with the profile, once per
// run, into its worker's memory, and Settings › Autofill › Saved answers lists, edits and deletes them.
//
// A saved answer's key is the question (the extension's normalized label), the option set the form showed with it
// ('' for a field without options) and a scope: '' for every company, or '<platform>:<board>' for one company, which
// only a free-text answer has ("Why do you want to work here?"). The answer is the options' labels, never their
// positions, a text, or a checkbox's state. Never saved: a file, and the self-identification, legal, pay, consent and
// attention-check questions, which live in the autofill profile or are the person's own each time (400).

/** The field kinds a saved answer may be for: every kind but `file`. */
export const AUTOFILL_SAVED_ANSWER_FIELD_KINDS = [
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
] as const;
export type AutofillSavedAnswerFieldKind = (typeof AUTOFILL_SAVED_ANSWER_FIELD_KINDS)[number];

/** The caps of a saved answer, and how many an account keeps (409 `conflict` past it). */
export const AUTOFILL_SAVED_ANSWER_LIMITS = {
  perAccount: 500,
  questionKey: 300,
  questionLabel: 300,
  scope: 250,
  board: 200,
  text: 5000,
  labels: 50,
  label: 300,
} as const;

/**
 * The categories (the classification's) whose answers are never saved: they live only in the autofill profile, or are
 * the person's own each time. TailorIT also refuses any question whose words name a sensitive topic or look like an
 * attention check, whatever its category says (its AI steps' screen).
 */
export const AUTOFILL_UNSAVED_CATEGORIES = [
  'sensitive_eeo',
  'sensitive_legal',
  'sensitive_compensation',
  'consent',
  'attention_check',
] as const;

/**
 * What the saved-answer routes refuse with, besides every token route's refusals (401, 403, 409 `conflict` for another
 * API version, 429): `validation_failed` (a body over a cap, a file, a sensitive, consent or attention-check question),
 * `not_found` (DELETE of an answer that is not the account's) and `conflict` (PUT of a new answer past
 * AUTOFILL_SAVED_ANSWER_LIMITS.perAccount).
 */
export const AUTOFILL_SAVED_ANSWER_REFUSALS = { validation_failed: 400, not_found: 404, conflict: 409 } as const;

/** A saved answer's id: TailorIT's random UUID in lower case (DELETE /api/autofill/answers/:id). */
export const AutofillSavedAnswerIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The question as the extension keys it (its normalizeLabel): one line, no space at either end. */
export const AutofillQuestionKeySchema = z
  .string()
  .min(1)
  .max(AUTOFILL_SAVED_ANSWER_LIMITS.questionKey)
  .regex(/^[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u, 'One line, with no space at either end');

/** The option set the answer was saved under: the observed hash, or '' for a field without options. */
export const AutofillSavedOptionSetSchema = z.union([z.literal(''), OptionSetHashSchema]);

/** '<platform>:<board>': the company a free-text answer was written for, as the lookup names its board. */
const COMPANY_SCOPE = new RegExp(`^(?:${ATS_KINDS.join('|')}):\\S{1,${AUTOFILL_SAVED_ANSWER_LIMITS.board}}$`);

/** '' for every company; '<platform>:<board>' ("greenhouse:northwind") for one company, a free-text answer only. */
export const AutofillSavedAnswerScopeSchema = z.union([
  z.literal(''),
  z.string().max(AUTOFILL_SAVED_ANSWER_LIMITS.scope).regex(COMPANY_SCOPE, 'Use <platform>:<board>'),
]);

/** The platform a scope names, or null for every company. */
export function platformOfScope(scope: string): (typeof ATS_KINDS)[number] | null {
  const platform = scope.slice(0, Math.max(0, scope.indexOf(':')));
  return (ATS_KINDS as readonly string[]).includes(platform) ? (platform as (typeof ATS_KINDS)[number]) : null;
}

/** The answer itself: the chosen options' labels as the form shows them (never their positions), a text, or a
 *  checkbox's state. */
export const AutofillSavedAnswerValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z
      .string()
      .max(AUTOFILL_SAVED_ANSWER_LIMITS.text, `Use at most ${AUTOFILL_SAVED_ANSWER_LIMITS.text} characters`)
      .refine((text) => text.trim() !== '', 'Write the answer'),
  }),
  z.object({
    kind: z.literal('options'),
    labels: z
      .array(z.string().min(1, 'Required').max(AUTOFILL_SAVED_ANSWER_LIMITS.label))
      .min(1, 'Choose at least one')
      .max(AUTOFILL_SAVED_ANSWER_LIMITS.labels)
      .refine((labels) => new Set(labels).size === labels.length, 'Each option once'),
  }),
  z.object({ kind: z.literal('checked'), checked: z.boolean() }),
]);
export type AutofillSavedAnswerValue = z.infer<typeof AutofillSavedAnswerValueSchema>;

/** The kinds that take one option, and those that take one or more. */
const ONE_OPTION: readonly AutofillSavedAnswerFieldKind[] = ['select', 'radio', 'combobox', 'typeahead-remote'];
const SEVERAL_OPTIONS: readonly AutofillSavedAnswerFieldKind[] = ['checkbox-group', 'multiselect'];
const TYPED: readonly AutofillSavedAnswerFieldKind[] = ['text', 'textarea', 'date'];

/** Whether an answer of this shape can be given through a field of this kind. */
export function answerFitsFieldKind(answer: AutofillSavedAnswerValue, kind: AutofillSavedAnswerFieldKind): boolean {
  switch (answer.kind) {
    case 'text':
      return TYPED.includes(kind);
    case 'options':
      return SEVERAL_OPTIONS.includes(kind) || (ONE_OPTION.includes(kind) && answer.labels.length === 1);
    case 'checked':
      return kind === 'checkbox';
  }
}

const savedAnswerFields = {
  questionKey: AutofillQuestionKeySchema,
  optionSetHash: AutofillSavedOptionSetSchema,
  scope: AutofillSavedAnswerScopeSchema,
  /** Never 'file': a file answer is refused. */
  fieldKind: z.enum(AUTOFILL_SAVED_ANSWER_FIELD_KINDS, 'A file cannot be a saved answer'),
  /** The question as the form showed it, for the Settings list. */
  questionLabel: z.string().min(1, 'Required').max(AUTOFILL_SAVED_ANSWER_LIMITS.questionLabel),
  /** The ATS of the form it was saved on, shown in Settings; a company scope's own. */
  platform: z.enum(ATS_KINDS).nullable(),
  answer: AutofillSavedAnswerValueSchema,
};

/**
 * An answer that fits its field, a company scope only for a free text, and that scope's platform. Checked only when
 * the parts themselves passed, so a refused body names one problem at a time.
 */
function checkSavedAnswer(
  saved: {
    scope: string;
    fieldKind: AutofillSavedAnswerFieldKind;
    platform: string | null;
    answer: AutofillSavedAnswerValue;
  },
  ctx: z.RefinementCtx,
): void {
  const partsPass =
    AutofillSavedAnswerValueSchema.safeParse(saved.answer).success &&
    AutofillSavedAnswerScopeSchema.safeParse(saved.scope).success &&
    (AUTOFILL_SAVED_ANSWER_FIELD_KINDS as readonly string[]).includes(saved.fieldKind);
  if (!partsPass) return;
  if (!answerFitsFieldKind(saved.answer, saved.fieldKind)) {
    ctx.addIssue({ code: 'custom', path: ['answer'], message: 'This answer does not fit the field' });
  } else if (saved.scope !== '' && saved.answer.kind !== 'text') {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Only a written answer is kept for one company' });
  } else if (saved.scope !== '' && saved.platform !== platformOfScope(saved.scope)) {
    ctx.addIssue({ code: 'custom', path: ['platform'], message: "Use the scope's platform" });
  }
}

/** One saved answer, as GET and PUT answer it. */
export const AutofillSavedAnswerSchema = z
  .object({
    id: AutofillSavedAnswerIdSchema,
    ...savedAnswerFields,
    createdAt: InstantSchema,
    /** When it was last saved; of two answers that both apply, the extension takes the later. */
    updatedAt: InstantSchema,
  })
  .superRefine(checkSavedAnswer);
export type AutofillSavedAnswer = z.infer<typeof AutofillSavedAnswerSchema>;

/**
 * GET /api/autofill/answers (the Settings session, or a token with profile:read): every answer of the account, the
 * latest saved first. The extension reads it with GET /api/autofill/profile, once per run.
 */
export const AutofillSavedAnswerListSchema = z.object({
  items: z.array(AutofillSavedAnswerSchema).max(AUTOFILL_SAVED_ANSWER_LIMITS.perAccount),
  total: z.number().int().nonnegative(),
  /** How many the account may keep: AUTOFILL_SAVED_ANSWER_LIMITS.perAccount. */
  limit: z.number().int().positive(),
});
export type AutofillSavedAnswerList = z.infer<typeof AutofillSavedAnswerListSchema>;

/**
 * PUT /api/autofill/answers (the Settings session, or a token with answers:write): saves the answer under its key
 * (question key, option set and scope), replacing the one saved there before; 200 with it as saved. `category` is the
 * extension's classification of the question, never stored: one of AUTOFILL_UNSAVED_CATEGORIES is refused (400), as is
 * a question whose words name a sensitive topic or look like an attention check. A new key past the account's limit
 * is 409 `conflict`.
 */
export const PutAutofillSavedAnswerBodySchema = z
  .object({
    ...savedAnswerFields,
    category: z.enum(AUTOFILL_FIELD_CATEGORIES).nullable().default(null),
  })
  .superRefine(checkSavedAnswer);
export type PutAutofillSavedAnswerBody = z.infer<typeof PutAutofillSavedAnswerBodySchema>;
