import type { CatalogPrompt } from '../types';
import { autofillAnswerPrompt } from './answer';
import { autofillClassifyPrompt } from './classify';
import { autofillDraftPrompt } from './draft';
import { factsAndJobPrompt } from './facts-and-job';
import { autofillPickPrompt } from './pick';
import { untrustedRulePrompt } from './untrusted';

// v30 ST0: the autofill area of the prompt catalogue: autofill (pick, classify, draft, answer, the untrusted-text
// rule). ST3 moves them here, one module per prompt (`autofill/<name>.ts`, made with definePrompt or defineTextPrompt
// from ../types), each listed below.
// v30 ST3: moved word for word from features/autofill/ai (apps/api/test/prompts-autofill.test.ts compares each with
// v2.0's words for fixed inputs). The two shared parts: the untrusted-text rule and the facts-and-job block.
export const AUTOFILL_PROMPTS: readonly CatalogPrompt[] = [
  autofillPickPrompt,
  autofillClassifyPrompt,
  autofillDraftPrompt,
  autofillAnswerPrompt,
  untrustedRulePrompt,
  factsAndJobPrompt,
];
