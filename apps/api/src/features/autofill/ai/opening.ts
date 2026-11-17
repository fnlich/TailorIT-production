import type { AutofillAnswerItem } from '@tailorit/shared/autofill';
import { asksLegalQuestion, wordViews } from '../answers/vocabulary';
import { isAttentionCheck, OPEN_TOPICS, sensitiveTopicsOf, type SensitiveTopic } from './screen';
import { holdsSumOfMoney, statedTopicsOf } from './statements';

// v30 ST3: moved unchanged from answer.ts, so the answer prompt (ai/prompts/autofill/answer.ts) marks an attention
// check of the `all` scope from the same reading the handler screens and checks with (answer.ts imports these).

/**
 * An age band an option offers, as the whole option ("Under 40", "40 or over", "Over 65"): the ages from which the
 * law protects a person's age (40 and on), so a team's size ("Under 10", "10 or more") is no age band.
 */
const AGE_BAND =
  /^(?:(?:under|over|below|above|younger than|older than|at least|less than|more than) (?:40|50|55|60|65)(?: years?(?: old| of age)?)?|(?:40|50|55|60|65)(?: years?)? (?:or|and) (?:over|older|above|more|up)(?: years?(?: old| of age)?)?)$/;

export const isAgeBand = (label: string) => wordViews(label).some((view) => AGE_BAND.test(view));

/**
 * What an item of the `all` scope may be answered with: the open topics (screen.ts's OPEN_TOPICS) it names, and
 * whether it is an attention check (screen.ts's isAttentionCheck over its question, hint, section or options), whose
 * own words may name a consent ("To prove you read this, choose Strongly disagree").
 */
export interface Opening {
  topics: ReadonlySet<SensitiveTopic>;
  attention: boolean;
}

/** Whether an item's opening lets a topic through: an open topic, or a consent in an attention check's own words. */
export const lets = (opening: Opening, topic: SensitiveTopic) =>
  OPEN_TOPICS.has(topic) || (opening.attention && topic === 'consent');

/**
 * The opening of an item of the `all` scope, or null when it names a topic that is never asked (self-identification,
 * an identity number, a consent outside an attention check). Its topics: those its question, hint, section and options
 * name by the terms (screen.ts's sensitiveTopicsOf) or state (statements.ts's statedTopicsOf: "Permanent resident" is
 * work authorization), work authorization and age for a legal question in other words (answers/vocabulary.ts's
 * asksLegalQuestion), pay for an option that is a sum of money, age for an age band.
 */
export function openingOf(item: AutofillAnswerItem): Opening | null {
  const asked = [item.question, item.hint, item.section];
  const labels = item.options.map((option) => option.label);
  const attention = [...asked, ...labels].some(isAttentionCheck);
  const topics = new Set<SensitiveTopic>();
  for (const text of [...asked, ...labels]) for (const topic of sensitiveTopicsOf(text)) topics.add(topic);
  for (const label of labels) for (const topic of statedTopicsOf(label)) topics.add(topic);
  if (asksLegalQuestion(asked)) topics.add('authorization').add('age');
  if (labels.some(holdsSumOfMoney)) topics.add('pay');
  if (labels.some(isAgeBand)) topics.add('age');
  const opening = { topics, attention };
  return [...topics].every((topic) => lets(opening, topic)) ? opening : null;
}
