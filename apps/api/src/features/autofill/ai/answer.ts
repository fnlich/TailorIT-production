import { z } from 'zod';
import {
  ATS_KINDS,
  AUTOFILL_AI_LIMITS,
  AUTOFILL_ANSWER_BASES,
  AUTOFILL_ANSWER_SCOPES,
  AUTOFILL_FIELD_CATEGORIES,
  answerInFormat,
  AutofillAnswerItemSchema,
  AutofillAnswerResultSchema,
  AutofillAnswerSchema,
  type AutofillAnswer,
  type AutofillAnswerBasis,
  type AutofillAnswerItem,
  type AutofillAnswerRequest,
  type AutofillAnswerResult,
  type AutofillAnswerScope,
  type AutofillFieldCategory,
} from '@tailorit/shared/autofill';
import { AiError, createResultCache, itemHash, recordCachedItems, type AiTaskContext } from '../../../ai/index';
import {
  answerCap,
  autofillAnswerPrompt,
  type AnswerOutput,
  type AnswerPromptInput,
} from '../../../ai/prompts/autofill/answer';
import { factsAndJob } from '../../../ai/prompts/autofill/facts-and-job';
import { TECHNICAL_FAMILY_ID, type RoleFamilyId } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import { writtenFamily } from '../../tailor/family'; // v33 PROMPTS
import {
  asksLegalQuestion,
  asksSelfIdentification,
  isDeclineOption,
  isEeoOption,
  isIdentityLetter,
} from '../answers/vocabulary';
import { holdsPostalAddress, namesForeignContact, type OwnContacts } from './contacts';
import { cleanDraft, type DraftFacts, type ReadDraftFacts } from './draft';
import { isAgeBand, lets, openingOf, type Opening } from './opening';
import type { AnswerScreen } from './pick';
import {
  asksAboutAnotherPerson,
  asksPersonalDetail,
  isAiAttestation,
  isAttentionCheck,
  namesSensitiveTopic,
  sensitiveTopicsOf,
} from './screen';
import { statedTopicsOf, textIsSensitive } from './statements';
import { releaseItems, voidsReleased } from './stream';
import { entriesByItem, holdsCanary, readTaskInput, speaksAsAnAi, stringsOf, unreadableTask } from './tasks';
import { holdsPromptMarkup } from './untrusted';

// An answer to a question the extension's profile and rules do not settle (POST /api/autofill/ai/answer, task kind
// autofill_answer, v2 Phase D): "Are you willing to travel?", "How many years of Go have you used?", "Have you worked
// with Kubernetes?". Claude answers as the person, from their resume and autofill profile, which TailorIT reads itself
// when the task runs (the drafts' ReadDraftFacts: never the sensitive part, no name, contact details, address or saved
// answer), and from the job text, which is page text like the questions; when nothing settles a question it gives the
// most likely answer for this person, marked `guess`, which the extension shows as "AI guess". A choice is one of the
// item's own option indices, a text a short line within its cap; neither ever names a sensitive answer. A question that
// looks sensitive, by its words (the shared terms and the server's stricter ones) or by its options (a topic, an EEO
// answer, a decline to self-identify, a statement of a sensitive answer, a sum of money, an age band, one of the
// person's own sensitive answers), that asks for one of the person's own details (a name, an email address, a phone
// number, an address), or that looks like an attention check is never asked. Every answer is checked before it is
// stored: a canary, or Claude speaking as an AI, anywhere in the reply discards them all; an answer that does not fit
// its item, holds the prompt's markup, names a contact detail that is not the person's own or an address, chooses an
// option the screen would have held back, states a sensitive answer or runs over its cap discards that answer.
//
// The `all` scope (the owner's decision of 2026-11-01, "determine all by AI") asks the legal (work authorization,
// sponsorship, a visa, a clearance, age), criminal-history, pay and attention-check questions too, by their text and
// options alone: Claude gives the most likely answer for this person from the same facts, `guess` unless a fact
// settles it (an attention check, which it answers as its own question asks, always `guess`), and an answer to such a
// question may state its own topic's answer (a status, "No", a sum of money for pay). In every scope a
// self-identification (EEO) question or EEO option, a consent, the person's own details or identity numbers, another
// person's and an "I did not use AI" attestation are never asked.
//
// A text item may name the layout its box takes (`format`, version 4: a number, a whole number, a sum of money, a date
// or a month in a given layout, as a salary, years-of-experience, graduation-year or date box asks): the prompt asks for
// that one value alone, and an answer that is not one (a word, a unit, a currency sign, a range, no such date) is
// `invalid`, never written. An item without one (an extension that never sends it) is answered as before.
//
// v5 (one round, additive within API 6): an item may ask its category too (`classify`, with the request's `platform`):
// Claude names it in the same reply, from the classify task's closed list (classify.ts CATEGORY_LINES), and its answer
// carries `classification`, so a question no rule of the extension classified is classified and answered in one task,
// not two. The answer never depends on the category, but one classified into a category whose answer is never kept
// (under the standard scope every needs-user category but a free-text question; in any scope self-identification and
// consent) is answered `sensitive`, with no value. The extension uses the category first: a category its profile
// fills takes the profile's value. A screened item's classification is `sensitive`; a reply not trusted makes every
// classification `invalid`, as it makes every answer so.
//
// v30 ST3: the prompt is ai/prompts/autofill/answer.ts; openingOf and its parts are opening.ts.

