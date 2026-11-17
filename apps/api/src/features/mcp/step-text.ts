import { mcpAnalyzePrompt } from '../../ai/prompts/mcp/analyze-job-description';
import { mcpGenerateLetterPrompt } from '../../ai/prompts/mcp/generate-cover-letter';
import { ownAnalyzeParts as ownAnalyzePromptParts } from '../../ai/prompts/mcp/own-analyze-job-description';
import { ownTailorParts as ownTailorPromptParts } from '../../ai/prompts/mcp/own-tailor-resume';
import { mcpReviewPrompt } from '../../ai/prompts/mcp/review-job-keywords';
import { mcpRevisePrompt } from '../../ai/prompts/mcp/revise-resume-ats';
import { mcpTailorPrompt } from '../../ai/prompts/mcp/tailor-resume';
import { mcpWriteLetterPrompt } from '../../ai/prompts/mcp/write-cover-letter';
import type { PromptValues } from '../../ai/prompts/tailor/render';
import { untrustedText } from '../autofill/ai/untrusted';
import { quotedPosting } from '../tailor/analysis';
import { analyzePromptValues, foundKeywordTerms, type RawAnalysis } from '../tailor/keywords';
import {
  coverLetterPromptValues,
  generateLetterPromptValues,
  revisionRound,
  tailorPromptValues,
  type RevisionIssues,
} from '../tailor/pipeline';
import type { JobAnalysis, Profile, TailoredContent } from '../tailor/types';

// v30 ST2: the MCP step prompts' values, from features/mcp/prompts.ts (whose words are now the prompt catalogue's
// mcp area, ai/prompts/mcp). Each step prompt is rendered for one job with the values v1.4's pipeline gives it
// (pipeline.ts tailorPromptValues and the rest), so the person's AI reads what TailorIT's Claude would. steps.ts
// chooses the step and checks its gates; own-ai-tailor.ts asks the own-AI tailor's two prompts.

/** The posting as the prompts quote it: its cleaned text and TailorIT's tripwire line, in one <untrusted> wrapper. */
export function postingForPrompt(posting: string, tripwire: string): string {
  return quotedPosting(`${posting}\n${tripwire}`);
}

/** The own-AI tailor's first prompt: the keyword analysis of the posting (with TailorIT's tripwire, in its wrapper). */
export function ownAnalyzeParts(posting: string, tripwire: string) {
  return ownAnalyzePromptParts({ ...analyzePromptValues(posting), jobDescription: postingForPrompt(posting, tripwire) });
}

/** The own-AI tailor's second prompt: the resume, from the source's profile and the posting's keyword plan. */
export function ownTailorParts(profile: Profile, analysis: JobAnalysis) {
  return ownTailorPromptParts(tailorPromptValues(profile, analysis));
}

export function analyzePromptText(jobId: number, posting: string, tripwire: string): string {
  const values = { ...analyzePromptValues(posting), jobDescription: postingForPrompt(posting, tripwire) };
  return mcpAnalyzePrompt.text({ jobId, values });
}

export function reviewPromptText(jobId: number, posting: string, tripwire: string, firstPass: RawAnalysis): string {
  const values = {
    jobDescription: postingForPrompt(posting, tripwire),
    keywordsJson: JSON.stringify(foundKeywordTerms(firstPass, posting)),
  };
  return mcpReviewPrompt.text({ jobId, values });
}

export function tailorPromptText(jobId: number, profile: Profile, analysis: JobAnalysis): string {
  return mcpTailorPrompt.text({ jobId, values: tailorPromptValues(profile, analysis) });
}

/** The revision's values, as reviseForKeywords builds them, from the draft the last save kept and its issues. */
export function revisePromptValues(draft: TailoredContent, issues: RevisionIssues): PromptValues {
  const clean = (term: string) => untrustedText(term, 500);
  return {
    resumeJson: JSON.stringify({
      summary: draft.summary,
      experience: draft.experience.map(({ title, company, description, achievements }) => ({
        title,
        company,
        description,
        achievements,
      })),
    }),
    missingKeywordsJson: JSON.stringify(issues.missing.map(clean)),
    underusedKeywordsJson: JSON.stringify(issues.underused.map((item) => ({ ...item, term: clean(item.term) }))),
    styleIssuesJson: JSON.stringify(issues.style.map(({ where, problem }) => ({ where, problem }))),
  };
}

export function revisePromptText(
  jobId: number,
  draft: TailoredContent,
  analysis: JobAnalysis,
  profile: Profile,
  round: number,
): string {
  const { issues } = revisionRound(draft, analysis, profile, round);
  return mcpRevisePrompt.text({ jobId, values: revisePromptValues(draft, issues) });
}

export function letterPromptText(
  jobId: number,
  profile: Profile,
  analysis: JobAnalysis | null,
  company: string,
  title: string,
): string {
  return analysis
    ? mcpWriteLetterPrompt.text({ jobId, values: coverLetterPromptValues(profile, analysis, company) })
    : mcpGenerateLetterPrompt.text({ jobId, values: generateLetterPromptValues(profile, company, title) });
}
