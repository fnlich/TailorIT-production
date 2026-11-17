import { z } from 'zod';
import { AUTOFILL_FIELD_KINDS, InstantSchema, type AutofillFieldKind } from './common';
import { ATS_KINDS } from './lookup';

// The AI steps the extension asks TailorIT for, run as tasks on its Claude queue: the tiebreak between options it
// could not choose between (POST /api/autofill/ai/pick), what an unusual question asks (POST …/ai/classify), a draft
// for a free-text question (POST …/ai/draft) and, since version 2, an answer to a question the profile and the
// extension's rules do not settle (POST …/ai/answer). Claude has no authority over a form: a pick answers an option's
// index or null, a classification a category from a closed list or null, a draft capped text, an answer one of the
// item's own option indices or a short capped text, with where it came from. The extension writes drafts and answers
// into the form marked as written by AI, an answer with nothing to go on marked "AI guess". TailorIT checks every
// answer before it stores it, and the extension checks it again against the form as it is then. Page text travels
// only in the fields named for it (labels, options, hints, sections, questions, a draft's current answer, job text,
// the company and job title), which TailorIT quotes to Claude as data, never as instructions; profile text only in a
// pick's intended value and its aliases (the facts of a draft or an answer TailorIT reads itself). Nothing sensitive
// is sent: the extension screens a question before it asks, and TailorIT answers one that still looks sensitive null
// (reason `sensitive`) without asking Claude. An answer request of the `all` scope (the owner's decision of
// 2026-11-01) also asks the legal, criminal-history, pay and attention-check questions the profile leaves open, by
// their text and options alone: the person's sensitive answers never travel, and the self-identification questions,
// the person's own details, another person's and the "I did not use AI" attestations are never asked in any scope.
//
// A route waits up to AUTOFILL_AI_WAIT_MS for its task and answers 200 with the finished task, else 202 {taskId}; the
// extension then polls GET /api/ai/tasks/:id every AUTOFILL_AI_POLL_MS (DELETE on the same path cancels it). The same
// body sent again while its task is queued or running answers that task (TailorIT's dedupe key is the kind and a hash
// of the task's input), never a second one; a finished task is read again by its id, within
// AUTOFILL_TASK_RETENTION_MS, rather than asked again. A token sees only these kinds' tasks: any other id answers 404.

/** The task kinds the extension creates: the first three reserved at once (TailorIT's 0004 rebuilt ai_tasks for
 *  them), `autofill_answer` with version 2 (0005). */
export const AUTOFILL_TASK_KINDS = ['autofill_pick', 'autofill_classify', 'autofill_draft', 'autofill_answer'] as const;
export type AutofillTaskKind = (typeof AUTOFILL_TASK_KINDS)[number];

/** TailorIT's AI_TASK_STATUSES: queued and running are not finished yet; succeeded, failed and cancelled are. */
export const AUTOFILL_TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AutofillTaskStatus = (typeof AUTOFILL_TASK_STATUSES)[number];

/** How long an AI route waits for its task before it answers 202 {taskId}: well under the 30 s Chrome gives a
 *  service worker's fetch. */
export const AUTOFILL_AI_WAIT_MS = 10_000;
/** How often the extension polls a task the route answered 202 for. */
export const AUTOFILL_AI_POLL_MS = 1500;
/** TailorIT deletes an autofill task this long after it finished (its input holds page text): its id then answers
 *  404, and the extension asks again. */
export const AUTOFILL_TASK_RETENTION_MS = 60 * 60_000;
/** Tasks of one kind an account may have queued or running at once (TailorIT's queue rule). Past it a route answers
 *  409 `ai_busy`, so the extension keeps one task in flight per kind and the second place stays free. */
export const AUTOFILL_AI_MAX_ACTIVE_PER_KIND = 2;

/**
 * Every cap of the AI requests and answers. Above any of them TailorIT refuses the whole request (400
 * `validation_failed`), so the extension keeps under them: zod counts code points. `requestText` counts every string
 * in a request together (its JSON is longer still); `classify.text` is reached by cutting with cutAtWord.
 */
export const AUTOFILL_AI_LIMITS = {
  requestText: 100_000,
  /** An item's key: the extension's field key, at most this many code points. */
  key: 300,
  pick: { items: 20, options: 30, aliases: 10, intendedValue: 300, alias: 200, label: 500, optionLabel: 300 },
  classify: { items: 20, options: 20, text: 200 },
  draft: {
    questions: 3,
    question: 1000,
    /** A field whose maxLength is under this gets no draft. */
    minLength: 50,
    /** The longest draft, and the most a question's maxLength may name. */
    maxLength: 5000,
    /** The cap of a question with no maxLength. */
    defaultLength: 3000,
    /** A question's current answer, sent for a rewrite ("Edit with AI"). */
    currentAnswer: 5000,
    /** The person's instruction for a rewrite ("Tell me what to add, change or improve", version 3). */
    instruction: 750,
    jobText: 20_000,
    company: 200,
    jobTitle: 200,
    canaries: 50,
    canary: 200,
  },
  answer: {
    items: 10,
    question: 1000,
    hint: 500,
    section: 200,
    options: 30,
    optionLabel: 300,
    /** The longest written answer, the most a text item's maxLength may name, and the cap of one with none. */
    textMax: 500,
    jobText: 20_000,
    company: 200,
    jobTitle: 200,
    canaries: 50,
    canary: 200,
  },
} as const;

/**
 * The side panel's custom question ("Ask a custom question": Short, Medium, Long), the person's own words about the
 * resume the job card attaches: sent as one draft question (POST …/ai/draft, at most 1000 characters) with the job
 * card's `resumeId`, the posting's visible text or '' and this many characters as its `maxLength`. No task kind of its
 * own; TailorIT refuses a sensitive or attention-check question as it refuses any draft's.
 */
export const AUTOFILL_CUSTOM_QUESTION_LENGTHS = { short: 600, medium: 1500, long: 3000 } as const;

