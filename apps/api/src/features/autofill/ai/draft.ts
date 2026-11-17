import { z } from 'zod';
import {
  AUTOFILL_AI_LIMITS,
  AutofillDraftQuestionSchema,
  AutofillDraftResultSchema,
  AutofillDraftSchema,
  type AutofillDraft,
  type AutofillDraftQuestion,
  type AutofillDraftRequest,
  type AutofillDraftResult,
} from '@tailorit/shared/autofill';
import { AiError, type AiTaskContext } from '../../../ai/index';
import { autofillDraftPrompt, draftCap, type DraftOutput, type DraftPromptInput } from '../../../ai/prompts/autofill/draft';
import type { AppDeps } from '../../../core/context';
import { asksLegalQuestion, asksSelfIdentification } from '../answers/vocabulary';
import { holdsPostalAddress, namesForeignContact, NO_CONTACTS, type OwnContacts } from './contacts';
import { isAttentionCheck, namesSensitiveTopic } from './screen';
import { statesSensitiveAnswer, textIsSensitive } from './statements';
import { releaseItems, voidsReleased } from './stream';
import { entriesByItem, holdsCanary, readTaskInput, speaksAsAnAi, stringsOf, unreadableTask } from './tasks';
import { holdsPromptMarkup } from './untrusted';

export { namesForeignContact } from './contacts';

// A draft for a free-text question (POST /api/autofill/ai/draft, task kind autofill_draft): "Why do you want to work
// here?". The extension writes a draft into its field as the person's answer, marked `llm-draft` (since v2 it no
// longer waits for the person to confirm it); the same route rewrites a field's current text ("Edit with AI", the
// question's `currentAnswer`, with the person's own `instruction` since version 3) and answers the side panel's custom
// question (one question, the person's own words, AUTOFILL_CUSTOM_QUESTION_LENGTHS). Claude writes from the person's
// resume and autofill profile, with the profile's "Anything else we should know?" note (version 3), which TailorIT
// reads itself when the task runs (ReadDraftFacts: never the sensitive part, no name, contact details or address, no
// line that states a sensitive answer), and from the job text, which is page text like the questions. A question that
// looks sensitive (the shared terms and the server's stricter ones) or like an attention check is never asked, nor is
// one whose current answer or instruction holds a sensitive answer (a statement of one, an EEO answer, a sum of
// money), a contact detail or a postal address, or whose instruction names a sensitive topic: a current answer is sent
// as the person wrote it, its line breaks kept; an instruction is quoted in its wrapper, as data about what the person
// wants the answer to say.
// Every draft is checked before it is stored: a canary, or Claude speaking as an AI, anywhere in the reply discards
// them all; the prompt's wrapper, the JSON sentinels, a link, email address or phone number that is not the person's
// own, or a statement of a sensitive answer discards that draft; one over its cap is cut at the last sentence end
// within it, or discarded. v30 ST3: the prompt is ai/prompts/autofill/draft.ts.

const LIMITS = AUTOFILL_AI_LIMITS.draft;

/** A question the screen held back: its key alone. */
const ScreenedDraftSchema = AutofillDraftQuestionSchema.pick({ key: true }).extend({
  screened: z.literal('sensitive'),
});
type ScreenedDraft = z.infer<typeof ScreenedDraftSchema>;

/**
 * What an autofill_draft task stores (its input, read again by the handler): the request's questions in its order, a
 * sensitive one as its key alone, and the rest of the request. The resume is named, not copied: the handler reads the
 * facts when it runs.
 */
const DraftTaskInputSchema = z.object({
  questions: z.array(z.union([ScreenedDraftSchema, AutofillDraftQuestionSchema])).min(1).max(LIMITS.questions),
  jobText: z.string().max(LIMITS.jobText),
  company: z.string().max(LIMITS.company),
  jobTitle: z.string().max(LIMITS.jobTitle),
  resumeId: z.string().max(64).nullable(),
  canaries: z.array(z.string().max(LIMITS.canary)).max(LIMITS.canaries),
});
export type DraftTaskInput = z.infer<typeof DraftTaskInputSchema>;

