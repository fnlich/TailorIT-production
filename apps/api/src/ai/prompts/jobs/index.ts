import type { CatalogPrompt } from '../types';
import { jobSearchPrompt } from './ai-search';

// v30 ST0: the jobs area of the prompt catalogue: the AI job search. ST3 moves them here, one module per prompt
// (`jobs/<name>.ts`, made with definePrompt or defineTextPrompt from ../types), each listed below.
// v30 ST3: moved word for word from features/jobs/ai-search.ts (apps/api/test/prompts-jobs.test.ts compares it with
// v2.0's words for fixed inputs).
export const JOBS_PROMPTS: readonly CatalogPrompt[] = [jobSearchPrompt];
