import type { TailorPromptText } from '../tailor/render';
import type { CatalogPrompt } from '../types';
import { MCP_ANALYZE_ADAPTATIONS, MCP_ANALYZE_TEXT, mcpAnalyzePrompt } from './analyze-job-description';
import { MCP_GENERATE_LETTER_ADAPTATIONS, MCP_GENERATE_LETTER_TEXT, mcpGenerateLetterPrompt } from './generate-cover-letter';
import { instructionsPrompt } from './instructions';
import { OWN_ANALYZE_ADAPTATIONS, OWN_ANALYZE_TEXT, ownAnalyzePrompt } from './own-analyze-job-description';
import { OWN_TAILOR_ADAPTATIONS, OWN_TAILOR_TEXT, ownTailorPrompt } from './own-tailor-resume';
import { personBlockPrompt } from './person-block';
import { prepareAllPrompt } from './prepare-all';
import { MCP_REVIEW_ADAPTATIONS, MCP_REVIEW_TEXT, mcpReviewPrompt } from './review-job-keywords';
import { MCP_REVISE_ADAPTATIONS, MCP_REVISE_TEXT, mcpRevisePrompt } from './revise-resume-ats';
import { stepPreferencesPrompt } from './step-preferences';
import { MCP_TAILOR_ADAPTATIONS, MCP_TAILOR_TEXT, mcpTailorPrompt } from './tailor-resume';
import { mcpToolDescriptionsPrompt } from './tool-descriptions';
import { uploadLetterPrompt } from './upload-cover-letter';
import { writeAnswersPrompt } from './write-answers';
import { MCP_WRITE_LETTER_ADAPTATIONS, MCP_WRITE_LETTER_TEXT, mcpWriteLetterPrompt } from './write-cover-letter';

// v30 ST0: the mcp area of the prompt catalogue: the MCP server (its instructions, step prompts and own-AI texts).
// ST2 moves them here, one module per prompt (`mcp/<name>.ts`, made with definePrompt or defineTextPrompt from
// ../types), each listed below.
// v30 ST2: moved from features/mcp/{instructions,prompts,step-prompts,own-prompts}.ts, word for word. All are text
// prompts: words TailorIT hands to the person's own AI (the server's instructions and prepare_all, each Prepare step's
// prompt, the own-AI tailor's two prompts) or shared parts of them (the <person> fence, the step preferences). How a
// step prompt is put together is render.ts. The "next" lines of the tools' answers stay with the tools (features/mcp):
// they are the answers' protocol. v30 FIX-B (DECISIONS P6.4, REQ-12): the tools', their arguments' and the MCP prompts'
// descriptions are words the person's AI reads: tool-descriptions.ts, which features/mcp reads.
export const MCP_PROMPTS: readonly CatalogPrompt[] = [
  instructionsPrompt,
  personBlockPrompt,
  stepPreferencesPrompt,
  prepareAllPrompt,
  mcpAnalyzePrompt,
  mcpReviewPrompt,
  mcpTailorPrompt,
  mcpRevisePrompt,
  mcpWriteLetterPrompt,
  mcpGenerateLetterPrompt,
  uploadLetterPrompt,
  writeAnswersPrompt,
  ownAnalyzePrompt,
  ownTailorPrompt,
  mcpToolDescriptionsPrompt, // v30 FIX-B
];

/** Each sentence the MCP step prompts change, by prompt: [tailor_builder0's words, the MCP prompt's]. */
export const MCP_ADAPTATIONS = {
  'analyze-job-description': MCP_ANALYZE_ADAPTATIONS,
  'review-job-keywords': MCP_REVIEW_ADAPTATIONS,
  'tailor-resume': MCP_TAILOR_ADAPTATIONS,
  'revise-resume-ats': MCP_REVISE_ADAPTATIONS,
  'write-cover-letter': MCP_WRITE_LETTER_ADAPTATIONS,
  'generate-cover-letter': MCP_GENERATE_LETTER_ADAPTATIONS,
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

/** The MCP step prompts' texts (tailor_builder0's, adapted), by step. */
export const MCP_PROMPT_TEXTS = {
  analyze: MCP_ANALYZE_TEXT,
  review: MCP_REVIEW_TEXT,
  tailor: MCP_TAILOR_TEXT,
  revise: MCP_REVISE_TEXT,
  writeLetter: MCP_WRITE_LETTER_TEXT,
  generateLetter: MCP_GENERATE_LETTER_TEXT,
} satisfies Record<string, TailorPromptText>;

/** Each sentence the own-AI tailor's prompts change (v2.0 FIX-C, REQ-6), by prompt. */
export const OWN_AI_ADAPTATIONS = {
  'analyze-job-description': OWN_ANALYZE_ADAPTATIONS,
  'tailor-resume': OWN_TAILOR_ADAPTATIONS,
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

/** The own-AI tailor's prompt texts. */
export const OWN_AI_PROMPT_TEXTS = { analyze: OWN_ANALYZE_TEXT, tailor: OWN_TAILOR_TEXT } satisfies Record<string, TailorPromptText>;
