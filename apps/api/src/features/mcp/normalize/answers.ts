import type { AutofillKnownQuestion, AutofillSubmittedAnswerValue } from '@tailorit/shared/autofill';
import { answerShape } from '../questions';
import { firstOf, isRecord } from './refuse';

// v1.5 Q1: an answer the person's AI saved (prepare_save_answers), normalized strictly to the answer kinds TailorIT
// stores (AutofillSubmittedAnswerValue): {"kind": "text", "text"}, {"kind": "options", "labels"} or {"kind":
// "checked", "checked"}, as the question's answerAs asks. Other shapes are read too: a bare string, number or boolean,
// a list of labels, {"text"}, {"value"}, {"label"}, {"option"}, {"options"}, {"selected"}, {"checked"}. An option's
// label is matched to the question's own options: exactly, then case- and space-insensitively, then to the unique
// closest label; two labels as close are ambiguous and refused. What cannot be made the question's shape is refused
// (one answer alone, with its reason; the save's answer says what each reason asks).

/** Why an answer could not be normalized. */
export type AnswerShapeRefusal = 'does_not_fit' | 'not_an_option' | 'ambiguous_option';

export type NormalizedAnswer = { answer: AutofillSubmittedAnswerValue } | { refusal: AnswerShapeRefusal };

/** A label's comparable form: lower case, every space out. */
const squeezed = (text: string) => text.toLowerCase().replace(/\s+/g, '');
/** A label's words: lower case, punctuation as spaces. */
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .trim();

function bigrams(text: string): string[] {
  const flat = text.replace(/\s+/g, '');
  const pairs: string[] = [];
  for (let index = 0; index < flat.length - 1; index += 1) pairs.push(flat.slice(index, index + 2));
  return pairs;
}

function dice(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (const pair of left) counts.set(pair, (counts.get(pair) ?? 0) + 1);
  let shared = 0;
  for (const pair of right) {
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      shared += 1;
      counts.set(pair, count - 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

/** How close a written label is to an option (0 to 1): one in the other word for word, else letter pairs alike. */
function closeness(written: string, option: string): number {
  const a = wordsOf(written);
  const b = wordsOf(option);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (` ${longer} `.includes(` ${shorter} `)) return 0.6 + 0.4 * (shorter.length / longer.length);
  return dice(a, b);
}

/** The least closeness a label must have to be an option's, and how far ahead of the next it must be. */
export const OPTION_MATCH = { least: 0.6, ahead: 0.1 } as const;

/** One written label as the question's option, or why it is not one. */
export function matchOption(written: string, options: readonly string[]): { label: string } | { refusal: 'not_an_option' | 'ambiguous_option' } {
  const text = written.trim();
  if (!text) return { refusal: 'not_an_option' };
  if (options.includes(text)) return { label: text };
  const same = options.filter((option) => squeezed(option) === squeezed(text));
  if (same.length === 1) return { label: same[0]! };
  if (same.length > 1) return { refusal: 'ambiguous_option' };
  const ranked = options
    .map((option) => ({ option, score: closeness(text, option) }))
    .sort((a, b) => b.score - a.score);
  const [first, second] = ranked;
  if (!first || first.score < OPTION_MATCH.least) return { refusal: 'not_an_option' };
  if (second && second.score >= OPTION_MATCH.least && first.score - second.score < OPTION_MATCH.ahead) {
    return { refusal: 'ambiguous_option' };
  }
  return { label: first.option };
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', 'checked', 'check', 'on', '1', 'agree', 'i agree']);
const FALSE_WORDS = new Set(['no', 'n', 'false', 'unchecked', 'off', '0']);

/** The value inside an answer object of any of the shapes read, else the value itself. */
function innerValue(given: unknown): unknown {
  if (!isRecord(given)) return given;
  if (given.kind === 'text') return given.text;
  if (given.kind === 'options') return given.labels;
  if (given.kind === 'checked') return typeof given.checked === 'boolean' ? given.checked : given.checked ?? given.value;
  const found = firstOf(given, ['text', 'labels', 'label', 'option', 'options', 'selected', 'choice', 'value', 'checked', 'answer']);
  return found ? innerValue(found[1]) : given;
}

/** A yes/no as true/false, from a boolean, a word or 0/1; null otherwise. */
function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase().replace(/[.!]$/, '');
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  return null;
}

/** The answer to `question` in its own shape (answerShape), or why it cannot be. */
export function normalizeAnswer(question: Pick<AutofillKnownQuestion, 'kind' | 'options'>, given: unknown): NormalizedAnswer {
  const shape = answerShape(question);
  const value = innerValue(given);
  if (shape === 'checked') {
    const checked = asBoolean(Array.isArray(value) && value.length === 1 ? value[0] : value);
    return checked === null ? { refusal: 'does_not_fit' } : { answer: { kind: 'checked', checked } };
  }
  if (shape === 'text') {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof text !== 'string' || !text.trim()) return { refusal: 'does_not_fit' };
    return { answer: { kind: 'text', text: text.trim() } };
  }
  // one_option or options: labels, matched to the question's options. A yes/no is "Yes"/"No" for a Yes/No question.
  const raw = typeof value === 'boolean' ? [value ? 'Yes' : 'No'] : typeof value === 'number' ? [String(value)] : value;
  const written = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(written) || written.length === 0 || written.some((label) => typeof label !== 'string')) {
    return { refusal: 'does_not_fit' };
  }
  const labels: string[] = [];
  for (const label of written as string[]) {
    const match = matchOption(label, question.options);
    if ('refusal' in match) return { refusal: match.refusal };
    if (!labels.includes(match.label)) labels.push(match.label);
  }
  if (shape === 'one_option' && labels.length !== 1) return { refusal: 'does_not_fit' };
  return { answer: { kind: 'options', labels } };
}
