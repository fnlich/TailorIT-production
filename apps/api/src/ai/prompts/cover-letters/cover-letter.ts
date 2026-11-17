import { CoverLetterParagraphsSchema, type CoverLetterParagraphs } from '@tailorit/shared';
import { definePrompt } from '../types';
import { guidanceBlocks, letterContext, letterRulesPrompt, pageRule, type CoverLetterPromptInput } from './letter-rules';

// v30 ST1: moved word for word from features/cover-letters/prompts.ts. `cover_letter` writes the body paragraphs of a
// letter without a template (the server wraps them in the name / contact line / greeting / sign-off). It draws facts
// only from the person's resume and reads the job description (the blocks and rules of ./letter-rules.ts).

export const coverLetterPrompt = definePrompt<CoverLetterPromptInput, CoverLetterParagraphs>({
  area: 'cover-letters',
  name: 'cover-letter',
  // 2 (the Phase G review): the extension's job as page text, in wrappers, with their rule. 3 (autofill API version 5):
  // every job so. 4 (v1.3 C): the job and the resume in the system prompt (letterContext, cached), the person's
  // guidance alone in the message; the resume as compact JSON.
  version: 4,
  description: "Writes a cover letter's body paragraphs as the job seeker, from the resume and the job (no template).",
  kind: 'cover_letter',
  system: (input) => `You write the body of a cover letter for a job seeker, as the job seeker.

What to write
- Three or four paragraphs: only the part between the greeting and the sign-off. No greeting, no sign-off, no name, no contact details and no date; the app adds those.
- The first paragraph begins with the word "I".
- Write for this job at this company. Use the job title and the company name, and answer what the job description asks for with the person's real experience.
- A good shape: open with why this work appeals to the person, naming their years of experience or their field only when the resume states it. Then tell one concrete accomplishment from the resume as a short story that leads to what this role needs. Then a second moment that shows how the person works or what they care about. Then what draws them to this company or this kind of work, grounded in the job description. End with one confident, specific closing sentence.
- About 250 to 400 words in all, shorter when the resume is thin or the person asks for it.

${letterRulesPrompt.text()}${pageRule(input.job)}

Answer with {"paragraphs": ["...", "...", "..."]}: three or four strings, one per paragraph, each a few sentences long.`,
  context: (input) => letterContext(input),
  user: (input) => {
    const guidance = guidanceBlocks(input);
    return guidance.length ? guidance.join('\n\n') : 'Write the body of the letter for the JOB above, from the RESUME above.';
  },
  output: CoverLetterParagraphsSchema,
});