const LIMITS = AUTOFILL_AI_LIMITS.answer;

/** An item the screen held back: its key and option set only, never its question, hint, section or options. */
const ScreenedAnswerSchema = AutofillAnswerItemSchema.pick({ key: true, optionSetHash: true, classify: true }).extend({
  screened: z.literal('sensitive'),
});
type ScreenedAnswer = z.infer<typeof ScreenedAnswerSchema>;

/**
 * What an autofill_answer task stores (its input, read again by the handler): the request's items in its order, a
 * sensitive one as its key and option set alone, and the rest of the request. The resume is named, not copied: the
 * handler reads the facts when it runs.
 */
const AnswerTaskInputSchema = z.object({
  items: z.array(z.union([ScreenedAnswerSchema, AutofillAnswerItemSchema])).min(1).max(LIMITS.items),
  /** The request's scope; `standard` for a task stored before scopes existed. */
  scope: z.enum(AUTOFILL_ANSWER_SCOPES).default('standard'),
  jobText: z.string().max(LIMITS.jobText),
  company: z.string().max(LIMITS.company),
  jobTitle: z.string().max(LIMITS.jobTitle),
  resumeId: z.string().max(64).nullable(),
  canaries: z.array(z.string().max(LIMITS.canary)).max(LIMITS.canaries),
  /** v5 (one round): the form's ATS, when an item asks its category. */
  platform: z.enum(ATS_KINDS).optional(),
});
export type AnswerTaskInput = z.infer<typeof AnswerTaskInputSchema>;

/** v30 ST3: the autofill_answer task's `parse` (ai-tasks.ts): its stored input, or the task fails. */
export const readAnswerTaskInput = (raw: unknown): AnswerTaskInput => readTaskInput(AnswerTaskInputSchema, raw);

const isScreened = (item: AnswerTaskInput['items'][number]): item is ScreenedAnswer => 'screened' in item;

/**
 * True when an option names a sensitive topic (the shared terms or the server's stricter ones), is an EEO answer or a
 * decline to self-identify ("Man", "Woman", "Decline to answer"), a one-letter answer to an identity question, an age
 * band, or is or states a sensitive answer ("Permanent resident", "I am married", "$50k-$80k", "50,000-80,000":
 * statements.ts's textIsSensitive). The screen holds back an item with one such option; an answer that chooses one is
 * discarded all the same. With an `all` scope's opening (which openingOf read off every option, so a topic, a
 * statement, a sum or an age band in one is the opening's own): true for a one-letter answer to an identity question,
 * a topic or a statement the opening does not let through, and an EEO answer, but in an attention check ("Select
 * White to show you read this") and for a decline beside a question that names an open topic (a fair answer to a
 * legal or pay question, where elsewhere it marks a self-identification one).
 */
function optionIsSensitive(asked: readonly string[], label: string, opening: Opening | null = null): boolean {
  if (isIdentityLetter(asked, label)) return true;
  if (opening === null) {
    if (namesSensitiveTopic(label) || isEeoOption(label)) return true;
    return textIsSensitive(label) || isAgeBand(label);
  }
  if ([...sensitiveTopicsOf(label), ...statedTopicsOf(label)].some((topic) => !lets(opening, topic))) return true;
  return isEeoOption(label) && !opening.attention && !(opening.topics.size > 0 && isDeclineOption(label));
}

