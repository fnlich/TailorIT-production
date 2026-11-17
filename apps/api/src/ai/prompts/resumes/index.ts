import type { CatalogPrompt } from '../types';
import { entryBulletsPrompt } from './entry-bullets';
import { resumeAnalysisPrompt } from './resume-analysis';
import { resumeImportPrompt } from './resume-import';

// v30 ST0: the resumes area of the prompt catalogue: resumes (the import, Write with AI, the resume reading). ST1
// moves them here, one module per prompt (`resumes/<name>.ts`, made with definePrompt or defineTextPrompt from
// ../types), each listed below. v30 ST1: moved from features/resumes/ai/{resumeImport,entryBullets}.ts and
// features/resumes/analysis/prompt.ts.
export const RESUMES_PROMPTS: readonly CatalogPrompt[] = [resumeImportPrompt, entryBulletsPrompt, resumeAnalysisPrompt];