/**
 * What an AI route refuses with, besides every token route's refusals (401, 403, 409 `conflict`, 429), and the status
 * of each: `validation_failed` (a body over a cap, a pick category not in the list), `not_found` (a draft's or an
 * answer's resume),
 * `ai_busy` (finish polling the task in flight, then retry; no Retry-After), `ai_unavailable` (TailorIT's AI is not
 * available now; the message says no more) and, version 8, `ai_usage_exhausted` (the person's AI usage is used up
 * until the daily reset, `retryAfterSeconds`; fill without AI, as for `ai_unavailable`, and show the message once).
 */
export const AUTOFILL_AI_REFUSALS = {
  validation_failed: 400,
  not_found: 404,
  ai_busy: 409,
  ai_usage_exhausted: 429,
  ai_unavailable: 503,
} as const;

/**
 * The `error.code` of a task that did not succeed: `ai_failed` (this request went wrong; asking again may work),
 * `ai_unavailable` (Claude cannot run now), `interrupted` (TailorIT restarted while it ran) and `cancelled` (DELETE
 * /api/ai/tasks/:id). The view keeps the code a string, so a code added later never breaks the extension's parse.
 */
export const AUTOFILL_TASK_ERROR_CODES = ['ai_failed', 'ai_unavailable', 'interrupted', 'cancelled'] as const;
export type AutofillTaskErrorCode = (typeof AUTOFILL_TASK_ERROR_CODES)[number];

/**
 * What a tiebreak may be about: entity names from the profile and generic custom questions, never a sensitive
 * question. Country, region and phone country code are closed lists the extension matches exactly; they are not in the
 * list, so TailorIT refuses a pick of one (400). Equals the extension's PICK_CATEGORIES.
 */
export const AUTOFILL_PICK_CATEGORIES = [
  'school',
  'degree',
  'field_of_study',
  'language',
  'language_proficiency',
  'referral_source',
  'generic',
] as const;
export type AutofillPickCategory = (typeof AUTOFILL_PICK_CATEGORIES)[number];

/**
 * The categories that never lead to a fill. Claude is told to use them whenever a question is of that nature; the
 * extension's SERVER_CATEGORY_MAP leaves such a field to the person, so a classification can only make the extension
 * more careful, never write a sensitive answer.
 */
export const AUTOFILL_NEEDS_USER_CATEGORIES = [
  'sensitive_eeo',
  'sensitive_legal',
  'sensitive_compensation',
  'consent',
  'attention_check',
  'free_text_question',
] as const;

/**
 * What a field asks for, as a classification answers it. The extension's SERVER_CATEGORY_MAP maps each one to its own
 * categories, by the field's section where one needs it: `employer`, `job_title`, `location`, `start_date`, `end_date`
 * and `role_description` in an employment entry are that entry's; `start_date` elsewhere is when the person can start.
 */
export const AUTOFILL_FIELD_CATEGORIES = [
  'first_name',
  'middle_name',
  'last_name',
  'full_name',
  'preferred_name',
  'email',
  'phone',
  'phone_country_code',
  'address_line1',
  'address_line2',
  'city',
  'region',
  'postal_code',
  'country',
  'location',
  'linkedin',
  'github',
  'portfolio',
  'website',
  'current_employer',
  'current_title',
  'employer',
  'job_title',
  'role_description',
  'years_experience',
  'school',
  'degree',
  'field_of_study',
  'graduation_date',
  'gpa',
  'language',
  'language_proficiency',
  'skills',
  'start_date',
  'end_date',
  'notice_period',
  'relocation',
  'work_arrangement',
  'referral_source',
  'resume_upload',
  'cover_letter_upload',
  ...AUTOFILL_NEEDS_USER_CATEGORIES,
] as const;
export type AutofillFieldCategory = (typeof AUTOFILL_FIELD_CATEGORIES)[number];

/** A task's id: TailorIT's random UUID in lower case, the only thing GET and DELETE /api/ai/tasks/:id hold. */
export const AutofillTaskIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The observed option-set hash: 16 lower-case hex digits (the extension's hash of the field's usable options). */
export const OptionSetHashSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** An item's identity in its request: the extension's field key, each one once, repeated in its answer. TailorIT
 *  numbers the items itself, so a key (which holds label text) never reaches Claude. */
const ItemKeySchema = z.string().min(1).max(AUTOFILL_AI_LIMITS.key);

/**
 * `text` with at most `max` code points (zod's count): a longer text is cut after its last whole word within them, so
 * no word is split, and only a first word longer than `max` is cut inside. Nothing is added; spaces at the cut go.
 */
export function cutAtWord(text: string, max: number): string {
  const points = [...text];
  if (points.length <= max) return text;
  const head = points.slice(0, Math.max(0, max));
  let end = head.length;
  if (!/\s/.test(points[end] ?? '')) {
    while (end > 0 && !/\s/.test(head[end - 1]!)) end -= 1;
  }
  const kept = head.slice(0, end).join('').trimEnd();
  return kept === '' ? head.join('').trimEnd() : kept;
}

/** The length of every string in a request together (UTF-16 units: at least their code points, less than the JSON). */
function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + textLength(item), 0);
  if (value === null || typeof value !== 'object') return 0;
  return Object.values(value).reduce((sum: number, item) => sum + textLength(item), 0);
}

/** Each item's key once, and no more text than TailorIT takes. */
function checkItems(list: string, items: readonly { key: string }[], request: unknown, ctx: z.RefinementCtx): void {
  const keys = new Set<string>();
  items.forEach((item, index) => {
    if (keys.has(item.key)) {
      ctx.addIssue({ code: 'custom', path: [list, index, 'key'], message: 'Each item needs its own key' });
    }
    keys.add(item.key);
  });
  if (textLength(request) > AUTOFILL_AI_LIMITS.requestText) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: `The request holds more than ${AUTOFILL_AI_LIMITS.requestText.toLocaleString('en-US')} characters`,
    });
  }
}

