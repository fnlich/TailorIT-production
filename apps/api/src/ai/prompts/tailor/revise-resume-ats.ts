import { definePrompt } from '../types';
import { familyText, perFamily } from '../roles/variants';
import { adapt, AnyObjectSchema, BETWEEN_MARKERS, STARTS_WITH_BRACE, tailorPromptParts, type TailorPromptText } from './render';

// v30 ST2: tailor_builder0's revise-resume-ats, moved from features/tailor/prompts/{text,index}.ts. Tailoring's step 5
// (at most twice): the smallest edits that fix what the automated check found. Its text is tailor_builder0's, word for
// word (see analyze-job-description.ts): never edit it here. Changed only as tailor-resume is (the markers).

/** tailor_builder0's `revise-resume-ats`. */
export const REVISE_RESUME_ATS = `You are editing a tailored resume after an automated check. Make the smallest changes that fix the problems listed at the end. Return only the lines you change, and everything you don't return stays word for word. Answer directly without recounting or re-auditing the whole resume. Quoted examples show a shape only, so never reuse their wording or facts.

HOW TO FIX
- Missing keyword: it must appear with its exact words. Prefer adding one new short bullet (12 to 20 words, "bullet": 0) about that work to a role that has room (the newest role holds up to 7 bullets, the next 6, the next 4, older roles 3, and the newest may take one more if nothing else fits). Otherwise rewrite one bullet (its number), still under 35 words. A bullet or role description holds at most 4 keyword phrases (a list of tool or package names doesn't count) and the summary at most 2, so never pile every missing keyword into one line. If no role has room for a new bullet, fold the keyword into a bullet that already covers related work, or into a role description. Place each keyword in a role where it fits that employer and those dates, as part of work that was done. A bullet that only exists to hold a keyword is filler, so say what it covered, for whom or how often. A domain term from an industry the role wasn't in is tied to transferable work, never presented as the employer's industry. A soft skill is shown by what was done, never as a standalone claim.
- Casing never matters to the ATS, so write phrases in normal sentence case. Lowercase common words ("release management") and keep the capitals of product names and acronyms.
- Underused keyword: use it once more in a different role, only where it reads naturally and never more than twice in total.
- Too many keywords in a line: keep the 4 (or 2 in the summary) that fit the work best, and move each of the others to a short bullet of its own where it fits.
- Never lose a keyword while fixing something else: every job keyword already in a line you rewrite stays in it, unless you move it to another line in the same answer.
- Repeated content: a line that repeats another role's line is rewritten to say what this role itself did. Two roles at one company differ in scope, the earlier narrower and hands-on, the later wider.
- Lost figure: a number from the candidate's own profile comes back unchanged (same number, same unit) in the bullet about that same work. If no bullet covers it, add one for that role.
- Style issue: rewrite the named line so it reads like a person wrote it. Drop the flagged phrase or ", which ..." clause and end on the result, or put the result first. Give a repeated opening verb a different one. A sentence that opens with a third-person verb becomes a fragment or past tense. A round percentage (40%, 50%) the profile doesn't give becomes a before-and-after value or a count the line's own facts support, or the number is dropped, and never swap one round figure for another. A summary that pitches ("seeking", "looking to") says what the candidate has done instead. Keep the line's facts and keywords. For the cover letter, return the whole rewritten letter in "coverLetter".
- Never write "applied X skills", "demonstrating X", "leveraging X", or tack a keyword onto the end of a bullet ("..., while adjusting to X", "..., ensuring Y").
- Keep every number, tool and fact you are not asked to change. Plain verbs, past tense, one sentence per bullet, no em dashes, no markdown. Never write a semicolon or a colon in any line you return. Use a period, a comma, the word and, or two sentences instead, and only a clock time like 9:30 keeps its colon. No inflated words, and no adjectives about the candidate or the work. Numbers are digits and symbols are symbols (9 years, 40%, $18k). Never write the job's title. Never mention a 2 a.m. or 3 a.m. page, midnight or the middle of the night, which is an overused cliché.

OUTPUT
Reply with the JSON object and nothing else, with no code fence and no text before or after it. If you want to plan the edits, do it in the first field, "plan", in one line of at most 40 words (or leave it empty). "summary" is the full new summary (3-4 sentences), or "" to keep it. Each edit names the role by its company and its title (a company can have two roles, and the title says which) and either replaces bullet N (1 is the first entry in that role's achievements), adds a bullet ("bullet": 0), or replaces the role's description. "coverLetter" is the full rewritten letter, or "" to keep it:
{
  "plan": "",
  "summary": "",
  "edits": [
    { "company": "", "title": "", "bullet": 2, "text": "" },
    { "company": "", "title": "", "bullet": 0, "text": "" },
    { "company": "", "title": "", "description": "" }
  ],
  "coverLetter": ""
}

INPUT
CURRENT RESUME:
[[resumeJson]]

KEYWORDS MISSING FROM THE RESUME (each must appear):
[[missingKeywordsJson]]

KEYWORDS USED LESS OFTEN THAN THE POSTING REPEATS THEM (current uses and target):
[[underusedKeywordsJson]]

LINES TO FIX (where, problem):
[[styleIssuesJson]]

Write the JSON object now. Your reply starts with { and has nothing before or after the object, no analysis, no notes, no code fence.`;

/** Each sentence TailorIT changed: [tailor_builder0's words, TailorIT's]. */
export const REVISE_RESUME_ADAPTATIONS = [[STARTS_WITH_BRACE, BETWEEN_MARKERS]] as const satisfies ReadonlyArray<readonly [string, string]>;

export const REVISE_PROMPT: TailorPromptText = {
  id: 'revise-resume-ats',
  content: adapt(REVISE_RESUME_ATS, 'revise-resume-ats', REVISE_RESUME_ADAPTATIONS),
  sharedVariables: [],
};

/** v33 PROMPTS (F5): the prompt in a role family's words (the person's); the technical family's is REVISE_PROMPT. */
export const revisePromptFor = perFamily(
  (family): TailorPromptText => ({
    ...REVISE_PROMPT,
    content: adapt(familyText(REVISE_RESUME_ATS, 'revise-resume-ats', family), 'revise-resume-ats', REVISE_RESUME_ADAPTATIONS),
  }),
);

/** revise-resume-ats (step 5, at most twice). */
export const reviseResumePrompt = definePrompt({
  area: 'tailor',
  name: 'revise-resume-ats',
  version: 1,
  description: "Tailoring's step 5: the smallest edits to a tailored resume that fix the problems its ATS check listed.",
  ...tailorPromptParts(revisePromptFor, { quotesPosting: false }),
  output: AnyObjectSchema,
});
