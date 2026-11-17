import { MIN_READABLE_RESUME_TEXT, matchResult, type JobAnalysisView, type MatchResult } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { getResumeEvidence, type ResumeEvidence } from '../resumes/evidence';
import { peekAnalysisForJob } from './analysis';

// One resume against one job's keywords, read-only, for the extension's lookup (features/autofill/lookup.ts): the
// same keywords, evidence text and count as the Jobs page's card (jobs-router.ts matchFor), Resume Score
// (applications/reports.ts) and the tracker's resume picker, so the numbers agree for the same resume.

export interface ResumeJobMatch {
  result: MatchResult;
  /**
   * Whether the number means something. A built resume's text is its own document, so a short one scores what it
   * holds; an upload with under MIN_READABLE_RESUME_TEXT characters is a file TailorIT could not read (a scan), whose
   * 0% would say the resume is wrong for the job. (The resume chooser's fit holds every kind to that floor, since it
   * ranks resumes; here a built resume is never unreadable, only short.)
   */
  readable: boolean;
}

/** The match of a resume's evidence against the job's analysis (both read already). */
function matchOf(analysis: JobAnalysisView, evidence: ResumeEvidence): ResumeJobMatch {
  return {
    result: matchResult(evidence.text, analysis.keywords, evidence.resumeId),
    readable: evidence.kind === 'built' || evidence.text.trim().length >= MIN_READABLE_RESUME_TEXT,
  };
}

/**
 * `resumeId` (one of the account's resumes) against job `jobId`, writing nothing and queueing no AI task: the analysis
 * is read with peekAnalysisForJob, never analysisForJob (whose service `get` saves a missing analysis), quietly, so a
 * failure never logs the job. Null: no such job, or not the account's resume.
 */
export async function matchResumeForJob(
  deps: AppDeps,
  userId: string,
  jobId: number,
  resumeId: string,
): Promise<ResumeJobMatch | null> {
  const analysis = await peekAnalysisForJob(deps, jobId, { quiet: true });
  if (analysis === null) return null;
  const evidence = await getResumeEvidence(deps, userId, resumeId);
  if (evidence === null) return null;
  return matchOf(analysis, evidence);
}
