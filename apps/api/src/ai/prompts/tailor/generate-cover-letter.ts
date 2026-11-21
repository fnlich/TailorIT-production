import { definePrompt } from '../types';
import { familyText, perFamily } from '../roles/variants';
import { adapt, tailorPromptParts, type TailorPromptText } from './render';
import { TailorLetterOutputSchema } from './write-cover-letter';

// v30 ST2: tailor_builder0's generate-cover-letter, moved from features/tailor/prompts/{text,index}.ts. The letter with
// no posting text (or when the letter call beside step 2 failed: tailor_builder0's fallback). Its text is
// tailor_builder0's, word for word (see analyze-job-description.ts): never edit it here. Changed only as
// write-cover-letter is: it answers {"paragraphs": [...]} (GENERATE_COVER_LETTER_ADAPTATIONS, asserted at load).

/** tailor_builder0's `generate-cover-letter`. */
export const GENERATE_COVER_LETTER = `You are helping a real person write the body of a cover letter. It should read like a thoughtful email from a candidate who genuinely wants this job, not like a template.

HOW TO WRITE IT:
- 2-4 short paragraphs, under 250 words total, first person throughout.
- Open the first sentence with "I" and say something specific, not ceremonial.
- Tell one concrete story from the candidate's actual experience ("At X, I...") that maps to what this role likely needs. A number is welcome only if it appears in the profile; never invent one.
- Vary sentence length. Short sentences are good, and so are contractions (I'm, I've, didn't). Plain verbs over inflated ones: built, led, fixed, shipped, ran; never "spearheaded", "leveraged", "utilized", "championed", "streamlined" or "facilitated". No list of three things in a row, and no "not just X but Y" or "not X, it's Y" contrasts.
- Tell the story and stop. Don't explain how it proves the fit ("which made me well-suited", "this maps closely to").
- Numbers are digits and symbols are symbols (9 years, $18k and 45 min to 9, never "nine", "dollars" or "percent").
- Keep the punctuation as plain as a person typing an email. Periods and commas only, never a semicolon and never a colon. Where you would join two clauses with a semicolon, write two sentences. A clock time like 9:30 is fine.
- Mention the company or role naturally at most twice; do not keep repeating the role title.
- End on a confident, plain note about the work itself.

NEVER USE:
- "I am excited to apply", "I am writing to express my interest", "I believe my skills and experience"
- "I look forward to hearing from you", "Thank you for your consideration"
- "results-driven", "proven track record", "passionate about", "fast-paced environment", "dynamic team", "resulting in", "end to end", "I would welcome the opportunity"
- Em-dashes, semicolons, colons, bullet points, or any salutation/sign-off ("Dear...", "Best regards") - body paragraphs ONLY.
- Any story about a 2 a.m. or 3 a.m. page, midnight or the middle of the night, which is an overused cliché.

Return ONLY the cover letter body text, no JSON or other formatting.

PROFILE (contact details left out):
[[profileJson]]

APPLICATION:
- Company: [[companyName]]
- Role: [[role]]
`;

/** Each sentence TailorIT changed: [tailor_builder0's words, TailorIT's]. */
export const GENERATE_COVER_LETTER_ADAPTATIONS = [
  [
    'Return ONLY the cover letter body text, no JSON or other formatting.',
    'Return ONLY the cover letter body, as {"paragraphs": ["...", "..."]}: one string per paragraph, no other formatting.',
  ],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export const GENERATE_LETTER_PROMPT: TailorPromptText = {
  id: 'generate-cover-letter',
  content: adapt(GENERATE_COVER_LETTER, 'generate-cover-letter', GENERATE_COVER_LETTER_ADAPTATIONS),
  sharedVariables: [],
};

/** v33 PROMPTS (F5): the prompt in a role family's words (the person's); the technical family's is GENERATE_LETTER_PROMPT. */
export const generateLetterPromptFor = perFamily(
  (family): TailorPromptText => ({
    ...GENERATE_LETTER_PROMPT,
    content: adapt(
      familyText(GENERATE_COVER_LETTER, 'generate-cover-letter', family),
      'generate-cover-letter',
      GENERATE_COVER_LETTER_ADAPTATIONS,
    ),
  }),
);

/** generate-cover-letter (no posting text). */
export const generateCoverLetterPrompt = definePrompt({
  area: 'tailor',
  name: 'generate-cover-letter',
  version: 1,
  description: 'A cover letter body as paragraphs from the profile, the company and the role, when there is no posting text.',
  ...tailorPromptParts(generateLetterPromptFor, { quotesPosting: true }),
  output: TailorLetterOutputSchema,
});
