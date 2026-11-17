import type { CatalogPrompt } from '../types';
import { companySummaryPrompt } from './summary';

// v30 ST0: the companies area of the prompt catalogue: company summaries. E3 (wave 3) moves them here, one module per
// prompt (`companies/<name>.ts`, made with definePrompt or defineTextPrompt from ../types), each listed below.
// v30 E3: the company summaries (13 §8).
export const COMPANIES_PROMPTS: readonly CatalogPrompt[] = [companySummaryPrompt];
