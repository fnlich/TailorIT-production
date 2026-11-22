import { mcpAnalyzePrompt } from '../../ai/prompts/mcp/analyze-job-description';
import { mcpGenerateLetterPrompt } from '../../ai/prompts/mcp/generate-cover-letter';
import { ownAnalyzeParts as ownAnalyzePromptParts } from '../../ai/prompts/mcp/own-analyze-job-description';
import { ownTailorParts as ownTailorPromptParts } from '../../ai/prompts/mcp/own-tailor-resume';
import { mcpReviewPrompt } from '../../ai/prompts/mcp/review-job-keywords';
import { mcpRevisePrompt } from '../../ai/prompts/mcp/revise-resume-ats';
import { mcpTailorPrompt } from '../../ai/prompts/mcp/tailor-resume';
import { mcpWriteLetterPrompt } from '../../ai/prompts/mcp/write-cover-letter';
import type { RoleFamilyId } from '@tailorit/shared';
import type { PromptValues } from '../../ai/prompts/tailor/render';
import { untrustedText } from '../autofill/ai/untrusted';
import { dataFence } from './screen'; // v34 MCPDIR
import { analyzePromptValues, foundKeywordTerms, type RawAnalysis } from '../tailor/keywords';
import {
  coverLetterPromptValues,
  generateLetterPromptValues,
  revisionRound,
  tailorFitOf,
  tailorPromptValues,
  type RevisionIssues,
  type TailorFit,
} from '../tailor/pipeline';
import type { JobAnalysis, Profile, TailoredContent } from '../tailor/types';

// v30 ST2: the MCP step prompts' values, from features/mcp/prompts.ts (whose words are now the prompt catalogue's
// mcp area, ai/prompts/mcp). Each step prompt is rendered for one job with the values v1.4's pipeline gives it
// (pipeline.ts tailorPromptValues and the rest), so the person's AI reads what TailorIT's Claude would. steps.ts
// chooses the step and checks its gates; own-ai-tailor.ts asks the own-AI tailor's two prompts.
// v33 PROMPTS (F5): each step in its family's words: analyze and review the job's (`jobFamily`), the rest the person's
// fit (`fit`: the person's field, else the job's). Missing reads as technical: tailor_builder0's words, as before.

/**
 * The posting as the prompts quote it: its cleaned text in one <untrusted> wrapper. v34 MCPDIR: the wrapper names the
 * posting and a data id (a fresh one per call, screen.ts newDataId), and its last line is the posting's data label
 * with the same id; it was TailorIT's tripwire line.
 */
export function postingForPrompt(posting: string, id: string): string {
  return dataFence('job posting', posting, id);
}

/** The own-AI tailor's first prompt: the keyword analysis of the posting (fenced with its data id). */
export function ownAnalyzeParts(posting: string, id: string, jobFamily?: RoleFamilyId | null) {
  return ownAnalyzePromptParts({ ...analyzePromptValues(posting), jobDescription: postingForPrompt(posting, id) }, jobFamily);
}

/**
 * v33 SHARE-8 (review; PLAN-sharing.md §7 "Other people's text"): what the slots the profile's owner wrote go through
 * (their resume, a draft made from it, their facts): profileWrapped on another person's profile (profiles.ts ownerWrap),
 * the text as it is on the caller's own (the renderings, and their fixtures, unchanged). TailorIT's own wrappers in the
 * other slots (the posting, the responsibilities) stay as they are.
 */
export type OwnerWrap = (text: string) => string;
const asIs: OwnerWrap = (text) => text;

/** The own-AI tailor's second prompt: the resume, from the source's profile and the posting's keyword plan. */
export function ownTailorParts(
  profile: Profile,
  analysis: JobAnalysis,
  fit: TailorFit = tailorFitOf(),
  wrap: OwnerWrap = asIs, // v33 SHARE-8 (review)
) {
  const values = tailorPromptValues(profile, analysis, fit);
  return ownTailorPromptParts({ ...values, profileJson: wrap(values.profileJson!) }, fit.family);
}

export function analyzePromptText(jobId: number, posting: string, id: string, jobFamily?: RoleFamilyId | null): string {
  const values = { ...analyzePromptValues(posting), jobDescription: postingForPrompt(posting, id) };
  return mcpAnalyzePrompt.text({ jobId, values, family: jobFamily });
}

export function reviewPromptText(
  jobId: number,
  posting: string,
  id: string,
  firstPass: RawAnalysis,
  jobFamily?: RoleFamilyId | null,
): string {
  const values = {
    jobDescription: postingForPrompt(posting, id),
    keywordsJson: JSON.stringify(foundKeywordTerms(firstPass, posting)),
  };
  return mcpReviewPrompt.text({ jobId, values, family: jobFamily });
}

export function tailorPromptText(
  jobId: number,
  profile: Profile,
  analysis: JobAnalysis,
  fit: TailorFit = tailorFitOf(),
  wrap: OwnerWrap = asIs, // v33 SHARE-8 (review)
): string {
  const values = tailorPromptValues(profile, analysis, fit);
  return mcpTailorPrompt.text({ jobId, values: { ...values, profileJson: wrap(values.profileJson!) }, family: fit.family });
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
  fit: TailorFit = tailorFitOf(),
  wrap: OwnerWrap = asIs, // v33 SHARE-8 (review)
): string {
  const { issues } = revisionRound(draft, analysis, profile, round, undefined, fit);
  const values = revisePromptValues(draft, issues);
  // The draft is made from the owner's resume, and its style issues quote it.
  const owners = { resumeJson: wrap(values.resumeJson!), styleIssuesJson: wrap(values.styleIssuesJson!) };
  return mcpRevisePrompt.text({ jobId, values: { ...values, ...owners }, family: fit.family });
}

export function letterPromptText(
  jobId: number,
  profile: Profile,
  analysis: JobAnalysis | null,
  company: string,
  title: string,
  family?: RoleFamilyId | null,
  wrap: OwnerWrap = asIs, // v33 SHARE-8 (review)
): string {
  const values = analysis ? coverLetterPromptValues(profile, analysis, company) : generateLetterPromptValues(profile, company, title);
  const wrapped = { ...values, profileJson: wrap(values.profileJson!) };
  return analysis
    ? mcpWriteLetterPrompt.text({ jobId, values: wrapped, family })
    : mcpGenerateLetterPrompt.text({ jobId, values: wrapped, family });
}
