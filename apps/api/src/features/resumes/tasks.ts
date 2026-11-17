import { BulletsRequestSchema } from '@tailorit/shared';
import { entryBulletsPrompt } from '../../ai/prompts/resumes/entry-bullets';
import { resumeAnalysisPrompt } from '../../ai/prompts/resumes/resume-analysis';
import { resumeImportPrompt } from '../../ai/prompts/resumes/resume-import';
import { defineAiTask } from '../../ai/task';
import { writeEntryBullets } from './ai/entryBullets';
import { ImportTaskInputSchema, runResumeImport } from './ai/resumeImport';
import { ResumeAnalysisTaskInputSchema, runResumeAnalysis } from './analysis/task';

// v30 ST1: the resumes feature's AI task kinds (ai/task.ts defineAiTask), listed on resumesFeature.aiTasks, which
// setupServices registers on the AI queue after the feature's services hook. Each reads its stored input with the
// schema its handler read it with before (a failure fails the task as it did), and each is the account's that queued
// it: the editable copy (`resume_import`: Make an editable copy, and the copy line), Write with AI (`entry_bullets`)
// and the AI reading of an upload (`resume_analysis`, queued by the backlog worker for the uploader, on the
// background slot).

export const resumeImportTask = defineAiTask({
  kind: 'resume_import',
  prompts: [resumeImportPrompt],
  parse: ImportTaskInputSchema,
  charge: 'person',
  defaultModel: 'cli',
  run: (deps, input, ctx) => runResumeImport(deps, input, ctx),
});

export const entryBulletsTask = defineAiTask({
  kind: 'entry_bullets',
  prompts: [entryBulletsPrompt],
  parse: BulletsRequestSchema,
  charge: 'person',
  defaultModel: 'cli',
  run: (_deps, request, ctx) => writeEntryBullets(request, ctx),
});

export const resumeAnalysisTask = defineAiTask({
  kind: 'resume_analysis',
  prompts: [resumeAnalysisPrompt],
  parse: ResumeAnalysisTaskInputSchema,
  charge: 'person',
  defaultModel: 'haiku',
  run: (deps, input, ctx) => runResumeAnalysis(deps, input, ctx),
});

/** The kinds resumesFeature registers (always: AI_RESUME_ANALYSIS=off, AI off or no background slot only idles the backlog). */
export const RESUMES_AI_TASKS = [resumeImportTask, entryBulletsTask, resumeAnalysisTask] as const;