/**
 * An item is not asked when its question, hint or section names a sensitive topic (the shared terms or the server's
 * stricter ones: screen.ts's namesSensitiveTopic), asks for one of the person's own details (a name, an email address,
 * a phone number, an address: asksPersonalDetail) or looks like an attention check, asks a legal or self-identification
 * question in other words (answers/vocabulary.ts: "Will you need us to support your stay?", "Do you identify as a
 * woman?"), or when one of its options is sensitive (optionIsSensitive: "How do you identify?" with Man, Woman and
 * Non-binary; "Current status?" with Permanent resident; "Which range fits you?" with $50k-$80k) or looks like an
 * attention check. It fails closed: "Which perk matters most?" with Equity and Bonus is never asked.
 *
 * The `all` scope asks the legal, criminal-history, pay and attention-check ones too: an item is not asked there when
 * it names a topic its opening does not let through (openingOf: a self-identification, an identity number, a consent
 * outside an attention check) or one of its options is sensitive for that opening. In every scope an item is not asked
 * when it asks for one of the person's own details, asks a self-identification question in other words, asks about
 * another person (screen.ts's asksAboutAnotherPerson: a referee, an emergency contact, a manager's name) or is an "I
 * did not use AI" attestation (isAiAttestation), by its words or its options.
 */
export function answerIsSensitive(item: AutofillAnswerItem, scope: AutofillAnswerScope = 'standard'): boolean {
  const asked = [item.question, item.hint, item.section];
  const labels = item.options.map((option) => option.label);
  if (asked.some(asksPersonalDetail) || asksSelfIdentification(asked)) return true;
  if ([...asked, ...labels].some((text) => asksAboutAnotherPerson(text) || isAiAttestation(text))) return true;
  if (scope === 'all') {
    const opening = openingOf(item);
    return opening === null || labels.some((label) => optionIsSensitive(asked, label, opening));
  }
  if (asked.some(namesSensitiveTopic)) return true;
  if ([...asked, ...labels].some(isAttentionCheck)) return true;
  if (asksLegalQuestion(asked)) return true;
  return labels.some((label) => optionIsSensitive(asked, label));
}

/**
 * The task's input: every item in the request's order, a sensitive one as its key and option set alone. An item is
 * sensitive by its own text (answerIsSensitive, under the request's scope) or, through `isAnswer`
 * (profile/sensitive-screen.ts, as the tiebreak uses it), when one of its options is one of the person's sensitive
 * answers ("Citizen", their self-described gender), in every scope.
 */
export function answerTaskInput(
  request: AutofillAnswerRequest,
  isAnswer: AnswerScreen = () => false,
): { input: AnswerTaskInput; screened: number } {
  let screened = 0;
  const items = request.items.map((item): AnswerTaskInput['items'][number] => {
    const labels = item.options.map((option) => option.label);
    if (!answerIsSensitive(item, request.scope) && !(labels.length > 0 && isAnswer(labels))) return item;
    screened += 1;
    return { key: item.key, optionSetHash: item.optionSetHash, ...(item.classify ? { classify: true as const } : {}),
      screened: 'sensitive' };
  });
  return {
    input: {
      items,
      scope: request.scope,
      jobText: request.jobText,
      company: request.company,
      jobTitle: request.jobTitle,
      resumeId: request.resumeId,
      canaries: request.canaries,
      ...(request.platform === undefined ? {} : { platform: request.platform }),
    },
    screened,
  };
}

/**
 * True when an `all` request asks an item its scope opened: one naming a legal, criminal-history or pay topic, or an
 * attention check. The person's note is then left out of the prompt (version 3): it goes with ordinary questions only.
 */
export function opensSensitive(scope: AutofillAnswerScope, items: readonly AutofillAnswerItem[]): boolean {
  if (scope !== 'all') return false;
  return items.some((item) => {
    const opening = openingOf(item);
    return opening !== null && (opening.attention || opening.topics.size > 0);
  });
}


const BASES: ReadonlySet<unknown> = new Set(AUTOFILL_ANSWER_BASES);

/** Claude's basis, when it is one of the list; anything else (none, a word of its own) is a guess. */
const basisOf = (raw: unknown): AutofillAnswerBasis => (BASES.has(raw) ? (raw as AutofillAnswerBasis) : 'guess');

type Settled = Pick<AutofillAnswer, 'index' | 'text' | 'basis' | 'reason' | 'classification' | 'streamedThenVoided'>;

