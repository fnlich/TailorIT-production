import { z } from 'zod';
import { AUTOFILL_FIELD_CATEGORIES } from './ai';
import { AutofillQuestionKeySchema, AutofillSavedOptionSetSchema } from './answers';
import { AUTOFILL_FIELD_KINDS, InstantSchema } from './common';
import {
  AUTOFILL_LOOKUP_URL_MAX,
  AutofillFromPageRequestSchema,
  AutofillLookupRequestSchema,
  AutofillLookupResponseSchema,
} from './lookup';
import { AUTOFILL_APPLIED_REFUSALS } from './tracker';

// An application form's questions and the answers a person submitted (TailorIT v1.3, additive within API version 6:
// two new routes and the lookup's optional `formKnown`, under scopes every connection already has).
//
// - POST /api/autofill/submissions (tracker:write), once the site confirmed the Submit: what POST /api/autofill/applied
//   does (the job's tracker entry at Applied), and, in the same transaction, the form's questions kept for the job and
//   this person's answers kept for this application, replacing the ones a submission kept before. A posting TailorIT
//   shares with no one yet is offered to the shared jobs: the person's own job made from a page joins its page
//   review in Admin › Review (v3.0: shared once an admin approves it), and a posting TailorIT lacks is added (read from
//   its ATS as POST /api/autofill/jobs reads one, else made from the `posting` text the person saw, as POST
//   /api/autofill/jobs/from-page makes one, the person's own and offered for review the same way).
// - POST /api/autofill/forms/known (jobs:lookup): the job's questions as TailorIT keeps them, and this person's earlier
//   answers (the same job's; and, for questions that are no self-identification, legal, pay, consent or attention
//   check, the latest answer to the same question and option set on another job), so a form fills before any AI.
//
// Questions are shared by every account and shown on no Jobs route or page; answers are the person's own, shown only
// to them (the Tracker's "Submitted answers" tab), and never sent to an AI by TailorIT. No value is ever logged. A
// question names its options by their labels, never their values or positions; a file field's answer is the attached
// file's name alone, never its content. Never sent at all: passwords, CAPTCHAs, honeypots and hidden fields, and any
// field a canary or tripwire touched.

/** The caps of the two routes' bodies. */
export const AUTOFILL_FORM_LIMITS = {
  /** Questions in one submission. */
  questions: 300,
  /** A question's `ref`: the extension's own field key. */
  ref: 300,
  label: 500,
  section: 200,
  /** Options of one question, and of one submission in all. */
  options: 500,
  optionsTotal: 10_000,
  optionLabel: 300,
  /** A written answer. */
  text: 10_000,
  /** Options chosen in one answer. */
  chosen: 50,
  fileName: 255,
  /** The highest step (0 for a one-page form) and position. */
  step: 99,
  position: 9999,
  /** The questions TailorIT keeps for one job's form, the most a known-form answer holds. */
  storedQuestions: 1000,
  /** The questions a known-form request names (its `fields`). */
  fields: 300,
} as const;

/**
 * Where an answer came from, as the extension's report names a fill (its PROVENANCES), plus `submitted-before` (a
 * previous submission's answer, from POST /api/autofill/forms/known) and `person` (typed or changed by the person).
 * v1.5 (additive): a ready answer of the person's prepared kit (forms/known's `drafts`), named `prebuilt` until version
 * 8 and `prepared` since (v2.0's Prepare & Queue).
 */
export const AUTOFILL_ANSWER_PROVENANCES = [
  'profile',
  'saved',
  'rule',
  'llm-pick',
  'llm-draft',
  'llm-answer',
  'submitted-before',
  'person',
  // v1.5 P; version 8 renamed it from 'prebuilt'
  'prepared',
  // end v1.5 P
] as const;
export type AutofillAnswerProvenance = (typeof AUTOFILL_ANSWER_PROVENANCES)[number];

