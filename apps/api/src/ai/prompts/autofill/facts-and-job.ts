import { AUTOFILL_AI_LIMITS } from '@tailorit/shared/autofill';
import { untrusted, untrustedText } from '../../../features/autofill/ai/untrusted';
import { defineTextPrompt } from '../types';

// v30 ST3: moved word for word from features/autofill/ai/draft.ts (factsText, wrappedOrNone, PROMPT_JOB_TEXT_MAX,
// factsAndJob), which re-exports the first three for the MCP prompts that quote them. The person's facts and the job as
// the answer and draft prompts quote them in their cached part (PromptModule.context); the answer task's result cache
// keys on these same words (features/autofill/ai/answer.ts).

const LIMITS = AUTOFILL_AI_LIMITS.draft;

/** The most of the resume's and the profile's facts a prompt quotes, each. */
const FACTS_MAX = 12_000;
/** A line of facts as quoted. */
const FACT_LINE_MAX = 2000;

/** The person's own facts as quoted, outside the wrapper: each line cleaned as page text is, capped. */
export function factsText(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => untrustedText(line, FACT_LINE_MAX))
    .filter(Boolean);
  const joined = lines.join('\n');
  return joined === '' ? '(none)' : [...joined].slice(0, FACTS_MAX).join('');
}

/** A page text in its wrapper, or `none` when it is blank. */
export const wrappedOrNone = (text: string, max: number, none: string) => (text.trim() ? untrusted(text, max) : none);

/**
 * v1.3 C (decision 12): the most of a form page's job text an answer or a draft prompt quotes (the request may send
 * 20,000: AUTOFILL_AI_LIMITS). The posting's requirements and duties come first on a page; what a long page holds past
 * this is mostly benefits, legal text and the form.
 */
export const PROMPT_JOB_TEXT_MAX = 12_000;

/**
 * v1.3 C (decision 10): the cached part of an answer's or a draft's system prompt (PromptModule.context): the person's
 * resume and profile facts, their note when `note` is given, then the company, the job title and the job text, in this
 * order. The same facts and job make the same bytes for every batch of one form.
 */
export function factsAndJob(
  input: { facts: { resume: string; profile: string; note?: string }; company: string; jobTitle: string; jobText: string },
  options: { note: boolean },
): string {
  return [
    `RESUME (the applicant's own resume):\n${factsText(input.facts.resume)}`,
    `PROFILE (the applicant's own autofill profile):\n${factsText(input.facts.profile)}`,
    ...(options.note ? [`NOTE (the applicant's own note about themselves, from their profile):\n${factsText(input.facts.note ?? '')}`] : []),
    `COMPANY: ${wrappedOrNone(input.company, LIMITS.company, '(not known)')}`,
    `JOB TITLE: ${wrappedOrNone(input.jobTitle, LIMITS.jobTitle, '(not known)')}`,
    `JOB TEXT: ${wrappedOrNone(
      input.jobText,
      PROMPT_JOB_TEXT_MAX,
      "(not available: the form is on the company's own page, so only the company and the job title are known)",
    )}`,
  ].join('\n\n');
}

/** What the facts-and-job part quotes: the person's facts, the job, and whether the note goes with them. */
export interface FactsAndJobInput {
  facts: { resume: string; profile: string; note?: string };
  company: string;
  jobTitle: string;
  jobText: string;
  note: boolean;
}

export const factsAndJobPrompt = defineTextPrompt<FactsAndJobInput>({
  area: 'autofill',
  name: 'facts-and-job',
  version: 1,
  description:
    "The person's resume and profile facts (their note when asked), then the company, the job title and the job " +
    'text: the cached part of the answer and draft prompts.',
  text: ({ note, ...input }) => factsAndJob(input, { note }),
});