const none = (reason: AutofillAnswer['reason']): Settled => ({ index: null, text: null, basis: null, reason });
const absent = (value: unknown) => value === null || value === undefined;

const CATEGORY_NAMES: ReadonlySet<string> = new Set(AUTOFILL_FIELD_CATEGORIES);
/** v5 (one round): the categories whose answer is never kept under the standard scope (every needs-user category but a
 *  free-text question), and in any scope (self-identification, consent). */
const NEVER_ANSWERED_STANDARD: ReadonlySet<string> = new Set<AutofillFieldCategory>(['sensitive_eeo', 'sensitive_legal',
  'sensitive_compensation', 'consent', 'attention_check']);
const NEVER_ANSWERED: ReadonlySet<string> = new Set<AutofillFieldCategory>(['sensitive_eeo', 'consent']);

/**
 * v5 (one round): an item's answer with its classification, when it asked one (`raw`: Claude's category; 'invalid' or
 * 'sensitive' for an item whose reply was not trusted or that was never asked): `classified` for a name in the closed
 * list, `unknown` for null, `invalid` otherwise. A category whose answer is never kept (NEVER_ANSWERED, and under the
 * standard scope NEVER_ANSWERED_STANDARD) makes the answer `sensitive`, with no value.
 */
export function withClassification(
  item: Pick<AutofillAnswerItem, 'classify'>,
  settled: Settled,
  raw: unknown,
  scope: AutofillAnswerScope = 'standard',
): Settled {
  if (item.classify !== true) return settled;
  const classification: NonNullable<Settled['classification']> =
    raw === 'sensitive' ? { category: null, reason: 'sensitive' }
      : raw === null ? { category: null, reason: 'unknown' }
        : typeof raw === 'string' && CATEGORY_NAMES.has(raw)
          ? { category: raw as AutofillFieldCategory, reason: 'classified' }
          : { category: null, reason: 'invalid' };
  const never = scope === 'all' ? NEVER_ANSWERED : NEVER_ANSWERED_STANDARD;
  const dropped = classification.category !== null && never.has(classification.category);
  return { ...(dropped ? none('sensitive') : settled), classification };
}

/**
 * One item's answer, checked against what the item sent (see settleAnswers). `opening` is the item's under the `all`
 * scope (openingOf), null under the standard one or for an item the `all` screen would have held back.
 */
function settleOne(
  item: AutofillAnswerItem,
  entry: AnswerOutput['answers'][number],
  contacts: OwnContacts,
  opening: Opening | null,
): Settled {
  const { index, text } = entry;
  const answered = (value: Pick<Settled, 'index' | 'text'>): Settled => ({
    ...value,
    basis: opening?.attention ? 'guess' : basisOf(entry.basis),
    reason: 'answered',
  });
  if (item.shape === 'choice') {
    if (!absent(text)) return none('invalid');
    if (absent(index)) return none('no_answer');
    const chosen = typeof index === 'number' ? item.options.find((option) => option.index === index) : undefined;
    if (!chosen) return none('invalid');
    // The screen holds back an item with such an option; an answer that chose one anyway is never stored.
    if (optionIsSensitive([item.question, item.hint, item.section], chosen.label, opening)) return none('sensitive');
    return answered({ index: chosen.index, text: null });
  }
  if (!absent(index)) return none('invalid');
  if (absent(text)) return none('no_answer');
  if (typeof text !== 'string') return none('invalid');
  const clean = cleanDraft(text);
  if (clean === '') return none('no_answer');
  if (holdsPromptMarkup(text) || holdsPromptMarkup(clean)) return none('wrapper');
  // A box that takes one number or one date gets that value, written in its layout, or nothing.
  const value = item.format ? answerInFormat(clean, item.format) : clean;
  if (value === null) return none('invalid');
  if (item.kind !== 'textarea' && value.includes('\n')) return none('invalid');
  if (namesForeignContact(value, contacts) || holdsPostalAddress(value)) return none('contact');
  if (textIsSensitive(value, opening?.topics)) return none('sensitive');
  if (value.length > answerCap(item)) return none('too_long');
  return answered({ index: null, text: value });
}

