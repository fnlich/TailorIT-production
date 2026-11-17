import {
  ATS_NAMES,
  PutAutofillSavedAnswerBodySchema,
  type AtsKind,
  type AutofillSavedAnswer,
  type AutofillSavedAnswerValue,
  type PutAutofillSavedAnswerBody,
} from '@tailorit/shared/autofill';
import { defaultTooLong, type TooLongText } from '../../../lib/constants';

// Settings › Autofill › Saved answers, the part that is not React: how a saved answer reads in the list, the edit
// the dialog holds, and the body a save sends. The checks are the contract's own PUT schema, the one the server
// parses with, so the page and the server never disagree about what may be saved.

export const platformName = (platform: AtsKind) => ATS_NAMES[platform];

/** Where an answer is used: "Every company", or "Only northwind (Greenhouse)" for a free-text answer kept for one. */
export function scopeLabel(answer: Pick<AutofillSavedAnswer, 'scope' | 'platform'>): string {
  if (answer.scope === '') return 'Every company';
  const at = answer.scope.indexOf(':');
  const platform = answer.scope.slice(0, at) as AtsKind;
  const board = answer.scope.slice(at + 1);
  return `Only ${board} (${ATS_NAMES[platform] ?? platform})`;
}

/** The answer in one line: the options chosen, the checkbox's state, or the text's start. */
export function answerSummary(answer: AutofillSavedAnswerValue, max = 160): string {
  switch (answer.kind) {
    case 'options':
      return answer.labels.join(', ');
    case 'checked':
      return answer.checked ? 'Ticked' : 'Not ticked';
    case 'text': {
      const line = answer.text.replace(/\s+/g, ' ').trim();
      return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
    }
  }
}

/** Whether the field takes one option or several (an options answer's edit shows one box or a list). */
export const takesSeveral = (answer: Pick<AutofillSavedAnswer, 'fieldKind'>) =>
  answer.fieldKind === 'checkbox-group' || answer.fieldKind === 'multiselect';

/** What the edit dialog holds: the answer in the shape its field takes. */
export type AnswerEdit =
  | { kind: 'text'; text: string }
  | { kind: 'options'; labels: string[] }
  | { kind: 'checked'; checked: boolean };

export function editOf(answer: AutofillSavedAnswer): AnswerEdit {
  const value = answer.answer;
  if (value.kind === 'options') return { kind: 'options', labels: [...value.labels] };
  return { ...value };
}

/** The PUT body for this edit: the same key, so it replaces the answer; Settings sends no category. */
export function bodyOf(answer: AutofillSavedAnswer, edit: AnswerEdit): PutAutofillSavedAnswerBody {
  const value: AutofillSavedAnswerValue =
    edit.kind === 'options'
      ? { kind: 'options', labels: edit.labels.map((label) => label.trim()).filter(Boolean) }
      : edit.kind === 'text'
        ? { kind: 'text', text: edit.text.trim() }
        : { kind: 'checked', checked: edit.checked };
  return {
    questionKey: answer.questionKey,
    optionSetHash: answer.optionSetHash,
    scope: answer.scope,
    fieldKind: answer.fieldKind,
    questionLabel: answer.questionLabel,
    platform: answer.platform,
    answer: value,
    category: null,
  };
}

/** Where an edit's problem is shown: the text box, or the options. */
export type EditPlace = 'text' | 'labels';

/** zod's own sentences start like this; the contract's never do. */
const BUILT_IN_MESSAGE = /^(Too (big|small):|Invalid )/;

/**
 * What a save of this edit would be refused for, by place; empty when it would pass. The contract's sentences as
 * written ("Write the answer", "Each option once"); its "does not fit the field" for options says how many to give; a
 * text past its length reads MSG_TEXT_TOO_LONG (`tooLong`: the dialog passes its `t`'s, v2.0 fix wave REQ-3).
 */
export function validateEdit(
  answer: AutofillSavedAnswer,
  edit: AnswerEdit,
  tooLong: TooLongText = defaultTooLong,
): Partial<Record<EditPlace, string>> {
  const parsed = PutAutofillSavedAnswerBodySchema.safeParse(bodyOf(answer, edit));
  if (parsed.success) return {};
  const problems: Partial<Record<EditPlace, string>> = {};
  for (const issue of parsed.error.issues) {
    const place: EditPlace = edit.kind === 'text' ? 'text' : 'labels';
    let message = BUILT_IN_MESSAGE.test(issue.message) ? 'Check this answer' : issue.message;
    if (issue.path.join('.') === 'answer' && edit.kind === 'options') {
      message = takesSeveral(answer) ? 'Give at least one option' : 'Give exactly one option';
    }
    if (issue.code === 'too_big' && edit.kind === 'text') message = tooLong(Number(issue.maximum));
    problems[place] ??= message;
  }
  return problems;
}

/** The answers whose question or answer holds every word of `query` (any case), in the list's order. */
export function filterAnswers(items: readonly AutofillSavedAnswer[], query: string): AutofillSavedAnswer[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = `${item.questionLabel} ${answerSummary(item.answer, Infinity)} ${scopeLabel(item)}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