/** One option a tiebreak may choose. */
export const AutofillPickOptionSchema = z.object({
  /** The option's position among the field's visible options, as the extension scanned them: what an answer names. */
  index: z.number().int().nonnegative(),
  /** Its clean label (injected text cut), exactly as sent: page text. */
  label: z.string().max(AUTOFILL_AI_LIMITS.pick.optionLabel),
});
export type AutofillPickOption = z.infer<typeof AutofillPickOptionSchema>;

/** One field the extension could not settle: which of these options means what the person means? */
export const AutofillPickItemSchema = z.object({
  key: ItemKeySchema,
  category: z.enum(AUTOFILL_PICK_CATEGORIES),
  /** The option set the options were read under, repeated in the answer. */
  optionSetHash: OptionSetHashSchema,
  /** What the person means, from their profile ("The University of Texas at Austin"; a degree with its field, "MS in
   *  Computer Science"): profile text, never page text. */
  intendedValue: z.string().min(1).max(AUTOFILL_AI_LIMITS.pick.intendedValue),
  /** Other names for it ("UT Austin"), from the profile and the extension's vocabulary. */
  aliases: z.array(z.string().max(AUTOFILL_AI_LIMITS.pick.alias)).max(AUTOFILL_AI_LIMITS.pick.aliases).default([]),
  /** The question as the form shows it (page text); '' when the extension may not quote it (a label known only from
   *  aria-label). */
  label: z.string().max(AUTOFILL_AI_LIMITS.pick.label),
  /** The candidates, in the field's order, each index once: only options that passed the extension's guard. */
  options: z.array(AutofillPickOptionSchema).min(1).max(AUTOFILL_AI_LIMITS.pick.options),
});
export type AutofillPickItem = z.infer<typeof AutofillPickItemSchema>;

function checkPick(request: { items: readonly AutofillPickItem[] }, ctx: z.RefinementCtx): void {
  request.items.forEach((item, at) => {
    const indices = new Set<number>();
    item.options.forEach((option, index) => {
      if (indices.has(option.index)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', at, 'options', index, 'index'],
          message: 'Each option needs its own index',
        });
      }
      indices.add(option.index);
    });
  });
  checkItems('items', request.items, request, ctx);
}

/** POST /api/autofill/ai/pick (scope ai:run): one task for a form pass's ties, at most 20. */
export const AutofillPickRequestSchema = z
  .object({ items: z.array(AutofillPickItemSchema).min(1).max(AUTOFILL_AI_LIMITS.pick.items) })
  .superRefine(checkPick);
export type AutofillPickRequest = z.infer<typeof AutofillPickRequestSchema>;

/**
 * Why a pick is what it is. `matched`: Claude named an option the item offered. `no_match`: it named none (null).
 * `invalid`: its answer was not one of the item's sent indices (another number, a fraction, a string); or the answer
 * as a whole was not trusted, which makes every item `invalid`: it did not name each item exactly once (one missing,
 * repeated or added, or numbered with a string), or it talked of being an AI. `sensitive`: TailorIT did not ask,
 * because the question or the value looked sensitive, or the value is one of the person's sensitive answers.
 */
export const AUTOFILL_PICK_REASONS = ['matched', 'no_match', 'invalid', 'sensitive'] as const;
export type AutofillPickReason = (typeof AUTOFILL_PICK_REASONS)[number];

export const AutofillPickSchema = z.object({
  key: ItemKeySchema,
  optionSetHash: OptionSetHashSchema,
  /** The chosen option's `index`, as the request sent it; null unless `matched`. */
  index: z.number().int().nonnegative().nullable(),
  reason: z.enum(AUTOFILL_PICK_REASONS),
});
export type AutofillPick = z.infer<typeof AutofillPickSchema>;

/** A pick task's result: one answer per item, in the request's order. */
export const AutofillPickResultSchema = z.object({
  picks: z.array(AutofillPickSchema).max(AUTOFILL_AI_LIMITS.pick.items),
});
export type AutofillPickResult = z.infer<typeof AutofillPickResultSchema>;

/** One field nothing on the extension's side classified. Every text is page text, cut with cutAtWord to 200. */
export const AutofillClassifyItemSchema = z.object({
  key: ItemKeySchema,
  kind: z.enum(AUTOFILL_FIELD_KINDS),
  /** The question as the form shows it. */
  label: z.string().max(AUTOFILL_AI_LIMITS.classify.text),
  /** Its visible description, if any. */
  hint: z.string().max(AUTOFILL_AI_LIMITS.classify.text).default(''),
  /** The heading of the part of the form it sits in ("Employment", "Voluntary Self-Identification"). */
  section: z.string().max(AUTOFILL_AI_LIMITS.classify.text).default(''),
  /** Its first options' clean labels, at most 20. */
  options: z
    .array(z.string().max(AUTOFILL_AI_LIMITS.classify.text))
    .max(AUTOFILL_AI_LIMITS.classify.options)
    .default([]),
});
export type AutofillClassifyItem = z.infer<typeof AutofillClassifyItemSchema>;

/** POST /api/autofill/ai/classify (scope ai:run): one task for a form pass's unclassified fields, at most 20. */
export const AutofillClassifyRequestSchema = z
  .object({
    /** The form's ATS. */
    platform: z.enum(ATS_KINDS),
    items: z.array(AutofillClassifyItemSchema).min(1).max(AUTOFILL_AI_LIMITS.classify.items),
  })
  .superRefine((request, ctx) => checkItems('items', request.items, request, ctx));
export type AutofillClassifyRequest = z.infer<typeof AutofillClassifyRequestSchema>;

/**
 * Why a classification is what it is. `classified`: a category from the list. `unknown`: Claude named none (null).
 * `invalid`: it named something not in the list; or the answer as a whole was not trusted, which makes every item
 * `invalid`: it did not name each item exactly once, or it talked of being an AI. `sensitive`: TailorIT did not ask.
 */
