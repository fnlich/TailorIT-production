import { createHash } from 'node:crypto';
import {
  AUTOFILL_AI_LIMITS,
  AUTOFILL_FORM_LIMITS,
  AutofillSubmittedAnswerValueSchema,
  cutAtWord,
  submittedAnswerFits,
  type AutofillAnswer,
  type AutofillAnswerItem,
  type AutofillKnownQuestion,
  type AutofillSubmittedAnswerValue,
} from '@tailorit/shared/autofill';
import { answerIsSensitive } from '../autofill/ai/answer';
import type { AnswerScreen as ValueScreen } from '../autofill/ai/pick';
import { textIsSensitive } from '../autofill/ai/statements';
import { screenAnswer } from '../autofill/answers/screen';

// Which of a job's known questions a draft answers (v1.5 P). Each question is one of:
// - `profile`: never drafted. A self-identification, legal, pay, consent or attention-check question (the AI answer
//   route's own screen, answer.ts answerIsSensitive, and the saved answers' screen, answers/screen.ts, either one), a
//   question whose options hold one of the person's own sensitive answers (profile/sensitive-screen.ts), one that asks
//   for a personal detail (a name, an email address, a phone number, an address) or a link (LinkedIn, GitHub, a
//   website), and a file. The profile fills it when the person applies; TailorIT's AI never sees it ahead.
// - `draft`: a question the answer prompt takes (a one-line text or a text area; a drop-down list or radio buttons
//   with 2 to 30 options), asked of the AI in batches of PREPARE_ANSWER_BATCH.
// - `not_ready`: any other field (a lone checkbox, a checkbox group, a date, a list too long): its answer is made
//   during auto-apply, by the extension's own path, as before.

export type QuestionState = 'draft' | 'not_ready' | 'profile';

export interface PlannedQuestion {
  question: AutofillKnownQuestion;
  state: QuestionState;
  /** The answer prompt's item for a `draft` question (key `q<id>`), else null. */
  item: AutofillAnswerItem | null;
}

const LIMITS = AUTOFILL_AI_LIMITS.answer;
const CHOICE_KINDS: ReadonlySet<string> = new Set(['select', 'radio', 'combobox']);
const TEXT_KINDS: ReadonlySet<string> = new Set(['text', 'textarea']);
/** A question that asks for a link the profile holds. */
const ASKS_LINK = /\b(?:linked\s?in|git\s?hub|portfolio|web\s?site|url|twitter|blog|personal\s+(?:site|page))\b/i;

/** The item key of a question in an answer batch: its id, never its words. */
export const itemKeyOf = (questionId: number) => `q${questionId}`;

/** A 16-hex option-set hash for a question an ATS API gave (none of its own): only echoed back by the answer task. */
const optionSetOf = (question: AutofillKnownQuestion): string =>
  question.optionSetHash && question.optionSetHash !== ''
    ? question.optionSetHash
    : createHash('sha256').update(JSON.stringify(question.options)).digest('hex').slice(0, 16);

/** The question as the answer prompt's item (a choice or a text, by its kind). */
function itemOf(question: AutofillKnownQuestion, shape: 'choice' | 'text'): AutofillAnswerItem {
  const base = {
    key: itemKeyOf(question.id),
    shape,
    kind: question.kind,
    question: cutAtWord(question.label, LIMITS.question),
    hint: '',
    section: cutAtWord(question.section, LIMITS.section),
  };
  return shape === 'choice'
    ? {
        ...base,
        optionSetHash: optionSetOf(question),
        options: question.options.map((label, index) => ({ index, label: cutAtWord(label, LIMITS.optionLabel) })),
        maxLength: null,
      }
    : { ...base, optionSetHash: null, options: [], maxLength: null };
}

/** Whether a question is never drafted (see above): its words, its options, its kind. */
function neverDrafted(question: AutofillKnownQuestion, isAnswer: ValueScreen): boolean {
  if (question.kind === 'file') return true;
  if (ASKS_LINK.test(question.label)) return true;
  const probe = itemOf(question, CHOICE_KINDS.has(question.kind) ? 'choice' : 'text');
  // The screen reads the words and the options whatever the field's kind.
  const screened = { ...probe, options: question.options.map((label, index) => ({ index, label })) };
  if (answerIsSensitive(screened, 'standard')) return true;
  // The saved answers' screen, with a yes-or-no answer: a legal or self-identification question in other words.
  const asked = { category: null, questionKey: question.questionKey, questionLabel: question.label };
  if (screenAnswer({ ...asked, answer: { kind: 'checked', checked: true } }) !== null) return true;
  return question.options.length > 0 && isAnswer(question.options);
}

/** One question's plan. */
export function planQuestion(question: AutofillKnownQuestion, isAnswer: ValueScreen): PlannedQuestion {
  if (neverDrafted(question, isAnswer)) return { question, state: 'profile', item: null };
  const options = question.options.length;
  if (CHOICE_KINDS.has(question.kind) && options >= 2 && options <= LIMITS.options) {
    return { question, state: 'draft', item: itemOf(question, 'choice') };
  }
  if (TEXT_KINDS.has(question.kind) && options === 0) return { question, state: 'draft', item: itemOf(question, 'text') };
  return { question, state: 'not_ready', item: null };
}

/** The job's questions, each planned, in form order. */
export function planQuestions(questions: readonly AutofillKnownQuestion[], isAnswer: ValueScreen): PlannedQuestion[] {
  return questions.map((question) => planQuestion(question, isAnswer));
}

/** The answer task's answer as a draft's (the 0811 shape), or null when it gave none to keep. */
export function draftValueOf(planned: PlannedQuestion, answer: AutofillAnswer | undefined): AutofillSubmittedAnswerValue | null {
  if (!answer || answer.reason !== 'answered' || !planned.item) return null;
  let value: AutofillSubmittedAnswerValue | null = null;
  if (planned.item.shape === 'choice') {
    const label = answer.index === null ? undefined : planned.question.options[answer.index];
    value = label ? { kind: 'options', labels: [label] } : null;
  } else if (answer.text !== null && answer.text.trim() !== '') {
    value = { kind: 'text', text: answer.text };
  }
  return value && refusalOfValue(planned, value) === null ? value : null;
}

/** Why a draft answer may not be kept for this question (MCP saves and the server's own answers alike), or null. */
export type ValueRefusal = 'never_drafted' | 'does_not_fit' | 'sensitive';

export function refusalOfValue(planned: PlannedQuestion, value: AutofillSubmittedAnswerValue): ValueRefusal | null {
  if (planned.state === 'profile') return 'never_drafted';
  const { question } = planned;
  if (value.kind === 'file' || !submittedAnswerFits(value, question.kind)) return 'does_not_fit';
  if (value.kind === 'options' && !value.labels.every((label) => question.options.includes(label))) return 'does_not_fit';
  if (value.kind === 'text' && value.text.length > AUTOFILL_FORM_LIMITS.text) return 'does_not_fit';
  const asked = { category: null, questionKey: question.questionKey, questionLabel: question.label };
  if (screenAnswer({ ...asked, answer: value }) !== null) return 'sensitive';
  const words = value.kind === 'text' ? [value.text] : value.kind === 'options' ? value.labels : [];
  return words.some((word) => textIsSensitive(word)) ? 'sensitive' : null;
}

/** A stored answer read back, or null when it no longer reads. */
export function parsedValue(text: string | null): AutofillSubmittedAnswerValue | null {
  if (text === null) return null;
  try {
    const parsed = AutofillSubmittedAnswerValueSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
