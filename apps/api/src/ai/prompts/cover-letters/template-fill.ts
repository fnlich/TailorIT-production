import { TemplateFillValuesSchema, variableDefinition, type TemplateFillValues } from '@tailorit/shared';
import { definePrompt } from '../types';
import { block, guidanceBlocks, letterContext, letterRulesPrompt, pageRule, type CoverLetterPromptInput } from './letter-rules';

// v30 ST1: moved word for word from features/cover-letters/prompts.ts. `template_fill` writes the AI-generated
// placeholders of a cover letter template, drawing facts only from the person's resume and reading the job description
// (the blocks and rules of ./letter-rules.ts).

export interface TemplateFillPromptInput extends CoverLetterPromptInput {
  /** The template as plain text, placeholders written {{NAME}}. */
  templateText: string;
  /** The AI placeholders to write. */
  names: string[];
  personName: string;
  today: string;
}

/** What each AI placeholder asks the model for (TailorIT's own registry words, made into instructions). */
const AI_VARIABLE_BRIEF: Record<string, string> = {
  FULL_COVER_LETTER:
    'The whole letter: a greeting line, three or four body paragraphs, a sign-off line and the person\'s name, each separated by a blank line.',
  COVER_LETTER_BODY: 'Three or four body paragraphs separated by blank lines. No greeting and no sign-off.',
  COMPANY_APPEAL: 'Two or three sentences on what draws the person to this company and its work, grounded in the job description.',
  ROLE_FIT: 'Two to four sentences connecting the person\'s experience to what the role asks for.',
  CANDIDATE_STRENGTHS: 'Two to four sentences on the strengths from the resume that matter most for this job.',
  SKILL_HIGHLIGHT: 'Two or three sentences showing one skill the job needs in action, through a real example from the resume.',
};

function placeholderList(names: string[]): string {
  return names
    .map((name) => {
      const brief = AI_VARIABLE_BRIEF[name] ?? variableDefinition(name)?.description ?? 'What the name and the text around it ask for, in one to three sentences.';
      return `- ${name}: ${brief}`;
    })
    .join('\n');
}

export const templateFillPrompt = definePrompt<TemplateFillPromptInput, TemplateFillValues>({
  area: 'cover-letters',
  name: 'template-fill',
  // 2 (the Phase G review): the extension's job as page text, in wrappers, with their rule. 3 (autofill API version 5):
  // every job so. 4 (v1.3 C): the job and the resume in the system prompt (letterContext, cached); the template, its
  // placeholders, the sender and the guidance in the message; the resume as compact JSON.
  version: 4,
  description: "Writes the AI placeholders of a cover letter template as the job seeker, from the resume and the job.",
  kind: 'template_fill',
  system: (input) => `You fill in the AI-written parts of a cover letter template for a job seeker, as the job seeker.

The template is a letter of fixed text with placeholders written {{NAME}}. The app fills the person's details, the company, the job title and the date itself. You write only the placeholders listed under PLACEHOLDERS TO WRITE.
- Read the whole template first. Each value must read naturally in its place: continue the sentence or paragraph around it, and never repeat what the fixed text already says (if the template already greets the reader or names the role, do not do it again).
- A value that stands alone as a paragraph may hold several paragraphs separated by a blank line only when its description says so; otherwise write one paragraph.
- Never write placeholders, brackets or notes of your own, and do not wrap values in quotes.

${letterRulesPrompt.text({ family: input.family })}${pageRule(input.job)}

Answer with {"values": {"NAME": "text", ...}}, one entry for every placeholder listed under PLACEHOLDERS TO WRITE.`,
  context: (input) => letterContext(input),
  user: (input) =>
    [
      block('TEMPLATE (placeholders written {{NAME}})', input.templateText),
      `PLACEHOLDERS TO WRITE\n${placeholderList(input.names)}`,
      `THE LETTER IS FROM\n${input.personName.trim() || '(the person; their name is not on the resume)'}, dated ${input.today}.`,
      ...guidanceBlocks(input),
    ].join('\n\n'),
  output: TemplateFillValuesSchema,
});