/** How TailorIT came to know a question: a person's submission, or (Greenhouse) the board's public API. */
export const AUTOFILL_QUESTION_SOURCES = ['submission', 'ats-api'] as const;
export type AutofillQuestionSource = (typeof AUTOFILL_QUESTION_SOURCES)[number];

const OptionLabelSchema = z.string().min(1).max(AUTOFILL_FORM_LIMITS.optionLabel);
/**
 * A label or a heading as one line, wherever it is shown: every run of spaces, line breaks and control characters is
 * one space, none at either end (folded, never refused: a label on two lines must not cost the submission).
 */
const oneLine = (text: string) => text.replace(/[\p{Cc}\s]+/gu, ' ').trim();

/**
 * One question of the form as the person saw it. `ref` is the extension's own key of the field (unique in the body;
 * the answers name it). `questionKey` is its normalizeLabel of the label (as a saved answer's), `optionSetHash` its
 * hash of the usable options ('' for a field without options), `options` their labels as shown. `section` is the
 * form section's heading, `step` the page of a multi-step form (0 for a one-page form) and `position` the field's order
 * on it. `category` is the extension's classification, never shown: TailorIT screens answers with it.
 */
export const AutofillFormQuestionSchema = z
  .object({
    ref: z.string().min(1).max(AUTOFILL_FORM_LIMITS.ref),
    questionKey: AutofillQuestionKeySchema,
    label: z.string().overwrite(oneLine).min(1).max(AUTOFILL_FORM_LIMITS.label),
    kind: z.enum(AUTOFILL_FIELD_KINDS),
    options: z.array(OptionLabelSchema).max(AUTOFILL_FORM_LIMITS.options).default([]),
    optionSetHash: AutofillSavedOptionSetSchema,
    section: z.string().overwrite(oneLine).max(AUTOFILL_FORM_LIMITS.section).default(''),
    required: z.boolean().default(false),
    step: z.number().int().min(0).max(AUTOFILL_FORM_LIMITS.step).default(0),
    position: z.number().int().min(0).max(AUTOFILL_FORM_LIMITS.position),
    category: z.enum(AUTOFILL_FIELD_CATEGORIES).nullable().default(null),
  })
  .superRefine((question, ctx) => {
    if (question.options.length > 0 && question.optionSetHash === '') {
      ctx.addIssue({ code: 'custom', path: ['optionSetHash'], message: 'A field with options has their hash' });
    }
  });
export type AutofillFormQuestion = z.infer<typeof AutofillFormQuestionSchema>;

/**
 * A submitted answer: a text, the chosen options' labels (never their values or positions), a checkbox's state, or,
 * for a file field, the attached file's name alone (never its content or path).
 */
export const AutofillSubmittedAnswerValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z
      .string()
      .max(AUTOFILL_FORM_LIMITS.text, `Use at most ${AUTOFILL_FORM_LIMITS.text} characters`)
      .refine((text) => text.trim() !== '', 'Write the answer'),
  }),
  z.object({
    kind: z.literal('options'),
    labels: z
      .array(OptionLabelSchema)
      .min(1)
      .max(AUTOFILL_FORM_LIMITS.chosen)
      .refine((labels) => new Set(labels).size === labels.length, 'Each option once'),
  }),
  z.object({ kind: z.literal('checked'), checked: z.boolean() }),
  z.object({
    kind: z.literal('file'),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(AUTOFILL_FORM_LIMITS.fileName)
      .regex(/^[^\p{Cc}/\\]*$/u, "The file's name alone, without a folder"),
  }),
]);
export type AutofillSubmittedAnswerValue = z.infer<typeof AutofillSubmittedAnswerValueSchema>;

const ONE_OPTION = ['select', 'radio', 'combobox', 'typeahead-remote'] as const;
const SEVERAL_OPTIONS = ['checkbox-group', 'multiselect'] as const;
const TYPED = ['text', 'textarea', 'date'] as const;