/**
 * Claude's answer, checked before it is stored. The answer as a whole: a canary anywhere in it or in the reply texts
 * it came from (`replies`, prose outside the sentinels included) makes every item `canary`; Claude speaking as an AI
 * there ("As an AI, ...", "I am an AI": the drafts' speaksAsAnAi, since a written answer may be about the person's AI
 * work), every item `ai_reference`; not one entry per item (one missing, repeated or added), every item `invalid`.
 * Then each item. A choice: `answered` only with one of the item's own sent option indices and no text, unless that
 * option is one the screen holds back (optionIsSensitive), which is `sensitive`; null is `no_answer`; anything else
 * `invalid`. A text: with an index, or not a string, `invalid`; null or nothing left once cleaned, `no_answer`; the
 * prompt's markup, `wrapper`; not one value of the item's `format` (answerInFormat: "5 years", "$85,000", a range, no
 * such date), `invalid`, else that value written in its layout is the text checked and kept; a line break in a
 * one-line input, `invalid`; a foreign link, email address or phone number, or a postal address, `contact`; a
 * statement of a sensitive answer, an EEO answer or a sum of money (with its currency, as "150k" or "85 per hour", or a
 * bare figure of 10,000 or more in a short answer: textIsSensitive), `sensitive`; over its cap (UTF-16 units, as maxLength counts), `too_long`, never cut. An answer's basis is Claude's
 * when it is one of AUTOFILL_ANSWER_BASES, else `guess`.
 *
 * Under the `all` scope (`check.scope`) an item's opening (openingOf) relaxes these: a chosen option of a topic the
 * item opens stays (a decline beside a legal or pay question, an EEO-looking word in an attention check), and so does
 * a text that states its own open topic's answer, or with pay open a sum of money ("$150,000" to a salary question);
 * an EEO answer, a contact detail, an address and a statement of any other topic never do, and an attention check's
 * answer is always `guess`. An item the `all` screen would have held back is checked as the standard scope checks.
 */
export function settleAnswers(
  items: readonly AutofillAnswerItem[],
  answer: AnswerOutput,
  check: { canaries: readonly string[]; contacts: OwnContacts; scope?: AutofillAnswerScope },
  replies: readonly string[] = [],
): Settled[] {
  // v5 (one round): an item that asked its category gets an `invalid` one with any reply not trusted.
  const all = (reason: AutofillAnswer['reason']): Settled[] =>
    items.map((item) => withClassification(item, none(reason), 'invalid'));
  const texts = [...stringsOf(answer), ...replies];
  if (holdsCanary(texts, check.canaries)) return all('canary');
  if (texts.some(speaksAsAnAi)) return all('ai_reference');
  const byItem = entriesByItem(answer.answers, items.length);
  if (!byItem) return all('invalid');
  return items.map((item, at) => {
    const opening = check.scope === 'all' ? openingOf(item) : null;
    const entry = byItem.get(at + 1)!;
    return withClassification(item, settleOne(item, entry, check.contacts, opening), entry.category, check.scope);
  });
}

/** v1.3 C (decision 11): the answers a later request may take from the cache: an answer, or Claude's null. */
const CACHED_ANSWERS: ReadonlySet<AutofillAnswer['reason']> = new Set(['answered', 'no_answer']);
/** ...and, for an item that asked its category, only with a category from the list or Claude's null. */
const CACHED_CLASSIFICATIONS: ReadonlySet<string> = new Set(['classified', 'unknown']);

/** The result cache of one autofill_answer task. */
interface AnswerCache {
  /** The items a cached answer covers, with that answer. */
  read(items: readonly AutofillAnswerItem[]): Promise<Map<AutofillAnswerItem, Settled>>;
  /** Keeps the answers a later request may take; `withoutNote`: they were asked without the person's note. */
  write(asked: readonly AutofillAnswerItem[], settled: readonly Settled[], options: { withoutNote: boolean }): Promise<void>;
}

/**
 * v1.3 C (decision 11): the result cache of autofill_answer, for one account and task. An answer is keyed by:
 * - the item as the prompt shows it (its shape and kind, question, description, section, options, cap and format, and
 *   whether it asks its category), never the extension's key for it, under which the answer is given back;
 * - the scope, and the form's ATS when the item asks its category;
 * - the facts and the job exactly as the prompt quotes them (the cached part of its system prompt: a changed resume,
 *   profile or job text misses), the person's own contact details (an answer is checked against them), and the note
 *   when the prompt quotes it with this item (opensSensitive);
 * - the model and the prompt's version (ai/resultCache.ts);
 * so reopening the same job asks nothing again, and any change of what an answer rests on asks again. An answer comes
 * from the person's facts, so the rows are their account's alone and go with it. A cached answer that holds one of this
 * page's canaries is asked again, and one whose reply was voided after it streamed is never kept.
 */
