import { AUTOFILL_PROMPTS } from './autofill/index';
import { COMPANIES_PROMPTS } from './companies/index';
import { COVER_LETTERS_PROMPTS } from './cover-letters/index';
import { JOB_ANALYSIS_PROMPTS } from './job-analysis/index';
import { JOBS_PROMPTS } from './jobs/index';
import { MCP_PROMPTS } from './mcp/index';
import { PREPARE_FILTERS_PROMPTS } from './prepare-filters/index';
import { RESUMES_PROMPTS } from './resumes/index';
import { SYSTEM_PROMPTS } from './system/index';
import { TAILOR_PROMPTS } from './tailor/index';
import { promptTexts } from '../runPrompt';
import { catalogueProblems, type CatalogPrompt, type ModelPrompt, type PromptArea, type TextPrompt } from './types';

// v30 ST0: the prompt catalogue, every prompt TailorIT writes, by area (one folder each). A package adds a prompt to
// its area's index.ts, never here; a new area is a new folder, its line in PROMPT_AREAS (types.ts) and its line below
// (a registration file: one marked line per package, appended).

export {
  catalogueProblems,
  definePrompt,
  defineTextPrompt,
  PROMPT_AREAS,
  type CatalogPrompt,
  type ModelPrompt,
  type PromptArea,
  type TextPrompt,
} from './types';

/** Each area's prompts, in PROMPT_AREAS' order. */
export const PROMPTS_BY_AREA: ReadonlyArray<{ area: PromptArea; prompts: readonly CatalogPrompt[] }> = [
  { area: 'resumes', prompts: RESUMES_PROMPTS },
  { area: 'cover-letters', prompts: COVER_LETTERS_PROMPTS },
  { area: 'job-analysis', prompts: JOB_ANALYSIS_PROMPTS },
  { area: 'tailor', prompts: TAILOR_PROMPTS },
  { area: 'prepare-filters', prompts: PREPARE_FILTERS_PROMPTS },
  { area: 'mcp', prompts: MCP_PROMPTS },
  { area: 'autofill', prompts: AUTOFILL_PROMPTS },
  { area: 'jobs', prompts: JOBS_PROMPTS },
  { area: 'companies', prompts: COMPANIES_PROMPTS },
  { area: 'system', prompts: SYSTEM_PROMPTS },
];

/**
 * A prompt's words for one input, as the AI gets them: a model prompt's whole system text (rules, the JSON
 * instruction with its `[feature:<kind>]` tag, the context) and its message; a text prompt's words. The moved-prompt
 * tests compare this with v2.0's words for a fixed input (byte-equal).
 */
export function renderPrompt<I>(prompt: ModelPrompt<I, unknown> | TextPrompt<I>, input: I): { system: string; user: string } | { text: string } {
  return prompt.form === 'model' ? promptTexts(prompt, input) : { text: prompt.text(input) };
}

/** Every prompt of the catalogue. */
export const PROMPTS: readonly CatalogPrompt[] = PROMPTS_BY_AREA.flatMap((entry) => entry.prompts);

/** The prompt with this id (`<area>/<name>`), or undefined. */
export function promptById(id: string): CatalogPrompt | undefined {
  return PROMPTS.find((prompt) => prompt.id === id);
}

/** The catalogue's problems (duplicate ids, a prompt under another area); the catalogue test expects none. */
export function promptCatalogueProblems(): string[] {
  return catalogueProblems(PROMPTS_BY_AREA);
}