/** Whether a submitted answer of this shape can be given through a field of this kind. */
export function submittedAnswerFits(
  answer: AutofillSubmittedAnswerValue,
  kind: (typeof AUTOFILL_FIELD_KINDS)[number],
): boolean {
  switch (answer.kind) {
    case 'text':
      return (TYPED as readonly string[]).includes(kind);
    case 'options':
      return (
        (SEVERAL_OPTIONS as readonly string[]).includes(kind) ||
        ((ONE_OPTION as readonly string[]).includes(kind) && answer.labels.length === 1)
      );
    case 'checked':
      return kind === 'checkbox';
    case 'file':
      return kind === 'file';
  }
}

/** One answer of the submission: the question's `ref`, the answer, and where it came from. */
export const AutofillSubmissionAnswerSchema = z.object({
  ref: z.string().min(1).max(AUTOFILL_FORM_LIMITS.ref),
  answer: AutofillSubmittedAnswerValueSchema,
  provenance: z.enum(AUTOFILL_ANSWER_PROVENANCES).nullable().default(null),
});
export type AutofillSubmissionAnswer = z.infer<typeof AutofillSubmissionAnswerSchema>;

/**
 * The posting as the page showed it (POST /api/autofill/jobs/from-page's fields): TailorIT makes the shared job from
 * it only when it has no job of the posting and no ATS API gives it one.
 */
export const AutofillSubmissionPostingSchema = AutofillFromPageRequestSchema.pick({
  title: true,
  company: true,
  location: true,
  description: true,
  criteria: true,
});
export type AutofillSubmissionPosting = z.infer<typeof AutofillSubmissionPostingSchema>;

/** One of `url` and `jobId`, as the lookup and POST /api/autofill/applied take them. */
function namesPageOrJob(request: { url?: string | undefined; jobId?: number | undefined }, ctx: z.RefinementCtx): void {
  if (request.url === undefined && request.jobId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Name the page or the job' });
  }
}

/**
 * POST /api/autofill/submissions (scope tracker:write), sent once the site confirmed the Submit. The job is found as
 * POST /api/autofill/applied finds it (`jobId`, else the job the lookup finds at `url` and `employerUrl`); TailorIT's
 * job of a posting it lacks is added (with jobs:add, or the session) from its ATS, else from `posting`; and a job the
 * person made from a page is offered to the shared jobs (v3.0: through its page review, shared once approved). The
 * entry moves to Applied as /applied moves it. `questions` are every question the form asked (each step's, as the
 * person left it), kept for the job: a question TailorIT lacks is added, none is deleted. `answers` are the person's,
 * each naming its question's `ref` (one answer a question at most; a ref no question has is refused): they replace the
 * answers kept for this application, every question of the body kept
 * with its answer or as not answered. Absent when the person's "Keep my submitted answers in TailorIT" is off: then
 * only the questions are kept, and the answers kept before stay as they were. A 400 changes nothing: send POST
 * /api/autofill/applied then, so the application is still marked.
 */
export const AutofillSubmissionRequestSchema = z
  .object({
    url: z.string().min(1).max(AUTOFILL_LOOKUP_URL_MAX).optional(),
    jobId: z.number().int().positive().optional(),
    employerUrl: AutofillLookupRequestSchema.shape.employerUrl,
    /** The resume the form was sent with, as /applied takes it. */
    resumeId: AutofillLookupRequestSchema.shape.resumeId,
    posting: AutofillSubmissionPostingSchema.optional(),
    questions: z.array(AutofillFormQuestionSchema).max(AUTOFILL_FORM_LIMITS.questions),
    answers: z.array(AutofillSubmissionAnswerSchema).max(AUTOFILL_FORM_LIMITS.questions).optional(),
  })
  .superRefine((request, ctx) => {
    namesPageOrJob(request, ctx);
    const kinds = new Map<string, (typeof AUTOFILL_FIELD_KINDS)[number]>();
    let options = 0;
    request.questions.forEach((question, index) => {
      if (kinds.has(question.ref)) ctx.addIssue({ code: 'custom', path: ['questions', index, 'ref'], message: 'Each ref once' });
      kinds.set(question.ref, question.kind);
      options += question.options.length;
    });
    if (options > AUTOFILL_FORM_LIMITS.optionsTotal) {
      ctx.addIssue({ code: 'custom', path: ['questions'], message: `At most ${AUTOFILL_FORM_LIMITS.optionsTotal} options in all` });
    }
    const answered = new Set<string>();
    request.answers?.forEach((item, index) => {
      const kind = kinds.get(item.ref);
      if (kind === undefined) {
        ctx.addIssue({ code: 'custom', path: ['answers', index, 'ref'], message: 'No question of the body has this ref' });
      } else if (answered.has(item.ref)) {
        ctx.addIssue({ code: 'custom', path: ['answers', index, 'ref'], message: 'One answer a question' });
      } else if (!submittedAnswerFits(item.answer, kind)) {
        ctx.addIssue({ code: 'custom', path: ['answers', index, 'answer'], message: 'This answer does not fit the field' });
      }
      answered.add(item.ref);
    });
  });