export const AUTOFILL_CLASSIFY_REASONS = ['classified', 'unknown', 'invalid', 'sensitive'] as const;
export type AutofillClassifyReason = (typeof AUTOFILL_CLASSIFY_REASONS)[number];

export const AutofillClassificationSchema = z.object({
  key: ItemKeySchema,
  /** Null unless `classified`. */
  category: z.enum(AUTOFILL_FIELD_CATEGORIES).nullable(),
  reason: z.enum(AUTOFILL_CLASSIFY_REASONS),
});
export type AutofillClassification = z.infer<typeof AutofillClassificationSchema>;

/** A classify task's result: one answer per item, in the request's order. */
export const AutofillClassifyResultSchema = z.object({
  items: z.array(AutofillClassificationSchema).max(AUTOFILL_AI_LIMITS.classify.items),
});
export type AutofillClassifyResult = z.infer<typeof AutofillClassifyResultSchema>;

/** One free-text question to draft an answer for. */
export const AutofillDraftQuestionSchema = z.object({
  key: ItemKeySchema,
  /** The question as the form shows it: page text (a custom question: the person's own words, as typed). */
  question: z.string().min(1).max(AUTOFILL_AI_LIMITS.draft.question),
  /** The field's maxLength, at most 5000; null when it has none (the draft is then kept to 3000). */
  maxLength: z.number().int().min(AUTOFILL_AI_LIMITS.draft.minLength).max(AUTOFILL_AI_LIMITS.draft.maxLength).nullable(),
  /**
   * What the field holds now, for a rewrite ("Edit with AI", version 2): page text, quoted to Claude as data. Absent
   * or blank for a new draft. Sent as written, so a current answer that states a sensitive answer, is a sum of money,
   * or holds a contact detail or a postal address is answered `sensitive` without asking.
   */
  currentAnswer: z.string().max(AUTOFILL_AI_LIMITS.draft.currentAnswer).optional(),
  /**
   * The person's own instruction for this answer ("Edit with AI": "Tell me what to add, change or improve", version 3),
   * as typed, at most 750 characters; absent or blank for none. Quoted to Claude as the applicant's wish about what the
   * answer says and how, within the drafts' rules (facts from the resume and the profile only). One that names a
   * sensitive topic, states a sensitive answer, or holds a contact detail or a postal address is answered
   * `sensitive` without asking, as its question would be.
   */
  instruction: z.string().max(AUTOFILL_AI_LIMITS.draft.instruction).optional(),
});
export type AutofillDraftQuestion = z.infer<typeof AutofillDraftQuestionSchema>;

/**
 * POST /api/autofill/ai/draft (scope ai:run): at most three questions of one form, or one custom question
 * (AUTOFILL_CUSTOM_QUESTION_LENGTHS). TailorIT writes each draft from the person's resume and autofill profile (its
 * work history, education, languages, skills and job preferences), which it reads itself (never the sensitive part,
 * and no name, contact details or address), and from the job text; a question that looks sensitive or like an
 * attention check is answered `sensitive` without asking. 404 `not_found` when `resumeId` is not one of the account's
 * resumes.
 */
export const AutofillDraftRequestSchema = z
  .object({
    questions: z.array(AutofillDraftQuestionSchema).min(1).max(AUTOFILL_AI_LIMITS.draft.questions),
    /** The job description the form's own page shows (page text); '' on a form embedded in a company's page, whose
     *  drafts go by the company and the title alone. Never TailorIT's stored copy. */
    jobText: z.string().max(AUTOFILL_AI_LIMITS.draft.jobText),
    /** The lookup's company and job title, '' when it found no job. */
    company: z.string().max(AUTOFILL_AI_LIMITS.draft.company).default(''),
    jobTitle: z.string().max(AUTOFILL_AI_LIMITS.draft.jobTitle).default(''),
    /** The resume whose facts the drafts may use; null: the profile's resume, else the default. */
    resumeId: z.string().max(64).nullable(),
    /** The page's tripwire tokens ("I am LLM"): a draft holding one is refused (`canary`). */
    canaries: z
      .array(z.string().min(2).max(AUTOFILL_AI_LIMITS.draft.canary))
      .max(AUTOFILL_AI_LIMITS.draft.canaries)
      .default([]),
  })
  .superRefine((request, ctx) => checkItems('questions', request.questions, request, ctx));
export type AutofillDraftRequest = z.infer<typeof AutofillDraftRequestSchema>;

/**
 * Why a draft is what it is. `drafted`: within its cap. `trimmed`: cut at the last sentence end within the cap.
 * `empty`: the resume and the profile had nothing to say. `too_long`: over the cap with no sentence end to cut at.
 * `canary`: the answer held one of the page's canaries. `ai_reference`: it spoke of being an AI. `wrapper`: the draft
 * held the prompt's `<untrusted>` wrapper, the JSON sentinels or the fake CLI's scenario tag. `contact`: it named a
 * link, an email address or a phone number that is not the person's own (in the autofill profile). `invalid`: its
 * answer was not a text, or the answer as a whole was not trusted (it did not name each question exactly once).
 * `sensitive`: TailorIT did not ask, because the question looked sensitive or like an attention check, or its current
 * answer stated a sensitive answer; or the draft stated one. Only `drafted` and `trimmed` carry text. A canary or talk
 * of being an AI anywhere in Claude's reply, prose outside the JSON included, discards every draft of the task with
 * that reason.
 */
export const AUTOFILL_DRAFT_REASONS = [
  'drafted',
  'trimmed',
  'empty',
  'too_long',
  'canary',
  'ai_reference',
  'wrapper',
  'contact',
  'invalid',
  'sensitive',
] as const;
export type AutofillDraftReason = (typeof AUTOFILL_DRAFT_REASONS)[number];