function answerCacheFor(
  deps: AppDeps,
  userId: string,
  task: AnswerTaskInput,
  facts: DraftFacts,
  family?: RoleFamilyId,
): AnswerCache {
  const model = deps.config.ai.features.autofill_answer.model;
  const key = { kind: 'autofill_answer' as const, model, version: autofillAnswerPrompt.version, scope: { userId } };
  const cache = createResultCache(deps.db, deps.now);
  const base = itemHash({
    context: factsAndJob({ facts, company: task.company, jobTitle: task.jobTitle, jobText: task.jobText }, { note: false }),
    contacts: facts.contacts,
    // v33 PROMPTS (F5): another field's answers are its own; the technical family's key is v3.2's (undefined drops out).
    family: family === TECHNICAL_FAMILY_ID ? undefined : family,
  });
  const note = itemHash(facts.note);
  const hashOf = (item: AutofillAnswerItem) =>
    itemHash({
      base,
      note: opensSensitive(task.scope, [item]) ? '' : note,
      scope: task.scope,
      platform: item.classify === true ? (task.platform ?? null) : null,
      item: {
        shape: item.shape,
        kind: item.kind,
        question: item.question,
        hint: item.hint,
        section: item.section,
        options: item.options,
        maxLength: item.maxLength,
        format: item.format ?? null,
        classify: item.classify === true,
      },
    });
  return {
    async read(items) {
      const hashes = items.map(hashOf);
      const found = await cache.getMany<Settled>(key, hashes);
      const out = new Map<AutofillAnswerItem, Settled>();
      items.forEach((item, at) => {
        const one = found.get(hashes[at]!);
        if (one && !holdsCanary(stringsOf(one), task.canaries)) out.set(item, one);
      });
      await recordCachedItems(deps.db, { atMs: deps.now().getTime(), kind: 'autofill_answer', model, items: out.size });
      return out;
    },
    async write(asked, settled, { withoutNote }) {
      const entries: Array<readonly [string, Settled]> = [];
      asked.forEach((item, at) => {
        const one = settled[at];
        if (!one || one.streamedThenVoided || !CACHED_ANSWERS.has(one.reason)) return;
        if (one.classification && !CACHED_CLASSIFICATIONS.has(one.classification.reason)) return;
        // Asked without the note for another item's sake: not the answer this item's key stands for.
        if (withoutNote && !opensSensitive(task.scope, [item])) return;
        entries.push([hashOf(item), one]);
      });
      await cache.putMany(key, entries);
    },
  };
}

/**
 * Claude's answers to the items no cached answer covers, checked (settleAnswers), each released to the task's stream as
 * it lands (v5); `withoutNote`: the person's note is left out (opensSensitive).
 */
async function askForAnswers(
  ctx: AiTaskContext,
  task: AnswerTaskInput,
  asked: readonly AutofillAnswerItem[],
  facts: DraftFacts,
  withoutNote: boolean,
  family?: RoleFamilyId,
): Promise<Settled[]> {
  let settled: Settled[] = [];
  // Every reply's whole text, for the checks: held here only, never stored or logged.
  const replies: string[] = [];
  const onReply = (text: string) => void replies.push(text);
  const input: AnswerPromptInput = {
    items: asked,
    scope: task.scope,
    jobText: task.jobText,
    company: task.company,
    jobTitle: task.jobTitle,
    ...(task.platform === undefined ? {} : { platform: task.platform }),
    facts: { resume: facts.resume, profile: facts.profile, note: withoutNote ? '' : facts.note },
    family,
  };
  // v5 (the stream): each answer is released as it lands, through the same checks of its own (settleOne) and the
  // reply's up to it (stream.ts); never for a request with canaries, whose reply is checked whole.
  const opening = (item: AutofillAnswerItem) => (task.scope === 'all' ? openingOf(item) : null);
  const publish = ctx.publish;
  const release = task.canaries.length > 0 || publish === undefined ? null : releaseItems<Settled>({
    field: 'answers',
    count: asked.length,
    settle: (entry, number) => withClassification(asked[number - 1]!, settleOne(asked[number - 1]!,
      entry as AnswerOutput['answers'][number], facts.contacts, opening(asked[number - 1]!)), entry.category,
    task.scope),
    publish: (number, one) => {
      const { key, optionSetHash } = asked[number - 1]!;
      publish({ type: 'answer', answer: AutofillAnswerSchema.parse({ key, optionSetHash, ...one }) });
    },
  });
  const check = { canaries: task.canaries, contacts: facts.contacts, scope: task.scope };
  /** The review's security 5: the reply was not trusted as a whole after answers of it were released. */
  let voided = false;
  try {
    const answer = await ctx.runPrompt(autofillAnswerPrompt, input,
      { onReply, ...(release === null ? {} : { onText: (text: string) => release.feed(text) }) });
    settled = settleAnswers(asked, answer, check, replies);
    voided = voidsReleased(answer, answer.answers, asked.length, task.canaries, replies);
  } catch (error) {
    // A reply that never read as the JSON asked for, after answers of it were released: those stand, the rest
    // are invalid, so the task's result holds what its stream sent.
    const kept = release?.committed();
    if (!(error instanceof AiError) || error.kind !== 'malformed' || kept === undefined || kept.size === 0) throw error;
    settled = asked.map((item) => withClassification(item, none('invalid'), 'invalid'));
    voided = true;
  }
  // A released answer is final: the result holds it as the stream sent it, marked when its reply was then voided.
  for (const [number, one] of release?.committed() ?? []) {
    settled[number - 1] = voided ? { ...one, streamedThenVoided: true } : one;
  }
  return settled;
}