export type AutofillSubmissionRequest = z.infer<typeof AutofillSubmissionRequestSchema>;

/**
 * What the submission did to the job: `shared`, a job TailorIT already shared; `offered`, the person's own job made
 * from a page, offered to the shared jobs (its page review holds the person's report; it stays theirs, and is shared
 * only once an admin approves it); `added`, a posting TailorIT lacked, added now (read from its ATS, or the person's own
 * page job made from `posting` and offered the same way); `none`, no job (an entry the person added by hand was moved:
 * the questions are kept under the posting when the page names one).
 * Version 9 (v30 FIX-B, INT-3 open item 12): `offered` replaces v1.3's `promoted`, which said the job was shared while
 * it waits for an admin. A version 8 extension is refused (409) before any answer, so none reads the old word.
 */
export const AUTOFILL_SUBMISSION_JOB_STATES = ['shared', 'offered', 'added', 'none'] as const;
export type AutofillSubmissionJobState = (typeof AUTOFILL_SUBMISSION_JOB_STATES)[number];

/**
 * POST /api/autofill/submissions' answer (200): the lookup's answer for the same address, job and resume, as /applied
 * answers it; what happened to the job; how many of the body's questions were new to TailorIT and how many it keeps for
 * the form now (0 and 0 when it keeps none: no job and no posting to keep them under); and how many answers it kept
 * for the application (null when the body had no `answers`).
 */
export const AutofillSubmissionResponseSchema = z.object({
  lookup: AutofillLookupResponseSchema,
  job: z.enum(AUTOFILL_SUBMISSION_JOB_STATES),
  questionsAdded: z.number().int().nonnegative(),
  questionsKnown: z.number().int().nonnegative(),
  answersKept: z.number().int().nonnegative().nullable(),
});
export type AutofillSubmissionResponse = z.infer<typeof AutofillSubmissionResponseSchema>;

/**
 * What POST /api/autofill/submissions refuses with: POST /api/autofill/applied's refusals (adding the job may read its
 * ATS), besides every token route's (401, 403, 409 `conflict` for another API version, 429).
 */
export const AUTOFILL_SUBMISSION_REFUSALS = AUTOFILL_APPLIED_REFUSALS;

/** A question the page shows, by the key and option set it would be kept under. */
export const AutofillFormFieldKeySchema = z.object({
  questionKey: AutofillQuestionKeySchema,
  optionSetHash: AutofillSavedOptionSetSchema,
});
export type AutofillFormFieldKey = z.infer<typeof AutofillFormFieldKeySchema>;

/**
 * POST /api/autofill/forms/known (scope jobs:lookup; the answers need profile:read too, and a same-job answer to a
 * self-identification, legal or pay question profile:sensitive): the job is `jobId`, else the one the lookup finds at
 * `url` and `employerUrl` (a posting with no job may still have questions kept under it). `fields`, the questions the
 * page shows, adds this person's other-job answers to them, for a form TailorIT keeps no questions of yet.
 */
