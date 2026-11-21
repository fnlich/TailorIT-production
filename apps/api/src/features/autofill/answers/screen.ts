import {
  AUTOFILL_UNSAVED_CATEGORIES,
  AutofillSubmittedAnswerValueSchema, // v33 SHARE-6
  type AutofillFieldCategory,
  type AutofillSubmittedAnswerValue,
} from '@tailorit/shared/autofill';
import { isAttentionCheck, isSensitiveQuestion } from '../ai/screen';
import {
  asksLegalQuestion,
  asksSelfIdentification,
  isEeoOption,
  isEeoText,
  isIdentityLetter,
  isYesNo,
} from './vocabulary';

// Which questions never get a saved answer (work package AF, Phase 6). The self-identification, legal and pay answers
// live only in the autofill profile, where the person gives each one on purpose, and consent and attention checks are
// the person's own on every form. The extension never offers to save one; TailorIT refuses one anyway, by the
// category the extension sent, by the question's own words, screened with the AI steps' terms and folding
// (ai/screen.ts) and the extension's attention-check patterns, and by the answer itself (the Phase 6 review, T6-1): an
// option's label that names a sensitive topic or is an EEO answer, a written answer that is one, and any choice or
// yes or no under a question that asks a legal or self-identification question in other words (vocabulary.ts).

export const SENSITIVE_REFUSAL =
  'TailorIT does not save answers to self-identification, legal, pay or consent questions: those come from your ' +
  'autofill profile, or from you on each form.';
export const ATTENTION_REFUSAL =
  'This question checks that a person is reading the form, so TailorIT does not save an answer to it.';

const UNSAVED: ReadonlySet<string> = new Set(AUTOFILL_UNSAVED_CATEGORIES);

/** The answer's own words: its options' labels, or its text; a checkbox's state and a file's name have none. */
function wordsOf(answer: AutofillSubmittedAnswerValue): string[] {
  if (answer.kind === 'options') return answer.labels;
  return answer.kind === 'text' ? [answer.text] : [];
}

/** True when the answer itself is a self-identification or legal answer, whatever its question's words. */
function isSensitiveAnswer(question: readonly string[], answer: AutofillSubmittedAnswerValue): boolean {
  const words = wordsOf(answer);
  if (answer.kind === 'options' && words.some((label) => isSensitiveQuestion(label) || isEeoOption(label))) return true;
  if (answer.kind === 'text' && isEeoText(answer.text)) return true;
  if (words.some((word) => isIdentityLetter(question, word))) return true;
  // A checkbox's state, or options or a text that are each a yes or a no.
  const yesOrNo = answer.kind === 'checked' || (words.length > 0 && words.every(isYesNo));
  if ((answer.kind !== 'text' || yesOrNo) && asksLegalQuestion(question)) return true;
  return yesOrNo && asksSelfIdentification(question);
}

/** A question and its answer as the screen reads them (a saved answer's, or, v1.3, a submitted one's). */
export interface ScreenedAnswer {
  category: AutofillFieldCategory | null;
  questionKey: string;
  questionLabel: string;
  answer: AutofillSubmittedAnswerValue;
}

/**
 * What the screen finds (v1.3 A: the submitted answers' reuse reads it too): an attention check; a consent question
 * (the person's own on every form); a self-identification, legal or pay question or answer (`sensitive`); or none.
 */
export type AnswerScreen = 'attention_check' | 'consent' | 'sensitive' | null;

export function screenAnswer(body: ScreenedAnswer): AnswerScreen {
  const texts = [body.questionLabel, body.questionKey];
  if (body.category === 'attention_check' || texts.some(isAttentionCheck)) return 'attention_check';
  if (body.category === 'consent') return 'consent';
  const unsaved = body.category !== null && UNSAVED.has(body.category);
  if (unsaved || texts.some(isSensitiveQuestion) || isSensitiveAnswer(texts, body.answer)) return 'sensitive';
  return null;
}

/**
 * v33 SHARE-6 (PLAN F9 "Sensitive answers"; SP v33 PLAN-sharing.md §4 "Sensitive facts and what can be inferred"):
 * whether an answer a form was sent with (a submitted one, or one an apply record keeps) is left out for a reader without
 * Sensitive answers' See. Its question decides first, whatever was answered (its category, its words, or a legal or
 * self-identification question in other words: the screen with a yes-or-no answer, as Prepare's question plan probes
 * it), so two people's answers to one such question are left out alike and nothing tells by its absence what one said;
 * then the answer itself (an EEO answer under a question in plain words). `answer` is the stored value (parsed here).
 */
export function isSensitiveAnswerRow(row: {
  category: AutofillFieldCategory | null;
  questionKey: string;
  questionLabel: string;
  answer: unknown;
}): boolean {
  const asked = { category: row.category, questionKey: row.questionKey, questionLabel: row.questionLabel };
  if (screenAnswer({ ...asked, answer: { kind: 'checked', checked: true } }) === 'sensitive') return true;
  const parsed = AutofillSubmittedAnswerValueSchema.safeParse(row.answer);
  return parsed.success && screenAnswer({ ...asked, answer: parsed.data }) === 'sensitive';
}

/** Why this answer may not be saved, as a sentence for the person; null when it may. */
export function refusalOf(body: ScreenedAnswer): string | null {
  const screen = screenAnswer(body);
  if (screen === 'attention_check') return ATTENTION_REFUSAL;
  return screen === null ? null : SENSITIVE_REFUSAL;
}