export const AutofillDraftSchema = z.object({
  key: ItemKeySchema,
  /** Plain text in the first person, written into the field as the person's answer; null unless `drafted` or
   *  `trimmed`. */
  text: z.string().max(AUTOFILL_AI_LIMITS.draft.maxLength).nullable(),
  reason: z.enum(AUTOFILL_DRAFT_REASONS),
  /** v5 (the review's security 5): as an answer's `streamedThenVoided`: sent on the stream, its reply then not trusted
   *  as a whole. */
  streamedThenVoided: z.literal(true).optional(),
});
export type AutofillDraft = z.infer<typeof AutofillDraftSchema>;

/** A draft task's result: one answer per question, in the request's order. */
export const AutofillDraftResultSchema = z.object({
  drafts: z.array(AutofillDraftSchema).max(AUTOFILL_AI_LIMITS.draft.questions),
});
export type AutofillDraftResult = z.infer<typeof AutofillDraftResultSchema>;

/** What an answer is (version 2): one option of the field's own list, or a short text. */
export const AUTOFILL_ANSWER_SHAPES = ['choice', 'text'] as const;
export type AutofillAnswerShape = (typeof AUTOFILL_ANSWER_SHAPES)[number];

/**
 * The field kinds each shape answers. Never a set (a checkbox group, a multiselect), a lone checkbox, a remote
 * typeahead or a file: Claude answers none of those; a date only as a text with a date `format` (version 4).
 */
export const AUTOFILL_ANSWER_KINDS = {
  choice: ['select', 'radio', 'combobox'],
  text: ['text', 'textarea'],
} as const satisfies Record<AutofillAnswerShape, readonly AutofillFieldKind[]>;

/**
 * The layout a text's answer must have (version 4; optional, and absent or null is any short text, as before), for a
 * box that takes nothing else: a salary, years of experience, a graduation year, a date. `number`: one number, digits
 * with at most one decimal point ("3.5"); `integer`: digits alone ("5", "2019"); `currency`: a sum of money as one
 * number, with at most two decimals and never a currency sign or code ("85000"); `date`: one calendar date written
 * YYYY-MM-DD ("2026-12-01"); `MM/DD/YYYY`, `DD/MM/YYYY`: one calendar date written so ("12/01/2026", "01/12/2026");
 * `MM/YYYY`: one month ("09/2018"). Never a range, a unit or a word. A `date` field (AUTOFILL_FIELD_KINDS) is answered
 * only with one of the date layouts.
 */
export const AUTOFILL_ANSWER_FORMATS = [
  'number',
  'integer',
  'currency',
  'date',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM/YYYY',
] as const;
export type AutofillAnswerFormat = (typeof AUTOFILL_ANSWER_FORMATS)[number];

/** The formats that are dates (or a month): the ones a `date` field may be answered with. */
export const AUTOFILL_ANSWER_DATE_FORMATS = [
  'date',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM/YYYY',
] as const satisfies readonly AutofillAnswerFormat[];

const isDateFormat = (format: AutofillAnswerFormat | null) =>
  format !== null && (AUTOFILL_ANSWER_DATE_FORMATS as readonly string[]).includes(format);

/** The most digits a number answer may have, its decimals included. */
const FORMAT_DIGITS_MAX = 15;

/** Days in a month of a year (1-12), leap years counted. */
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** A date in its layout, each part read and written back two digits wide (a year four); null for no such date. */
function dateInFormat(value: string, format: (typeof AUTOFILL_ANSWER_DATE_FORMATS)[number]): string | null {
  const separator = format === 'date' ? '-' : '/';
  const layout = format === 'date' ? ['YYYY', 'MM', 'DD'] : format.split('/');
  const parts = value.split(separator);
  if (parts.length !== layout.length) return null;
  const read = new Map<string, number>();
  for (const [at, field] of layout.entries()) {
    const part = parts[at]!;
    if (!(field === 'YYYY' ? /^\d{4}$/ : /^\d{1,2}$/).test(part)) return null;
    read.set(field, Number(part));
  }
  const year = read.get('YYYY')!;
  const month = read.get('MM')!;
  const day = read.get('DD') ?? 1;
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  const written = new Map([
    ['YYYY', String(year)],
    ['MM', String(month).padStart(2, '0')],
    ['DD', String(day).padStart(2, '0')],
  ]);
  return layout.map((field) => written.get(field)!).join(separator);
}

/**
 * An answer written in its format, or null when it is not one value of that format ("5 years", "$85,000",
 * "80000-90000", "December 2026", "02/30/2026", and "85.000", a lone thousands group with a dot, which reads as 85 here
 * and 85000 elsewhere). The only changes: the text is trimmed, a number's comma thousands separators in their places
 * are dropped ("85,000" is "85000") and so are its leading zeros ("007" is "7", "00.5" is "0.5"), and a date's
 * one-digit day or month is written two digits wide ("1/5/2026" is "01/05/2026"). TailorIT keeps an answer only so;
 * the extension may check it again with this.
 */
export function answerInFormat(text: string, format: AutofillAnswerFormat): string | null {
  const value = text.trim();
  if (isDateFormat(format)) return dateInFormat(value, format as (typeof AUTOFILL_ANSWER_DATE_FORMATS)[number]);
  // A lone European thousands group ("85.000", 85000 where a dot groups thousands) is not one value: never read as 85.
  if (/^[1-9]\d{0,2}\.\d{3}$/.test(value)) return null;
  const plain = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value) ? value.replace(/,/g, '') : value;
  const pattern = format === 'integer' ? /^\d+$/ : format === 'currency' ? /^\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d+)?$/;
  if (!pattern.test(plain)) return null;
  // Leading zeros go ("007" is 7), never a lone zero or the one before a decimal point.
  const number = plain.replace(/^0+(?=\d)/, '');
  return number.replace('.', '').length <= FORMAT_DIGITS_MAX ? number : null;
}