export const AutofillFormsKnownRequestSchema = z
  .object({
    url: z.string().min(1).max(AUTOFILL_LOOKUP_URL_MAX).optional(),
    jobId: z.number().int().positive().optional(),
    employerUrl: AutofillLookupRequestSchema.shape.employerUrl,
    fields: z.array(AutofillFormFieldKeySchema).max(AUTOFILL_FORM_LIMITS.fields).optional(),
  })
  .superRefine(namesPageOrJob);
export type AutofillFormsKnownRequest = z.infer<typeof AutofillFormsKnownRequestSchema>;

/**
 * A question TailorIT keeps for the job's form, in form order (step, then position). A `submission` question's key and
 * option set are the extension's own; an `ats-api` question (read from Greenhouse's board API) has TailorIT's
 * approximation of the key and no option set (null): compute normalizeLabel(label) and the options' hash to match it.
 * `required` as the form marked it when last seen.
 */
export const AutofillKnownQuestionSchema = z.object({
  id: z.number().int().positive(),
  questionKey: z.string().min(1).max(300),
  label: z.string().min(1).max(AUTOFILL_FORM_LIMITS.label),
  kind: z.enum(AUTOFILL_FIELD_KINDS),
  options: z.array(OptionLabelSchema).max(AUTOFILL_FORM_LIMITS.options),
  optionSetHash: AutofillSavedOptionSetSchema.nullable(),
  section: z.string().max(AUTOFILL_FORM_LIMITS.section),
  required: z.boolean(),
  step: z.number().int().min(0).max(AUTOFILL_FORM_LIMITS.step),
  position: z.number().int().min(0).max(AUTOFILL_FORM_LIMITS.position),
  source: z.enum(AUTOFILL_QUESTION_SOURCES),
  firstSeenAt: InstantSchema,
  lastSeenAt: InstantSchema,
});
export type AutofillKnownQuestion = z.infer<typeof AutofillKnownQuestionSchema>;

/** Whose earlier answer it is: this job's (a re-apply), or another job's to the same question and option set. */
export const AUTOFILL_KNOWN_ANSWER_MATCHES = ['sameJob', 'otherJob'] as const;
export type AutofillKnownAnswerMatch = (typeof AUTOFILL_KNOWN_ANSWER_MATCHES)[number];

/**
 * One of this person's earlier answers. `sameJob`: their answer to one of this job's questions (`questionId`, from
 * `questions`). `otherJob`: their latest answer to the same question key and option set on another job (`questionId`
 * null), never to a self-identification, legal, pay, consent or attention-check question, and never a file. Fill it
 * with the provenance `submitted-before`, and flag it when the field's options no longer hold it.
 */
export const AutofillKnownAnswerSchema = z.object({
  match: z.enum(AUTOFILL_KNOWN_ANSWER_MATCHES),
  questionId: z.number().int().positive().nullable(),
  questionKey: z.string().min(1).max(300),
  optionSetHash: AutofillSavedOptionSetSchema,
  questionLabel: z.string().min(1).max(AUTOFILL_FORM_LIMITS.label),
  fieldKind: z.enum(AUTOFILL_FIELD_KINDS),
  answer: AutofillSubmittedAnswerValueSchema,
  submittedAt: InstantSchema,
});
export type AutofillKnownAnswer = z.infer<typeof AutofillKnownAnswerSchema>;

// v1.5 P
/**
 * v1.5 (Prebuild, additive within API 6): a prebuilt draft answer's state. `ready`: TailorIT's AI (or the person's own
 * AI, through TailorIT's MCP server) prepared it ahead of time, and it can be filled as it is. `not_ready`: it could not
 * be prepared (Claude gave none, or the field is one the AI never answers ahead, such as a checkbox group): it is made
 * during auto-apply or the fill, by the extension's own path, as before.
 */
