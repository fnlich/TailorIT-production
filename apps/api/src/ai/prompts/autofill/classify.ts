import { z } from 'zod';
import {
  ATS_NAMES,
  AUTOFILL_AI_LIMITS,
  AUTOFILL_FIELD_CATEGORIES,
  type AtsKind,
  type AutofillClassifyItem,
  type AutofillFieldCategory,
} from '@tailorit/shared/autofill';
import { untrusted, untrustedList } from '../../../features/autofill/ai/untrusted';
import { definePrompt } from '../types';
import { UNTRUSTED_RULE } from './untrusted';

// v30 ST3: moved word for word from features/autofill/ai/classify.ts (the categories' meanings, the system text, the
// items' lines and the reply's shape); the handler there screens the items, asks this prompt and checks the answer.
// The answer prompt (./answer.ts) quotes CATEGORY_LINES when an item asks its category.
//
// What an unusual question asks (POST /api/autofill/ai/classify, task kind autofill_classify). The extension asks only
// about fields none of its own rules classified. Claude answers a category from the closed list or null; the handler
// keeps an answer only when it is in that list.

const LIMITS = AUTOFILL_AI_LIMITS.classify;

/** Each category with its one-line meaning, in the list's order. */
const MEANINGS: Record<AutofillFieldCategory, string> = {
  first_name: 'the given name',
  middle_name: 'a middle name or initial',
  last_name: 'the family name (surname)',
  full_name: 'the whole name in one field',
  preferred_name: 'the name the person goes by, or a nickname',
  email: 'an email address',
  phone: 'a phone number',
  phone_country_code: "a phone number's country calling code, on its own",
  address_line1: 'the street address',
  address_line2: 'an apartment, suite or unit',
  city: 'a city or town',
  region: 'a state, province or region',
  postal_code: 'a ZIP or postal code',
  country: 'a country (of residence, or of the address)',
  location: 'where the person lives or is based, as one answer ("Austin, TX")',
  linkedin: 'a LinkedIn profile address',
  github: 'a GitHub profile address',
  portfolio: 'a portfolio address',
  website: 'a personal website or another link',
  current_employer: "the person's current company",
  current_title: "the person's current job title",
  employer: 'a company in an entry of the work history',
  job_title: 'a job title in an entry of the work history',
  role_description: 'what the person did, in an entry of the work history',
  years_experience: 'how many years of experience',
  school: 'a school, college or university',
  degree: 'a degree',
  field_of_study: 'a field of study (a major)',
  graduation_date: 'when a degree was or will be completed',
  gpa: 'a grade point average',
  language: 'a language the person speaks',
  language_proficiency: 'how well the person speaks a language',
  skills: 'skills or technologies',
  start_date: 'when the person can start, or when an entry of the work history or education started',
  end_date: 'when an entry of the work history or education ended',
  notice_period: 'how much notice the person must give their current employer',
  relocation: 'whether the person would relocate',
  work_arrangement: 'remote, hybrid or on site',
  referral_source: 'how the person heard about the job',
  resume_upload: 'a resume (CV) file',
  cover_letter_upload: 'a cover letter file',
  sensitive_eeo:
    'gender, sex, pronouns, sexual orientation, race, ethnicity, veteran or military status, disability, age, or ' +
    'any other self-identification',
  sensitive_legal:
    'work authorization, visa or sponsorship, citizenship, criminal history, a background check, a government ID ' +
    'number, or any other legal question',
  sensitive_compensation: 'salary, pay or compensation, expected or current',
  consent: 'an agreement, consent, acknowledgement or privacy statement the person must accept themselves',
  attention_check:
    'a check that a person is reading ("type the word blue", "choose the third option"), or a question about AI',
  free_text_question:
    'an open question for the person to answer in their own words (why this company, a project, a cover letter ' +
    'typed in)',
};

export const CATEGORY_LINES = AUTOFILL_FIELD_CATEGORIES.map((category) => `- ${category}: ${MEANINGS[category]}`).join('\n');

const SYSTEM = `You read the questions of a job application form for a browser extension that fills in each one from
one person's profile. For each ITEM, say what it asks for: one category from this list, or null.

${CATEGORY_LINES}

Rules:
- Decide from the field's label, description, section, options and type together.
- Use one of the last six categories (sensitive_eeo to free_text_question) whenever the question is of that nature,
  even when another category could also fit.
- Answer null when no category fits, or when you cannot tell.
- Answer only with a category name from the list, exactly as written.

${UNTRUSTED_RULE}

Answer every ITEM exactly once, by its number, with a category name or null as "category":
{"items": [{"item": 1, "category": "email"}, {"item": 2, "category": null}]}`;

/** What the prompt module reads: the form's ATS and the asked items alone, numbered 1, 2, ... */
export interface ClassifyPromptInput {
  platform: AtsKind;
  items: readonly AutofillClassifyItem[];
}

const wrappedOrNone = (text: string) => (text.trim() ? untrusted(text, LIMITS.text) : '(none)');

function itemText(item: AutofillClassifyItem, number: number): string {
  const options = item.options.map((option, at) => [at + 1, option] as const);
  return [
    `ITEM ${number}`,
    `Field type: ${item.kind}`,
    `Label: ${wrappedOrNone(item.label)}`,
    `Description: ${wrappedOrNone(item.hint)}`,
    `Section: ${wrappedOrNone(item.section)}`,
    options.length ? `Options:\n${untrustedList(options, LIMITS.text)}` : 'Options: (none)',
  ].join('\n');
}

/** Strict about the shape, lenient about the values: one bad category nulls its item instead of failing the task. */
const ClassifyOutputSchema = z.looseObject({
  items: z.array(z.looseObject({ item: z.unknown(), category: z.unknown() })).max(100),
});
export type ClassifyOutput = z.infer<typeof ClassifyOutputSchema>;

export const autofillClassifyPrompt = definePrompt<ClassifyPromptInput, ClassifyOutput>({
  area: 'autofill',
  name: 'classify',
  version: 1,
  description:
    "What an unusual form question asks: one category from the extension's closed list, or null; the handler keeps " +
    'only a name from that list.',
  kind: 'autofill_classify',
  system: () => SYSTEM,
  user: (input) => {
    const items = input.items.map((item, at) => itemText(item, at + 1));
    return [`The form is on ${ATS_NAMES[input.platform]}.`, ...items].join('\n\n');
  },
  output: ClassifyOutputSchema,
});
