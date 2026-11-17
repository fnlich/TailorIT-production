import type { CatalogPrompt } from '../types';
import { coverLetterPrompt } from './cover-letter';
import { letterRulesPrompt } from './letter-rules';
import { templateFillPrompt } from './template-fill';

// v30 ST0: the cover-letters area of the prompt catalogue: cover letters (a letter, a template fill). ST1 moves them
// here, one module per prompt (`cover-letters/<name>.ts`, made with definePrompt or defineTextPrompt from ../types),
// each listed below. v30 ST1: moved from features/cover-letters/prompts.ts; the rules both letters give the AI are an
// entry of their own (letter-rules).
export const COVER_LETTERS_PROMPTS: readonly CatalogPrompt[] = [coverLetterPrompt, templateFillPrompt, letterRulesPrompt];
