import type { CatalogPrompt } from '../types';
import { jobAnalysisPrompt } from './job-analysis';

// v30 ST0: the job-analysis area of the prompt catalogue: the job analysis. ST1 moves them here, one module per
// prompt (`job-analysis/<name>.ts`, made with definePrompt or defineTextPrompt from ../types), each listed below.
// v30 ST1: moved from features/job-analysis/prompt.ts.
export const JOB_ANALYSIS_PROMPTS: readonly CatalogPrompt[] = [jobAnalysisPrompt];