/** One question nothing on the extension's side settled. Every text is page text. */
export const AutofillAnswerItemSchema = z.object({
  key: ItemKeySchema,
  shape: z.enum(AUTOFILL_ANSWER_SHAPES),
  /** The field's kind, one of AUTOFILL_ANSWER_KINDS[shape]. */
  kind: z.enum(AUTOFILL_FIELD_KINDS),
  /** The question as the form shows it (its visible label). */
  question: z.string().min(1).max(AUTOFILL_AI_LIMITS.answer.question),
  /** Its visible description, if any. */
  hint: z.string().max(AUTOFILL_AI_LIMITS.answer.hint).default(''),
  /** The heading of the part of the form it sits in. */
  section: z.string().max(AUTOFILL_AI_LIMITS.answer.section).default(''),
  /** A choice's option set, repeated in the answer; null for a text. */
  optionSetHash: OptionSetHashSchema.nullable(),
  /** A choice's candidates (2 to 30, in the field's order, each index once: only options that passed the extension's
   *  guard); [] for a text. */
  options: z.array(AutofillPickOptionSchema).max(AUTOFILL_AI_LIMITS.answer.options).default([]),
  /** A text's cap: the field's maxLength, at most 500; null when it names none (the answer is then kept to 500).
   *  Null for a choice. */
  maxLength: z.number().int().min(1).max(AUTOFILL_AI_LIMITS.answer.textMax).nullable(),
  /**
   * The layout a text's answer must have (AUTOFILL_ANSWER_FORMATS, version 4: a number box, a date box); absent or null
   * for any short text, as an extension that never sends it gets. Null for a choice.
   */
  format: z.enum(AUTOFILL_ANSWER_FORMATS).nullable().optional(),
  /**
   * v5 (one round, additive within API 6): true asks for the question's category too (AUTOFILL_FIELD_CATEGORIES, as
   * POST …/ai/classify answers it) in the same task, so a question no rule classified is classified and answered at
   * once; its answer then carries `classification`. Needs the request's `platform`. Absent: answered as before.
   */
  classify: z.literal(true).optional(),
});
export type AutofillAnswerItem = z.infer<typeof AutofillAnswerItemSchema>;

/** A choice names its kind, its option set and 2 to 30 options, each index once, and no maxLength or format; a text
 *  names its kind (a date field with a date format only) and neither an option set nor options. */
function checkAnswerRequest(
  request: { items: readonly AutofillAnswerItem[]; platform?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  // v5 (one round): a classification is asked on the request's platform.
  if (request.platform === undefined && request.items.some((item) => item.classify === true)) {
    ctx.addIssue({ code: 'custom', path: ['platform'], message: 'An item that asks its category needs the platform' });
  }
  request.items.forEach((item, at) => {
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: ['items', at, field], message });
    const dated = item.shape === 'text' && isDateFormat(item.format ?? null);
    const kinds: readonly string[] = dated
      ? [...AUTOFILL_ANSWER_KINDS.text, 'date']
      : AUTOFILL_ANSWER_KINDS[item.shape];
    if (!kinds.includes(item.kind)) issue('kind', `A ${item.shape} answers a ${kinds.join(', ')} field only`);
    if (item.shape === 'text') {
      if (item.optionSetHash !== null) issue('optionSetHash', 'A text has no option set');
      if (item.options.length > 0) issue('options', 'A text has no options');
      return;
    }
    if (item.optionSetHash === null) issue('optionSetHash', 'A choice needs its option set');
    if (item.options.length < 2) issue('options', 'A choice needs at least two options');
    if (item.maxLength !== null) issue('maxLength', 'A choice has no maxLength');
    if ((item.format ?? null) !== null) issue('format', 'A choice has no format');
    const indices = new Set<number>();
    item.options.forEach((option, index) => {
      if (indices.has(option.index)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', at, 'options', index, 'index'],
          message: 'Each option needs its own index',
        });
      }
      indices.add(option.index);
    });
  });
  checkItems('items', request.items, request, ctx);
}

/**
 * Which questions an answer request asks (the owner's decision of 2026-11-01, additive in version 2). `standard`: the
 * ordinary ones; a legal, criminal-history, pay, consent, self-identification or attention-check question is answered
 * `sensitive` without asking. `all`: besides them, the legal questions (work authorization, sponsorship now or in the
 * future, a visa, citizenship or residence status, a security clearance, export control, age and being 18 or over),
 * criminal history (convictions, arrests, charges), pay (salary expectations; a pay answer may be a sum of money) and
 * attention checks ("Select PURPLE to show you read this"), each answered as the most likely answer for this person
 * from the facts, marked `guess` unless a fact settles it (an attention check always `guess`). In every scope: a
 * self-identification (EEO) question or one offering an EEO answer, a consent (an attention check's own words aside),
 * one asking for the person's name, contact details, address or an identity or tax number, one about another person
 * (a referee, an emergency contact, a manager) and an "I did not use AI" attestation are answered `sensitive` without
 * asking.
 */
export const AUTOFILL_ANSWER_SCOPES = ['standard', 'all'] as const;
export type AutofillAnswerScope = (typeof AUTOFILL_ANSWER_SCOPES)[number];

/**
 * POST /api/autofill/ai/answer (scope ai:run; version 2): at most ten questions of one form. TailorIT answers each as
 * the person would, from their resume and autofill profile (its work history, education, languages, skills and job
 * preferences), which it reads itself (never the sensitive part, and no name, contact details, address or saved
 * answers), and from the job text; when those do not settle a question, with the most likely answer for this person,
 * marked `guess`. Under the `standard` scope a question that looks sensitive (its text, hint, section or an option: a
 * self-identification, legal, pay or consent question, an EEO answer or a decline to self-identify) or like an
 * attention check is answered `sensitive` without asking; the `all` scope asks the legal, criminal-history, pay and
 * attention-check ones too (AUTOFILL_ANSWER_SCOPES). 404 `not_found` when `resumeId` is not one of the account's
 * resumes.
 */
