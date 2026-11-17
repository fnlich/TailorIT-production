import type { CatalogPrompt } from '../types';
import { echoPrompt } from './echo';
import { jsonInstructionPrompt } from './json-instruction';

// v30 ST0: the system area of the prompt catalogue: the AI layer's own words (ai/runPrompt.ts and ai/queue.ts read
// them).
export const SYSTEM_PROMPTS: readonly CatalogPrompt[] = [jsonInstructionPrompt, echoPrompt];
