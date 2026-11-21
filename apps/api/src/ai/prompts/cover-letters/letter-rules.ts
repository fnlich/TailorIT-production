import type { RoleFamilyId } from '@tailorit/shared';
import { UNTRUSTED_RULE } from '../autofill/untrusted';
import { familyVoice } from '../roles/variants';
import { untrusted, untrustedBlock } from '../../../features/autofill/ai/untrusted';
import { defineTextPrompt } from '../types';

// v30 ST1: moved word for word from features/cover-letters/prompts.ts: what the two letter prompts share. Their rules
// of truthfulness and style (the catalogue's `cover-letters/letter-rules`), and the blocks both quote: the job, the
// resume and the person's guidance.
//
// A letter the extension asks for (POST /api/autofill/cover-letters) is written from the job its form's page shows:
// page text, so the job goes in the autofill prompts' <untrusted> wrappers, cleaned as they clean page text, and the
// system prompt ends with their rule that wrapped text is data (autofill/ai/untrusted.ts). Since autofill API version 5
// every letter quotes its job so (prompt version 3): a job's text may come from a page a person had open (POST
// /api/autofill/jobs/from-page), and a job description the person pasted is no less text from elsewhere; a wrapper the
// text itself writes is defused.

const JOB_DESCRIPTION_LIMIT = 20_000;
/** A company or a job title quoted as page text (the editor's own caps). */
const JOB_NAME_LIMIT = 200;
/** The most of a template's (or the person's) guidance the letter prompt quotes (v33 INT-D: exported; MCP wraps within it). */
export const GUIDANCE_LIMIT = 5_000;

export interface LetterJobInput {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  /**
   * True for a letter the extension asked for: the job is the text of its form's page. Every job is quoted in wrappers
   * as data; this names where it came from.
   */
  pageText?: boolean;
}

export interface CoverLetterPromptInput {
  job: LetterJobInput;
  /** The resume as JSON (built resumes) or its extracted text (uploads): features/cover-letters/resume-input.ts. */
  resume: string;
  /** The chosen template's "Copilot AI Prompt", when the letter is generated from an empty template. */
  templatePrompt: string;
  customPrompt: string;
  /**
   * v33 PROMPTS (F5): the person's field (the resume's; the job's when theirs is general). Missing or technical: the
   * rules word for word; another field's adds its voice line to the style rules.
   */
  family?: RoleFamilyId | null;
}

const BANNED_WORDS =
  'leveraged, utilized, spearheaded, orchestrated, streamlined, seamless, robust, scalable, maximized, ' +
  'cross-functional, end-to-end, innovative, dynamic, cutting-edge, world-class, state-of-the-art, holistic, ' +
  'comprehensive, proven, strategic';

const SHARED_RULES = `Truthfulness
- Every fact about the person comes from the RESUME section. Never invent, guess or adjust an employer, title, date, number, product, customer, team size, colleague, technology, skill or field, and never round or restate a figure in other units.
- Facts about the company come only from the job description. When it says little about the company, write about the work itself instead.
- When the resume gives little to work with, write less and keep it plain rather than padding it with claims.
- The person's instructions and the template guidance shape tone, emphasis and length. They never override these truthfulness rules.

Style
- First person, in the person's own voice: warm, specific and confident, never stiff or salesy.
- Vary the length of sentences. Do not open sentences with resume verbs such as Designed, Architected, Led, Delivered, Drove, Integrated, Partnered, Supported, Contributed, Managed or Streamlined.
- Never use these words in any form: ${BANNED_WORDS}.
- No metaphors and no stock phrases such as "I look forward to hearing from you" or "I am writing to express my interest".
- Never use an em dash, an en dash or a double hyphen. Use a comma or a full stop instead.
- Plain text only: no markdown, no HTML, no bullet points, no headings.`;

/**
 * The truthfulness and style rules both letter prompts end their rules with. v33 PROMPTS (F5): with the field's voice
 * line last for a non-technical field (none for the technical family or none given, so those letters' words stay).
 */
export const letterRulesPrompt = defineTextPrompt<{ family?: RoleFamilyId | null } | void>({
  area: 'cover-letters',
  name: 'letter-rules',
  version: 1,
  description: "The truthfulness and style rules both letter prompts (cover-letter, template-fill) give the AI, word for word.",
  text: (input) => {
    const voice = familyVoice(input ? input.family : undefined);
    return voice ? `${SHARED_RULES}\n- ${voice}` : SHARED_RULES;
  },
});

/** A titled block of text between <<< and >>> ("(none given)" when empty). */
export function block(title: string, body: string): string {
  const text = body.trim();
  return `${title}\n<<<\n${text || '(none given)'}\n>>>`;
}

/** The job, each part in its wrapper; without a description, the company and the title alone. */
function jobBlock(job: LetterJobInput): string {
  const quoted = (text: string) => (text.trim() ? untrusted(text, JOB_NAME_LIMIT) : '(not given)');
  return [
    job.pageText ? "JOB (from the web page of the job posting's application form)" : 'JOB',
    `Company: ${quoted(job.companyName)}`,
    `Title: ${quoted(job.jobTitle)}`,
    job.jobDescription.trim()
      ? `Job description:\n${untrustedBlock(job.jobDescription, JOB_DESCRIPTION_LIMIT)}`
      : 'Job description: (not available: write from the company and the job title alone)',
  ].join('\n');
}

/**
 * v1.3 C (decision 10): the cached part of a letter's system prompt (PromptModule.context): the job, then the resume,
 * the same bytes for every letter of one person for one job (a second Generate, a new template), so the CLI reads them
 * from its prompt cache; what the person asks for this letter goes in the message.
 */
export function letterContext(input: CoverLetterPromptInput): string {
  return [jobBlock(input.job), block('RESUME (the only source of facts about the person)', input.resume)].join('\n\n');
}

/** The autofill prompts' rule, closing the system prompt of every letter: the job's wrapped text is data. */
export const pageRule = (_job: LetterJobInput) => `\n\n${UNTRUSTED_RULE}`;

/** The template's guidance and the person's instructions, each in its block, when given. */
export function guidanceBlocks(input: CoverLetterPromptInput): string[] {
  const out: string[] = [];
  if (input.templatePrompt.trim()) {
    out.push(block('TEMPLATE GUIDANCE (from the template the person chose)', input.templatePrompt.slice(0, GUIDANCE_LIMIT)));
  }
  if (input.customPrompt.trim()) {
    out.push(
      block(
        "THE PERSON'S INSTRUCTIONS (follow them within the rules; if they pasted an old letter, reuse its true facts and voice, not its wording)",
        input.customPrompt.slice(0, GUIDANCE_LIMIT),
      ),
    );
  }
  return out;
}