export const AutofillAnswerRequestSchema = z
  .object({
    items: z.array(AutofillAnswerItemSchema).min(1).max(AUTOFILL_AI_LIMITS.answer.items),
    /** Which questions are asked (AUTOFILL_ANSWER_SCOPES); `standard` when absent, as before it existed. */
    scope: z.enum(AUTOFILL_ANSWER_SCOPES).default('standard'),
    /** The job description the form's own page shows (page text); '' on an embedded form. Never TailorIT's stored
     *  copy. */
    jobText: z.string().max(AUTOFILL_AI_LIMITS.answer.jobText),
    /** The lookup's company and job title, '' when it found no job. */
    company: z.string().max(AUTOFILL_AI_LIMITS.answer.company).default(''),
    jobTitle: z.string().max(AUTOFILL_AI_LIMITS.answer.jobTitle).default(''),
    /** The resume whose facts the answers may use (the one the fill attaches); null: the profile's, else the
     *  default. */
    resumeId: z.string().max(64).nullable(),
    /** The page's tripwire tokens: an answer holding one is refused (`canary`). */
    canaries: z
      .array(z.string().min(2).max(AUTOFILL_AI_LIMITS.answer.canary))
      .max(AUTOFILL_AI_LIMITS.answer.canaries)
      .default([]),
    /** v5 (one round): the form's ATS, as a classify request names it; needed when an item asks `classify`. */
    platform: z.enum(ATS_KINDS).optional(),
  })
  .superRefine(checkAnswerRequest);
export type AutofillAnswerRequest = z.infer<typeof AutofillAnswerRequestSchema>;

/**
 * Where an answer comes from. `resume`: the resume's facts settle it. `profile`: the autofill profile's (its work
 * history, education, languages, skills or job preferences). `job`: the job's own words do (the office the posting
 * names). `guess`: nothing settles it, so Claude gave the most likely answer for this person; the extension marks it
 * "AI guess". An answer Claude gave no basis for, or one not in this list, is a `guess`.
 */
export const AUTOFILL_ANSWER_BASES = ['resume', 'profile', 'job', 'guess'] as const;
export type AutofillAnswerBasis = (typeof AUTOFILL_ANSWER_BASES)[number];

/**
 * Why an answer is what it is. `answered`: one of the item's sent option indices (a choice), or a text within its cap
 * (a text), with its basis. `no_answer`: Claude gave none (null, or a text with nothing left once cleaned). `invalid`:
 * the answer did not fit the item (a choice's index not one the item sent, or with a text; a text that is not a
 * string, comes with an index, holds a line break for a one-line input, or is not one value of its `format`:
 * answerInFormat); or the answer as a whole was not trusted
 * (it did not name each item exactly once), which makes every item `invalid`. `too_long`: a text over its cap (it is
 * never cut). `canary`: one of the page's canaries anywhere in Claude's reply; `ai_reference`: Claude speaking as an
 * AI anywhere in it; either makes every item so. `wrapper`: the text holds the prompt's `<untrusted>` wrapper, the JSON
 * sentinels or the fake CLI's scenario tag. `contact`: it names a link, an email address, a phone number or a postal
 * address that is not the person's own. `sensitive`: TailorIT did not ask (see the request), or the text states a sensitive answer, is an
 * EEO answer or is a sum of money. Only `answered` carries an index or a text, and a basis.
 */
export const AUTOFILL_ANSWER_REASONS = [
  'answered',
  'no_answer',
  'invalid',
  'too_long',
  'canary',
  'ai_reference',
  'wrapper',
  'contact',
  'sensitive',
] as const;
export type AutofillAnswerReason = (typeof AUTOFILL_ANSWER_REASONS)[number];

interface AnswerEntry {
  optionSetHash: string | null;
  index: number | null;
  text: string | null;
  basis: AutofillAnswerBasis | null;
  reason: AutofillAnswerReason;
  classification?: { category: string | null; reason: string } | undefined;
}

/** An answered item carries its basis and one value of its own shape (a choice an index, a text a text); any other
 *  carries neither. */
function checkAnswer(answer: AnswerEntry, ctx: z.RefinementCtx): void {
  const fits = answer.optionSetHash === null ? answer.index === null : answer.text === null;
  const values = Number(answer.index !== null) + Number(answer.text !== null);
  const holds = values === 1 && answer.basis !== null;
  const empty = values === 0 && answer.basis === null;
  if (!fits) {
    ctx.addIssue({ code: 'custom', path: [], message: 'A choice answers an index and a text answers a text' });
  } else if (answer.reason === 'answered' ? !holds : !empty) {
    ctx.addIssue({ code: 'custom', path: [], message: 'Only an answered item carries a value and its basis' });
  }
  // v5 (one round): a classification names a category exactly when it is `classified`.
  const classification = answer.classification;
  if (classification !== undefined && (classification.category !== null) !== (classification.reason === 'classified')) {
    ctx.addIssue({ code: 'custom', path: ['classification'], message: 'Only a classified item names a category' });
  }
}

export const AutofillAnswerSchema = z
  .object({
    key: ItemKeySchema,
    /** The item's option set, repeated; null for a text. */
    optionSetHash: OptionSetHashSchema.nullable(),
    /** A choice's chosen option `index`, as the request sent it; null unless answered. */
    index: z.number().int().nonnegative().nullable(),
    /** A text's answer, plain text in the first person, one line for a text input; null unless answered. */
    text: z.string().max(AUTOFILL_AI_LIMITS.answer.textMax).nullable(),
    /** Null unless answered. */
    basis: z.enum(AUTOFILL_ANSWER_BASES).nullable(),
    reason: z.enum(AUTOFILL_ANSWER_REASONS),
    /**
     * v5 (one round): present exactly for an item asked with `classify`: its category, as a classification answers it
     * (`classified` with a category from AUTOFILL_FIELD_CATEGORIES, `unknown` for none, `invalid` for an answer not in
     * the list or a reply not trusted, `sensitive` for an item TailorIT did not ask). The answer never depends on it;
     * but under the `standard` scope an item classified into a needs-user category but `free_text_question`
     * (self-identification, legal, pay, consent, an attention check), and in any scope one classified `sensitive_eeo`
     * or `consent`, is answered `sensitive`, with no value. The extension uses the category first: a category its
     * profile fills takes the profile's value, never this answer.
     */
    classification: z
      .object({
        category: z.enum(AUTOFILL_FIELD_CATEGORIES).nullable(),
        reason: z.enum(AUTOFILL_CLASSIFY_REASONS),
      })
      .optional(),
    /**
     * v5 (the review's security 5): this answer went out on the task's stream, and the reply it came from was then
     * not trusted as a whole (Claude spoke as an AI after it, the reply never read as the JSON asked, held two JSON
     * blocks, or did not answer each item once). The answer stands as sent, and the extension flags the field it
     * wrote for review. Absent otherwise.
     */
    streamedThenVoided: z.literal(true).optional(),
  })
  .superRefine(checkAnswer);
