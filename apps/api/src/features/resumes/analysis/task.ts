import { z } from 'zod';
import { RESUME_ANALYSIS_VERSION, resumeAnalysisInput } from '@tailorit/shared';
import type { AiTaskContext } from '../../../ai/index';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { readableForImport } from '../upload';
import { RESUME_ANALYSIS_PROMPT_HASH, resumeAnalysisPrompt } from '../../../ai/prompts/resumes/resume-analysis';
import { finishResumeAnalysis } from './grounding';
import { analysisHashOf, skillLists, storeAiResumeAnalysis } from './store';

// The `resume_analysis` AI task: Claude's reading of one uploaded resume, queued by the backlog worker (./backlog.ts)
// on the background slot and owned by the uploader. It reads only the upload's stored extracted_text and writes only
// resume_analyses and the backlog row: the upload's file, text and dates are never touched, and nothing is inserted,
// edited or deleted in resumes.

export const ResumeAnalysisTaskInputSchema = z.object({
  resumeId: z.string().min(1).max(64),
  contentHash: z.string().min(16).max(64),
  version: z.number().int().positive(),
});
export type ResumeAnalysisTaskInput = z.infer<typeof ResumeAnalysisTaskInputSchema>;

export interface ResumeAnalysisTaskResult {
  resumeId: string;
  /** Claude's reading was stored. */
  stored: boolean;
  /**
   * Why nothing was read: the upload was deleted, its text is not the text queued, the reading's version moved on
   * (the server was updated meanwhile), or its text cannot be read.
   */
  skipped?: 'deleted' | 'changed' | 'outdated' | 'unreadable';
}

/** The `resume_analysis` task (resumes/tasks.ts reads its input with ResumeAnalysisTaskInputSchema). */
export async function runResumeAnalysis(
  deps: AppDeps,
  input: ResumeAnalysisTaskInput,
  ctx: AiTaskContext,
): Promise<ResumeAnalysisTaskResult> {
  const userId = ctx.userId;
  if (!userId) throw new AppError('forbidden', 'A resume reading needs an account.');
  const upload = await deps.db.one<{ extracted_text: string | null }>(
    "SELECT extracted_text FROM resumes WHERE id = ? AND user_id = ? AND kind = 'uploaded'",
    [input.resumeId, userId],
  );
  if (!upload) return { resumeId: input.resumeId, stored: false, skipped: 'deleted' };
  const text = upload.extracted_text ?? '';
  if (analysisHashOf(resumeAnalysisInput({ kind: 'uploaded', text })) !== input.contentHash) {
    return { resumeId: input.resumeId, stored: false, skipped: 'changed' };
  }
  if (input.version !== RESUME_ANALYSIS_VERSION) return { resumeId: input.resumeId, stored: false, skipped: 'outdated' };
  if (!readableForImport(text)) return { resumeId: input.resumeId, stored: false, skipped: 'unreadable' };

  const answer = await ctx.runPrompt(resumeAnalysisPrompt, { text });
  const data = finishResumeAnalysis(answer, text, skillLists());
  // runPrompt has recorded on the task which model answered.
  const task = await deps.db.one<{ model: string | null }>('SELECT model FROM ai_tasks WHERE id = ?', [ctx.taskId]);
  const stored = await storeAiResumeAnalysis(deps, {
    resumeId: input.resumeId,
    userId,
    contentHash: input.contentHash,
    data,
    model: task?.model ?? deps.config.ai.features.resume_analysis.model,
    promptHash: RESUME_ANALYSIS_PROMPT_HASH,
  });
  // The next upload in line can start once this task is marked finished.
  deps.services.resumeAnalysis?.backlog.nudge();
  return stored ? { resumeId: input.resumeId, stored } : { resumeId: input.resumeId, stored, skipped: 'deleted' };
}