/**
 * The autofill_answer task: Claude is asked about the items the screen let through, if any, with the facts
 * `readFacts` gives, under the request's scope. The log names the task, its counts by reason and basis and the scope,
 * never a question, an option, a fact or an answer.
 */
export async function runAutofillAnswer(
  deps: AppDeps,
  task: AnswerTaskInput,
  ctx: AiTaskContext,
  readFacts: ReadDraftFacts,
): Promise<AutofillAnswerResult> {
  if (ctx.userId === null) throw unreadableTask();
  const started = performance.now();
  const userId = ctx.userId;
  const allAsked = task.items.filter((item): item is AutofillAnswerItem => !isScreened(item));
  const settledByItem = new Map<AutofillAnswerItem, Settled>();
  let cachedCount = 0;
  if (allAsked.length) {
    const facts = await readFacts(userId, task.resumeId);
    // v33 PROMPTS (F5): in the applicant's field's words (the resume's; the job title's when theirs is general).
    const family = await writtenFamily(deps, userId, facts.resumeId, { title: task.jobTitle });
    // v1.3 C (decision 11): the answers given before, for this account, to the same item about the same facts and job.
    const cache = answerCacheFor(deps, userId, task, facts, family);
    const fromCache = await cache.read(allAsked);
    cachedCount = fromCache.size;
    for (const [item, one] of fromCache) {
      settledByItem.set(item, one);
      ctx.publish?.({ type: 'answer', answer: AutofillAnswerSchema.parse({ key: item.key, optionSetHash: item.optionSetHash, ...one }) });
    }
    const asked = allAsked.filter((item) => !fromCache.has(item));
    if (asked.length) {
      // The person's note never goes with a question the `all` scope opened (a legal, pay or attention-check one).
      const withoutNote = opensSensitive(task.scope, asked);
      const settled = await askForAnswers(ctx, task, asked, facts, withoutNote, family);
      asked.forEach((item, at) => settledByItem.set(item, settled[at]!));
      await cache.write(asked, settled, { withoutNote });
    }
  }
  const answers = task.items.map((item): AutofillAnswer => {
    const { key, optionSetHash } = item;
    if (isScreened(item)) return { key, optionSetHash, ...withClassification(item, none('sensitive'), 'sensitive') };
    return { key, optionSetHash, ...settledByItem.get(item)! };
  });
  const counts = new Map<string, number>();
  for (const answer of answers) counts.set(answer.reason, (counts.get(answer.reason) ?? 0) + 1);
  const byReason = [...counts].map(([reason, n]) => `${n} ${reason}`).join(', ');
  const guesses = answers.filter((answer) => answer.basis === 'guess').length;
  deps.log.debug(
    `[autofill] autofill_answer task ${ctx.taskId}: ${allAsked.length} asked (${byReason}), ${guesses} guess(es), ` +
      `${task.scope} scope, ${cachedCount} from the cache, ${Math.round(performance.now() - started)} ms`,
  );
  return AutofillAnswerResultSchema.parse({ answers });
}