/** v30 ST3: the autofill_draft task's `parse` (ai-tasks.ts): its stored input, or the task fails. */
export const readDraftTaskInput = (raw: unknown): DraftTaskInput => readTaskInput(DraftTaskInputSchema, raw);

const isScreened = (question: DraftTaskInput['questions'][number]): question is ScreenedDraft =>
  'screened' in question;

/**
 * A question is not drafted when it names a sensitive topic (the shared terms or the server's stricter ones:
 * screen.ts's namesSensitiveTopic), asks a legal or self-identification question in other words ("Will you need us
 * to support your stay?", "Do you identify as a woman?": answers/vocabulary.ts), or looks like an attention check.
 * Nor is it rewritten when its current answer, which Claude would read as written, holds a sensitive answer
 * (statements.ts's textIsSensitive: "I am 34.", "Female", "$150,000 base"), a link, an email address, a phone number
 * or a postal address (a signature): those never reach Claude. The same for its instruction (version 3), which is
 * also held back when it names a sensitive topic or asks a legal or self-identification question in other words ("say
 * I need no sponsorship").
 */
function draftIsSensitive(question: AutofillDraftQuestion): boolean {
  const asked = [question.question];
  if (namesSensitiveTopic(question.question) || isAttentionCheck(question.question)) return true;
  if (asksLegalQuestion(asked) || asksSelfIdentification(asked)) return true;
  const current = question.currentAnswer ?? '';
  if (textIsSensitive(current) || namesForeignContact(current, NO_CONTACTS) || holdsPostalAddress(current)) return true;
  const instruction = question.instruction ?? '';
  if (!instruction.trim()) return false;
  return (
    namesSensitiveTopic(instruction) ||
    asksLegalQuestion([instruction]) ||
    asksSelfIdentification([instruction]) ||
    textIsSensitive(instruction) ||
    namesForeignContact(instruction, NO_CONTACTS) ||
    holdsPostalAddress(instruction)
  );
}

/** The task's input: every question in the request's order, a sensitive one as its key alone. */
export function draftTaskInput(request: AutofillDraftRequest): { input: DraftTaskInput; screened: number } {
  let screened = 0;
  const questions = request.questions.map((question): DraftTaskInput['questions'][number] => {
    if (!draftIsSensitive(question)) return question;
    screened += 1;
    return { key: question.key, screened: 'sensitive' };
  });
  return {
    input: {
      questions,
      jobText: request.jobText,
      company: request.company,
      jobTitle: request.jobTitle,
      resumeId: request.resumeId,
      canaries: request.canaries,
    },
    screened,
  };
}

/**
 * What a draft may say about the person, read by TailorIT itself when the task runs (features/autofill/draft-facts.ts,
 * outside this folder, which reads the profile but never its sensitive part).
 */
export interface DraftFacts {
  /** The resume's facts as plain text, contact details and statements of sensitive answers left out; '' for none. */
  resume: string;
  /** The autofill profile's work history, education, languages, skills and job preferences, the same way; '' when it
   *  has none. */
  profile: string;
  /** The profile's "Anything else we should know?" note (version 3), the same way: the applicant's own words about
   *  themselves; '' for none. */
  note: string;
  /** The person's own links, email addresses and phone numbers: a draft may name these and no others. Never sent. */
  contacts: OwnContacts;
}

/** Reads the facts for a draft task of `userId`'s: `resumeId`, else the profile's resume, else the default, else the
 *  latest; a resume deleted since the request was made gives no resume facts. */
export type ReadDraftFacts = (userId: string, resumeId: string | null) => Promise<DraftFacts>;

/** Format characters (zero-width, bidi controls) go; other whitespace and control characters but the line break
 *  become spaces. */
const FORMAT = /\p{Cf}/gu;
const SPACE_BUT_NEWLINE = /[^\S\n]/g;
const CONTROL = /\p{Cc}/gu;

