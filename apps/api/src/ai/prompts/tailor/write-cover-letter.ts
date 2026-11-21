import { z } from 'zod';
import { CoverLetterParagraphsSchema } from '@tailorit/shared';
import { definePrompt } from '../types';
import { familyText, perFamily } from '../roles/variants';
import { adapt, tailorPromptParts, type TailorPromptText } from './render';

// v30 ST2: tailor_builder0's write-cover-letter, moved from features/tailor/prompts/{text,index}.ts. The letter beside
// step 2, with a posting. Its text is tailor_builder0's, word for word (see analyze-job-description.ts): never edit it
// here. Changed, and only so TailorIT's prompt module can carry it: it answered plain text; it answers
// {"paragraphs": [...]} now, checked like TailorIT's own letters (WRITE_COVER_LETTER_ADAPTATIONS, asserted at load).

/** tailor_builder0's `write-cover-letter`. */
export const WRITE_COVER_LETTER = `Write the body of a cover letter for the candidate and job given at the end.

RULES
- The body only: no greeting, no sign-off. 150-220 words in 2-3 short paragraphs, first person, opening with "I".
- Name the target role once and the company at most twice, written exactly as COMPANY gives it. If COMPANY is {company}, write {company} where the name goes.
- Tell one concrete story from the newest relevant role, covering what was broken or needed, what I did and what changed. Keep it believable for that employer, title and dates, and in that employer's own industry. Don't copy the profile's achievement lines word for word.
- It should read like an email to a hiring manager: plain verbs, contractions are fine (I'm, I've, didn't), sentences of mixed length with a few very short ones, one or two job keywords only where they fit, never a list of them. No list of three things in a row, and no "not just X but Y" or "not X, it's Y" contrasts.
- Tell the story and stop. Don't explain how it proves the fit ("which made me well-suited", "this maps closely to"), and don't close by restating why I'm right for the job; end on a plain sentence about the work.
- Keep the punctuation as plain as a person typing an email. Periods and commas only, never a semicolon and never a colon. Where you would join two clauses with a semicolon, write two sentences. A clock time like 9:30 is fine.
- Numbers are digits and symbols are symbols (9 years, $18k and 45 min to 9, never "nine" or "dollars"). Use only figures the profile gives, and no round percentages.
- Never write "I am excited to apply", "I am writing to express", "I believe I would be a great fit", "I look forward to hearing from you", "Thank you for your consideration", "passionate", "fast-paced", "proven track record", "leverage", "utilize", "spearhead", "championed", "streamlined", "facilitated", "resulting in", "end to end", "I would welcome the opportunity", "I'd bring that same approach", "results-driven", adjectives about me ("dedicated", "motivated", "seasoned"), em dashes, semicolons, colons, markdown, or any story about a 2 a.m. or 3 a.m. page, midnight or the middle of the night, which is an overused cliché.
- Never claim a certification, degree or clearance the profile doesn't list.

Return only the letter body as plain text.

==================================================
THE JOB (the same for every candidate)
==================================================
TARGET JOB TITLE: [[jobTitle]]

COMPANY: [[companyName]]

MAIN RESPONSIBILITIES OF THE JOB:
[[responsibilitiesJson]]

JOB KEYWORDS (use one or two where they fit, never list them):
[[keywordsJson]]

THE CANDIDATE:
[[profileJson]]

Write the letter body now. Start with its first sentence, with no notes or analysis before it and nothing after its last sentence.`;

/** Each sentence TailorIT changed: [tailor_builder0's words, TailorIT's]. */
export const WRITE_COVER_LETTER_ADAPTATIONS = [
  [
    'Return only the letter body as plain text.',
    'Return only the letter body, as {"paragraphs": ["...", "..."]}: one string per paragraph, plain text in each.',
  ],
  [
    'Write the letter body now. Start with its first sentence,',
    'Write the letter body now, as that JSON object. Start its first paragraph with its first sentence,',
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const WRITE_LETTER_PROMPT: TailorPromptText = {
  id: 'write-cover-letter',
  content: adapt(WRITE_COVER_LETTER, 'write-cover-letter', WRITE_COVER_LETTER_ADAPTATIONS),
  sharedVariables: ['jobTitle', 'companyName', 'responsibilitiesJson', 'keywordsJson'],
};

/** v33 PROMPTS (F5): the prompt in a role family's words (the person's); the technical family's is WRITE_LETTER_PROMPT. */
export const writeLetterPromptFor = perFamily(
  (family): TailorPromptText => ({
    ...WRITE_LETTER_PROMPT,
    content: adapt(familyText(WRITE_COVER_LETTER, 'write-cover-letter', family), 'write-cover-letter', WRITE_COVER_LETTER_ADAPTATIONS),
  }),
);

/**
 * A letter's paragraphs, each as TailorIT's own letters check it (CoverLetterParagraphsSchema's paragraph). Two to four:
 * tailor_builder0's prompts ask for 2-3 (write-cover-letter) and 2-4 (generate-cover-letter) paragraphs, where TailorIT's
 * own letter prompt asks for 3-4, so the count follows the prompts kept word for word.
 */
export const TailorLetterOutputSchema = z.object({
  paragraphs: z.array(CoverLetterParagraphsSchema.shape.paragraphs.element).min(2).max(4),
});
export type TailorLetterOutput = z.infer<typeof TailorLetterOutputSchema>;

/** write-cover-letter (beside step 2, with a posting). */
export const writeCoverLetterPrompt = definePrompt({
  area: 'tailor',
  name: 'write-cover-letter',
  version: 1,
  description: "The cover letter beside a tailored resume: its body as paragraphs, from the profile and the job's duties.",
  ...tailorPromptParts(writeLetterPromptFor, { quotesPosting: true }),
  output: TailorLetterOutputSchema,
});
