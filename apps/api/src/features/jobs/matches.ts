import { matchResult, noResumeMatch, type JobRowMatch } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { getResumeEvidence, type ResumeEvidence } from '../resumes/evidence';
import { peekAnalysisForJob } from './analysis';
import { requireJob } from './store';

// v31 FIX-JOBS: the Jobs feed's per-row measure (GET /api/jobs/matches?ids=…). Each row scores the resume its detail
// scores (the one linked to the job's tracker application while the job is tracked, else the default resume) against
// the job's best analysis so far, read with peekAnalysisForJob: no AI task is queued and nothing is written (opening a
// job, not listing it, is what may ask for an analysis). A job the viewer cannot see is left out, as /api/jobs/:id
// would answer 404 for it.

/** The resume a tracked job scores (the detail's rule, `linkedResumeOf` in ./jobs-router.ts). */
export type LinkedResumeOf = (deps: AppDeps, userId: string, jobId: number) => Promise<string | null>;

/** The keyword match of each job of `ids` for the viewer, in the order asked. */
export async function rowMatches(
  deps: AppDeps,
  userId: string,
  ids: readonly number[],
  linkedResumeOf: LinkedResumeOf,
): Promise<JobRowMatch[]> {
  // One read per resume for the whole request (most rows score the default resume).
  const evidence = new Map<string, Promise<ResumeEvidence | null>>();
  const evidenceOf = (resumeId: string | null) => {
    const key = resumeId ?? '';
    let found = evidence.get(key);
    if (!found) {
      found = getResumeEvidence(deps, userId, resumeId);
      evidence.set(key, found);
    }
    return found;
  };

  const items: JobRowMatch[] = [];
  for (const asked of ids) {
    let job: { id: number };
    try {
      job = await requireJob(deps, asked, userId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'not_found') continue;
      throw error;
    }
    const analysis = await peekAnalysisForJob(deps, job.id);
    const keywords = analysis?.keywords ?? { high: [], low: [] };
    const linkedId = await linkedResumeOf(deps, userId, job.id);
    const resume = (linkedId ? await evidenceOf(linkedId) : null) ?? (await evidenceOf(null));
    const match = resume ? matchResult(resume.text, keywords, resume.resumeId) : noResumeMatch(keywords);
    items.push({
      jobId: asked,
      state: match.state,
      matchedCount: match.matchedCount,
      total: match.total,
      percentage: match.percentage,
    });
  }
  return items;
}