export const AUTOFILL_DRAFT_ANSWER_STATUSES = ['ready', 'not_ready'] as const;
export type AutofillDraftAnswerStatus = (typeof AUTOFILL_DRAFT_ANSWER_STATUSES)[number];

/** Who prepared a draft answer: TailorIT's AI (`server-ai`), or the person's own AI through the MCP server (`mcp`). */
export const AUTOFILL_DRAFT_PROVENANCES = ['server-ai', 'mcp'] as const;
export type AutofillDraftProvenance = (typeof AUTOFILL_DRAFT_PROVENANCES)[number];

/**
 * v1.5: one answer of this person's prebuilt application draft for the job (Prebuild on TailorIT's Auto-apply page):
 * always `match: 'draft'`, always one of `questions` (`questionId`), and only ever the person's own. A `ready` one has
 * its `answer` (a text, the chosen options' labels, or a checkbox's state; never a file); a `not_ready` one has none
 * (null) and is answered during the fill as before. A draft never answers a self-identification, legal, pay, consent,
 * attention-check or file question: the profile fills those. Fill a ready one with the provenance `prepared`, below the
 * profile, a saved answer and the person's own earlier answer to this job, and flag it when the field's options no
 * longer hold it.
 */
export const AutofillDraftAnswerSchema = z
  .object({
    match: z.literal('draft'),
    questionId: z.number().int().positive(),
    questionKey: z.string().min(1).max(300),
    optionSetHash: AutofillSavedOptionSetSchema.nullable(),
    questionLabel: z.string().min(1).max(AUTOFILL_FORM_LIMITS.label),
    fieldKind: z.enum(AUTOFILL_FIELD_KINDS),
    status: z.enum(AUTOFILL_DRAFT_ANSWER_STATUSES),
    answer: AutofillSubmittedAnswerValueSchema.nullable(),
    provenance: z.enum(AUTOFILL_DRAFT_PROVENANCES),
    preparedAt: InstantSchema,
  })
  .superRefine((draft, ctx) => {
    if ((draft.status === 'ready') !== (draft.answer !== null)) {
      ctx.addIssue({ code: 'custom', path: ['answer'], message: 'A ready answer has its answer; a not-ready one has none' });
    }
    if (draft.answer?.kind === 'file') {
      ctx.addIssue({ code: 'custom', path: ['answer'], message: 'A draft never answers a file field' });
    }
  });
export type AutofillDraftAnswer = z.infer<typeof AutofillDraftAnswerSchema>;
// end v1.5 P

/**
 * POST /api/autofill/forms/known's answer (200): the job found (null when none: the questions are then the posting's,
 * when TailorIT keeps any), its questions, and this person's earlier answers (none without profile:read). Empty lists
 * when TailorIT keeps nothing; never 404 for a page it has no job of. v1.5 (additive): `drafts`, this person's
 * prebuilt draft answers for the job's questions (AutofillDraftAnswer; none without profile:read, and none when the
 * person has no draft for the job). Kept apart from `answers`, so an extension older than v1.5 reads the rest as
 * before.
 */
export const AutofillFormsKnownResponseSchema = z.object({
  jobId: z.number().int().positive().nullable(),
  questions: z.array(AutofillKnownQuestionSchema).max(AUTOFILL_FORM_LIMITS.storedQuestions),
  answers: z.array(AutofillKnownAnswerSchema).max(AUTOFILL_FORM_LIMITS.storedQuestions + AUTOFILL_FORM_LIMITS.fields),
  // v1.5 P
  drafts: z.array(AutofillDraftAnswerSchema).max(AUTOFILL_FORM_LIMITS.storedQuestions).optional(),
  // end v1.5 P
});
export type AutofillFormsKnownResponse = z.infer<typeof AutofillFormsKnownResponseSchema>;

/** What POST /api/autofill/forms/known refuses with: `validation_failed` and `not_found` (a `jobId` TailorIT lacks). */
export const AUTOFILL_FORMS_KNOWN_REFUSALS = { validation_failed: 400, not_found: 404 } as const;