/** A draft as the field gets it: invisible characters gone, spaces tidied, at most one empty line in a row. */
export function cleanDraft(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(FORMAT, '')
    .replace(SPACE_BUT_NEWLINE, ' ')
    .replace(CONTROL, (character) => (character === '\n' ? character : ' '))
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A sentence's end: its mark and any closing quotes or brackets, then a space or the end of the text. */
const SENTENCE_END = /[.!?\u2026]["'\u201D\u2019)\]]*(?=\s|$)/g;

/**
 * Words a full stop ends without ending the sentence (the Phase 6 review, T6-5): "Acme Corp.", "e.g.", "Dr. Lee".
 * Compared in lower case, without the stop.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'corp', 'inc', 'ltd', 'co', 'llc', 'plc', 'bros', 'intl', 'dept', 'univ', 'assn', 'est', 'approx', 'vs', 'etc',
  'cf', 'viz', 'al', 'ca', 'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'no', 'nos', 'vol',
  'fig', 'gov', 'gen', 'col', 'lt', 'sgt', 'capt', 'rev', 'hon', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'sept', 'oct', 'nov', 'dec',
]);

/** The word right before a full stop, letters, digits and inner stops only ("Corp", "e.g", "U.S", "J"). */
const WORD_BEFORE = /[\p{L}\p{N}.]+$/u;

/**
 * True when a full stop ends an abbreviation, not its sentence: one of ABBREVIATIONS, letters and stops in turn
 * ("e.g.", "i.e.", "U.S.", "Ph.D."), or a capital initial ("J. Smith").
 */
function endsAbbreviation(before: string): boolean {
  const word = WORD_BEFORE.exec(before)?.[0] ?? '';
  return (
    ABBREVIATIONS.has(word.toLowerCase()) || /^(?:\p{L}{1,2}\.)+\p{L}{1,2}$/u.test(word) || /^\p{Lu}$/u.test(word)
  );
}

/**
 * `text` cut after the last sentence end within `cap` UTF-16 units (an input's maxLength counts those), or null. A
 * full stop after an abbreviation or an initial ends no sentence.
 */
export function cutAtSentence(text: string, cap: number): string | null {
  let end = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const stop = match.index + match[0].length;
    if (stop > cap) break;
    if (match[0].startsWith('.') && endsAbbreviation(text.slice(0, match.index))) continue;
    end = stop;
  }
  const kept = text.slice(0, end).trimEnd();
  return kept === '' ? null : kept;
}

type Settled = Pick<AutofillDraft, 'text' | 'reason' | 'streamedThenVoided'>;

/**
 * Claude's answer, checked before it is stored. The answer as a whole: a canary anywhere in it or in the reply texts
 * it came from (`replies`, prose outside the sentinels included) makes every draft `canary`; Claude speaking as an AI
 * there ("As an AI, ...", "I am an AI": speaksAsAnAi; a draft about AI work or an AI product is no reason), every
 * draft `ai_reference`; not one entry per question (one missing, repeated or added), every draft `invalid`. Then each
 * draft: not a text is `invalid`; nothing left once cleaned is `empty`; the prompt's markup is `wrapper`; a foreign
 * link, email address or phone number is `contact`; a statement of a sensitive answer (statements.ts) is `sensitive`;
 * within its cap it is `drafted`, else cut at the last sentence end within it (`trimmed`) or `too_long`. Only
 * `drafted` and `trimmed` keep their text.
 */
export function settleDrafts(
  questions: readonly AutofillDraftQuestion[],
  answer: DraftOutput,
  check: { canaries: readonly string[]; contacts: OwnContacts },
  replies: readonly string[] = [],
): Settled[] {
  const all = (reason: AutofillDraft['reason']): Settled[] => questions.map(() => ({ text: null, reason }));
  const texts = [...stringsOf(answer), ...replies];
  if (holdsCanary(texts, check.canaries)) return all('canary');
  if (texts.some(speaksAsAnAi)) return all('ai_reference');
  const byItem = entriesByItem(answer.drafts, questions.length);
  if (!byItem) return all('invalid');
  return questions.map((question, at): Settled => settleDraft(question, byItem.get(at + 1)!.text, check.contacts));
}

/** One question's draft, checked on its own (settleDrafts' per-question part; v5: the stream's too). */
function settleDraft(question: AutofillDraftQuestion, raw: unknown, contacts: OwnContacts): Settled {
  if (typeof raw !== 'string') return { text: null, reason: 'invalid' };
  const text = cleanDraft(raw);
  if (text === '') return { text: null, reason: 'empty' };
  if (holdsPromptMarkup(raw) || holdsPromptMarkup(text)) return { text: null, reason: 'wrapper' };
  if (namesForeignContact(text, contacts)) return { text: null, reason: 'contact' };
  if (statesSensitiveAnswer(text)) return { text: null, reason: 'sensitive' };
  const cap = draftCap(question);
  if (text.length <= cap) return { text, reason: 'drafted' };
  const cut = cutAtSentence(text, cap);
  return cut === null ? { text: null, reason: 'too_long' } : { text: cut, reason: 'trimmed' };
}

/**
 * The autofill_draft task: Claude is asked about the questions the screen let through, if any, with the facts
 * `readFacts` gives. The log names the task and its counts by reason, never a question, a fact or a draft.
 */
export async function runAutofillDraft(
  deps: AppDeps,
  task: DraftTaskInput,
  ctx: AiTaskContext,
  readFacts: ReadDraftFacts,
): Promise<AutofillDraftResult> {
  if (ctx.userId === null) throw unreadableTask();
  const started = performance.now();
  const asked = task.questions.filter((question): question is AutofillDraftQuestion => !isScreened(question));
  let settled: Settled[] = [];
  if (asked.length) {
    const facts = await readFacts(ctx.userId, task.resumeId);
    // Every reply's whole text, for the checks: held here only, never stored or logged.
    const replies: string[] = [];
    const onReply = (text: string) => void replies.push(text);
    const input: DraftPromptInput = {
      questions: asked,
      jobText: task.jobText,
      company: task.company,
      jobTitle: task.jobTitle,
      facts: { resume: facts.resume, profile: facts.profile, note: facts.note },
    };
    // v5 (the stream): each draft is released as it lands, through its own checks (settleDraft) and the reply's up to
    // it (stream.ts); never for a request with canaries, whose reply is checked whole.
    const publish = ctx.publish;
    const release = task.canaries.length > 0 || publish === undefined ? null : releaseItems<Settled>({
      field: 'drafts',
      count: asked.length,
      settle: (entry, number) => settleDraft(asked[number - 1]!, entry.text, facts.contacts),
      publish: (number, one) => {
        publish({ type: 'draft', draft: AutofillDraftSchema.parse({ key: asked[number - 1]!.key, ...one }) });
      },
    });
    /** The review's security 5: the reply was not trusted as a whole after drafts of it were released. */
    let voided = false;
    try {
      const answer = await ctx.runPrompt(autofillDraftPrompt, input,
        { onReply, ...(release === null ? {} : { onText: (text: string) => release.feed(text) }) });
      settled = settleDrafts(asked, answer, { canaries: task.canaries, contacts: facts.contacts }, replies);
      voided = voidsReleased(answer, answer.drafts, asked.length, task.canaries, replies);
    } catch (error) {
      // A reply that never read as the JSON asked for, after drafts of it were released: those stand, the rest are
      // invalid, so the task's result holds what its stream sent.
      const kept = release?.committed();
      if (!(error instanceof AiError) || error.kind !== 'malformed' || kept === undefined || kept.size === 0) throw error;
      settled = asked.map((): Settled => ({ text: null, reason: 'invalid' }));
      voided = true;
    }
    // A released draft is final: the result holds it as the stream sent it, marked when its reply was then voided.
    for (const [number, one] of release?.committed() ?? []) {
      settled[number - 1] = voided ? { ...one, streamedThenVoided: true } : one;
    }
  }
  let next = 0;
  const drafts = task.questions.map((question): AutofillDraft => {
    if (isScreened(question)) return { key: question.key, text: null, reason: 'sensitive' };
    return { key: question.key, ...settled[next++]! };
  });
  const counts = new Map<string, number>();
  for (const draft of drafts) counts.set(draft.reason, (counts.get(draft.reason) ?? 0) + 1);
  const byReason = [...counts].map(([reason, n]) => `${n} ${reason}`).join(', ');
  deps.log.debug(
    `[autofill] autofill_draft task ${ctx.taskId}: ${asked.length} asked (${byReason}), ` +
      `${Math.round(performance.now() - started)} ms`,
  );
  return AutofillDraftResultSchema.parse({ drafts });
}
