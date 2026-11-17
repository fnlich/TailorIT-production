import type { CatalogPrompt } from '../types';
import { customFilterPrompt } from './custom-filter';

// v30 ST0: the prepare-filters area of the prompt catalogue: the Custom prepare filter. ST2 moves them here, one
// module per prompt (`prepare-filters/<name>.ts`, made with definePrompt or defineTextPrompt from ../types), each
// listed below.
// v30 ST2: moved from features/prepare-filters/custom.ts (which runs it: the `custom_filter` task).
export const PREPARE_FILTERS_PROMPTS: readonly CatalogPrompt[] = [customFilterPrompt];
