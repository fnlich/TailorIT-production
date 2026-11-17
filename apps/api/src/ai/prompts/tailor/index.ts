import type { CatalogPrompt } from '../types';
import { analyzeJobPrompt } from './analyze-job-description';
import { GENERATE_COVER_LETTER_ADAPTATIONS, generateCoverLetterPrompt } from './generate-cover-letter';
import { postingTextRulePrompt } from './posting-text-rule';
import { retryNotePrompt } from './retry-note';
import { reviewKeywordsPrompt } from './review-job-keywords';
import { REVISE_RESUME_ADAPTATIONS, reviseResumePrompt } from './revise-resume-ats';
import { TAILOR_RESUME_ADAPTATIONS, tailorResumePrompt } from './tailor-resume';
import { WRITE_COVER_LETTER_ADAPTATIONS, writeCoverLetterPrompt } from './write-cover-letter';

// v30 ST0: the tailor area of the prompt catalogue: tailoring (analyze, review, tailor, revise, the letters,
// humanize, keywords). ST2 moves them here, one module per prompt (`tailor/<name>.ts`, made with definePrompt or
// defineTextPrompt from ../types), each listed below.
// v30 ST2: moved from features/tailor/prompts/: tailor_builder0's six prompts (TailorIT's own AI runs them, kind
// `tailor`), word for word but the sentences each module's adaptations name, and the two shared parts. Their rendering
// (`[[var]]` placeholders split into the cached system part and the message) is render.ts. humanize.ts and keywords.ts
// stay in features/tailor: they check answers, they hold no prompt text.
export const TAILOR_PROMPTS: readonly CatalogPrompt[] = [
  analyzeJobPrompt,
  reviewKeywordsPrompt,
  tailorResumePrompt,
  reviseResumePrompt,
  writeCoverLetterPrompt,
  generateCoverLetterPrompt,
  postingTextRulePrompt,
  retryNotePrompt,
];

/** Each sentence TailorIT changed, by prompt: [tailor_builder0's words, TailorIT's]. Documented in docs/ARCHITECTURE.md. */
export const ADAPTATIONS = {
  'tailor-resume': TAILOR_RESUME_ADAPTATIONS,
  'revise-resume-ats': REVISE_RESUME_ADAPTATIONS,
  'write-cover-letter': WRITE_COVER_LETTER_ADAPTATIONS,
  'generate-cover-letter': GENERATE_COVER_LETTER_ADAPTATIONS,
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;