export type AutofillAnswer = z.infer<typeof AutofillAnswerSchema>;

/** An answer task's result: one answer per item, in the request's order. */
export const AutofillAnswerResultSchema = z.object({
  answers: z.array(AutofillAnswerSchema).max(AUTOFILL_AI_LIMITS.answer.items),
});
export type AutofillAnswerResult = z.infer<typeof AutofillAnswerResultSchema>;

/** An AI route's answer when its task has not finished within AUTOFILL_AI_WAIT_MS (202): poll it. */
export const AutofillTaskAcceptedSchema = z.object({ taskId: AutofillTaskIdSchema });
export type AutofillTaskAccepted = z.infer<typeof AutofillTaskAcceptedSchema>;

/** A task as TailorIT's AiTaskView shows it, with the kind's result. */
function taskOf<K extends AutofillTaskKind, R extends z.ZodType>(kind: K, result: R) {
  return z.object({
    id: AutofillTaskIdSchema,
    kind: z.literal(kind),
    status: z.enum(AUTOFILL_TASK_STATUSES),
    /** Null until it succeeded. */
    result: result.nullable(),
    /** Why it failed or was cancelled (`code` is one of AUTOFILL_TASK_ERROR_CODES, or one added later). */
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    createdAt: InstantSchema,
    startedAt: InstantSchema.nullable(),
    finishedAt: InstantSchema.nullable(),
  });
}

/** POST …/ai/pick's 200 answer: the task, finished. */
export const AutofillPickTaskSchema = taskOf('autofill_pick', AutofillPickResultSchema);
export type AutofillPickTask = z.infer<typeof AutofillPickTaskSchema>;
/** POST …/ai/classify's 200 answer. */
export const AutofillClassifyTaskSchema = taskOf('autofill_classify', AutofillClassifyResultSchema);
export type AutofillClassifyTask = z.infer<typeof AutofillClassifyTaskSchema>;
/** POST …/ai/draft's 200 answer. */
export const AutofillDraftTaskSchema = taskOf('autofill_draft', AutofillDraftResultSchema);
export type AutofillDraftTask = z.infer<typeof AutofillDraftTaskSchema>;
/** POST …/ai/answer's 200 answer (version 2). */
export const AutofillAnswerTaskSchema = taskOf('autofill_answer', AutofillAnswerResultSchema);
export type AutofillAnswerTask = z.infer<typeof AutofillAnswerTaskSchema>;

/** GET /api/ai/tasks/:id, and DELETE on the same path (the task after cancelling; a finished one unchanged). */
export const AutofillTaskViewSchema = z.discriminatedUnion('kind', [
  AutofillPickTaskSchema,
  AutofillClassifyTaskSchema,
  AutofillDraftTaskSchema,
  AutofillAnswerTaskSchema,
]);
export type AutofillTaskView = z.infer<typeof AutofillTaskViewSchema>;

// v5 (Jobright parity, Phase 2; additive within API 6): the streamed view of an AI task. GET /api/ai/tasks/:id/stream
// answers `text/event-stream`: each answer (an answer task's) or draft (a draft task's) as TailorIT settles it, while
// Claude is still writing the rest, then the finished task, then the stream ends. Every message is
// `event: <type>\ndata: <the event's JSON>\n\n`, its `type` repeated in the JSON; a comment line (`: ping`) at least
// every AUTOFILL_AI_STREAM_HEARTBEAT_MS keeps the connection open while nothing settles. An item sent on the stream is
// final: the finished task's result holds it unchanged. A stream that ends without its `task` event (the connection
// went, TailorIT restarted, the stream's own cap) leaves the task to GET /api/ai/tasks/:id. A pick or a classification
// is never sent alone: their tasks' streams carry the finished task only. An item streams only when each of its own
// checks and the reply up to it pass: a reply that speaks as an AI before it holds every item after it back to the
// finished task's checks, and a request that carries canaries never streams an item (its reply is checked whole).
// A TailorIT older than this answers the stream 404, and the extension polls as before.
//
// `Prefer: respond-async` (RFC 7240) on an AI route answers 202 {taskId} at once instead of waiting up to
// AUTOFILL_AI_WAIT_MS, for a caller that then reads the task's stream; that answer names `Preference-Applied`.

/** The longest quiet on a task's stream: a `: ping` comment line is sent at least this often. */
export const AUTOFILL_AI_STREAM_HEARTBEAT_MS = 10_000;
/** The preference an AI route takes to answer 202 at once (RFC 7240's `Prefer: respond-async`). */
export const AUTOFILL_AI_RESPOND_ASYNC = 'respond-async';
/** The event types a task's stream sends. */
export const AUTOFILL_AI_STREAM_EVENTS = ['answer', 'draft', 'task'] as const;
export type AutofillAiStreamEventType = (typeof AUTOFILL_AI_STREAM_EVENTS)[number];

/** One message of GET /api/ai/tasks/:id/stream: an answer or a draft as it settles, then the finished task. */
export const AutofillTaskStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer'), answer: AutofillAnswerSchema }),
  z.object({ type: z.literal('draft'), draft: AutofillDraftSchema }),
  z.object({ type: z.literal('task'), task: AutofillTaskViewSchema }),
]);
export type AutofillTaskStreamEvent = z.infer<typeof AutofillTaskStreamEventSchema>;
