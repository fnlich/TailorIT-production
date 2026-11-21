import { TECHNICAL_FAMILY_ID, type RoleFamilyId } from '@tailorit/shared';
import { AppError } from '../../core/http/errors';
import {
  analysisFromSaved,
  analyzePromptValues,
  foundKeywordTerms,
  toJobAnalysis,
  withMissedKeywords,
  withTargetRoleTitle,
  type RawAnalysis,
} from './keywords';
import type { TailorRun } from './pipeline';
import { referenceFor } from './skills/reference';
import { analyzeJobPrompt, analyzePromptFor } from '../../ai/prompts/tailor/analyze-job-description';
import { promptHash } from '../../ai/prompts/tailor/render';
import { perFamily } from '../../ai/prompts/roles/variants';
import { reviewKeywordsPrompt, reviewPromptFor } from '../../ai/prompts/tailor/review-job-keywords';
import { postingHashOf, type AnalysisStore } from './store';
import type { JobAnalysis } from './types';

// Step 1 of tailoring, tailor_builder0's runJobAnalysis (jobAnalysis.ts) through TailorIT's prompt runner: the
// analysis (analyze-job-description), then the review pass for the keywords it missed (review-job-keywords; a failed
// review keeps the first pass), then the filtering in code. The raw answer of a complete analysis (both passes) is kept
// by store.ts, and a kept one is used with no model call.

/**
 * v33 PROMPTS (F5): the analysis store's prompt hash for a job family: the two prompts whose answer it keeps, in that
 * family's words. Analyses are kept per family; the technical family's hash is ANALYSIS_PROMPT_HASH, unchanged, so
 * every analysis stored before v3.3 stays valid.
 */
export const analysisPromptHash = perFamily((family) => promptHash(analyzePromptFor(family), reviewPromptFor(family)));

/** The analysis store's prompt hash: the two prompts whose answer it keeps (v30 ST2: from features/tailor/prompts). */
export const ANALYSIS_PROMPT_HASH = analysisPromptHash(TECHNICAL_FAMILY_ID);

export const NO_KEYWORDS = 'Claude found no keywords to tailor to in this job description. Please try again.';

/** The posting as the analysis prompts quote it: its cleaned text in one <untrusted> wrapper (see pipeline.ts). */
export function quotedPosting(posting: string): string {
  return `<untrusted>\n${posting}\n</untrusted>`;
}

export interface PostingAnalysis {
  analysis: JobAnalysis;
  /** True when a kept analysis was used, with no model call. */
  kept: boolean;
}

/**
 * The analysis of `posting` (already cleaned as page text is, see service.ts), titled with `title` when the answer
 * left its own blank. `model` is the model the tailoring kind runs on, part of the store's key. v33 PROMPTS (F5): the
 * two prompts are in the job's family's words (`jobFamily`; missing: technical), and the store keeps one analysis per
 * family; the code's filtering reads the job family's skill library.
 */
export async function analyzePosting(
  run: TailorRun,
  posting: string,
  title: string,
  store: AnalysisStore,
  model: string,
  jobFamily?: RoleFamilyId | null,
): Promise<PostingAnalysis> {
  const family = jobFamily ?? TECHNICAL_FAMILY_ID;
  // An analysis is the job's: the code's filtering reads the job family's skill library.
  const skills = referenceFor(family);
  const key = { postingHash: postingHashOf(posting), promptHash: analysisPromptHash(family), model };
  const saved = await store.read(key);
  const fromSaved = saved ? analysisFromSaved(saved, posting, skills) : null;
  if (fromSaved) return { analysis: withTargetRoleTitle(fromSaved, title), kept: true };

  const quoted = quotedPosting(posting);
  const values = { ...analyzePromptValues(posting), jobDescription: quoted };
  // The task's signal alone: these answers copy the posting's own words, a page's tripwire text included, so the page
  // checks (service.ts) never hear them; they hear what is written from them.
  const options = { signal: run.promptOptions?.signal };
  let raw: RawAnalysis = await run.runPrompt(analyzeJobPrompt, { values, family }, options);

  let reviewed = false;
  try {
    const keywordsJson = JSON.stringify(foundKeywordTerms(raw, posting));
    const review = await run.runPrompt(
      reviewKeywordsPrompt,
      { values: { jobDescription: quoted, keywordsJson }, family },
      options,
    );
    raw = withMissedKeywords(raw, review.missing);
    reviewed = true;
  } catch (error) {
    // The first pass is still usable on its own, unless the task was cancelled.
    if (options.signal?.aborted) throw error;
  }

  const analysis = toJobAnalysis(raw, posting, skills);
  if (!analysis.atsKeywords?.length) throw new AppError('ai_failed', NO_KEYWORDS);
  // Only a complete analysis is kept: one whose review pass failed would be reused as the lesser result.
  if (reviewed) await store.save(key, raw, analysis.jobMeta.title);
  return { analysis: withTargetRoleTitle(analysis, title), kept: false };
}
