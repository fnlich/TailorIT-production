import type { SensitiveAnswer } from '@tailorit/shared/autofill';
import { countryDisplayName } from '@tailorit/shared/jobs';
import type { AutofillDraft } from '../draft';

// The Profile tab's "Answer these once" list (v2 Phase D): the answers the extension never guesses and never asks the
// AI for, each with whether the draft holds one. A legal question left unanswered is left blank on the form for the
// person; an equal opportunity question left unanswered gets the form's decline option. Pure, so the page only draws
// it, from the draft as it stands (unsaved edits included).

/** Where an answer is given: the id of its card on the page. */
export const ONCE_SECTIONS = {
  workAuthorization: 'autofill-work-authorization',
  selfIdentification: 'autofill-self-identification',
  otherQuestions: 'autofill-other-questions',
  screening: 'autofill-screening',
} as const;
export type OnceSection = (typeof ONCE_SECTIONS)[keyof typeof ONCE_SECTIONS];

export interface OnceItem {
  /** Stable within the list: the answer's place in the draft ("sensitive.legal.criminalRecord"). */
  id: string;
  label: string;
  section: OnceSection;
  /** Answered, declined ("Prefer not to say"), or not answered yet. */
  state: 'value' | 'declined' | 'not_provided';
  /** What the extension does with the question while it has no answer here. */
  whenMissing: 'blank' | 'decline';
}

const stateOf = (answer: SensitiveAnswer<unknown> | undefined): OnceItem['state'] => answer?.state ?? 'not_provided';

/**
 * The list, in the page's order: each country's work authorization and sponsorship now and in the future (or one
 * "Work authorization" row while no country is listed), the criminal record, then the five equal opportunity answers.
 */
export function onceChecklist(draft: AutofillDraft): OnceItem[] {
  const { workAuthorization, legal, eeo } = draft.sensitive;
  const items: OnceItem[] = [];
  const legalItem = (id: string, label: string, answer: SensitiveAnswer<unknown> | undefined, section: OnceSection) =>
    items.push({ id, label, section, state: stateOf(answer), whenMissing: 'blank' });
  if (workAuthorization.length === 0) {
    items.push({
      id: 'sensitive.workAuthorization',
      label: 'Work authorization: add each country you apply to work in',
      section: ONCE_SECTIONS.workAuthorization,
      state: 'not_provided',
      whenMissing: 'blank',
    });
  }
  workAuthorization.forEach((row, index) => {
    const base = `sensitive.workAuthorization.${index}`;
    const name = countryDisplayName(row.country);
    legalItem(`${base}.authorized`, `Authorized to work in ${name}`, row.authorized, ONCE_SECTIONS.workAuthorization);
    legalItem(`${base}.sponsorshipNow`, `Sponsorship now (${name})`, row.sponsorshipNow, ONCE_SECTIONS.workAuthorization);
    legalItem(
      `${base}.sponsorshipFuture`,
      `Sponsorship in the future (${name})`,
      row.sponsorshipFuture,
      ONCE_SECTIONS.workAuthorization,
    );
  });
  legalItem('sensitive.legal.criminalRecord', 'Criminal record', legal.criminalRecord, ONCE_SECTIONS.otherQuestions);
  const eeoItem = (key: 'gender' | 'hispanicOrLatino' | 'races' | 'veteran' | 'disability', label: string) =>
    items.push({
      id: `sensitive.eeo.${key}`,
      label,
      section: ONCE_SECTIONS.selfIdentification,
      state: stateOf(eeo[key]),
      whenMissing: 'decline',
    });
  eeoItem('gender', 'Gender');
  eeoItem('hispanicOrLatino', 'Hispanic or Latino');
  eeoItem('races', 'Race');
  eeoItem('veteran', 'Veteran status');
  eeoItem('disability', 'Disability');
  return items;
}

/** What a row says of its answer. */
export function onceStatus(item: Pick<OnceItem, 'state' | 'whenMissing'>): string {
  if (item.state === 'value') return 'Answered';
  if (item.state === 'declined') return 'Prefer not to say';
  return item.whenMissing === 'decline'
    ? 'Not answered: the extension declines'
    : 'Not answered: the extension leaves it blank for you';
}
