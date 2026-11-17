import { coverLetterPrompt } from '../../ai/prompts/cover-letters/cover-letter';
import { templateFillPrompt } from '../../ai/prompts/cover-letters/template-fill';
import { defineAiTask } from '../../ai/task';
import { generateFromTemplate, generateWithoutTemplate, readGenerateTaskInput } from './generate';

// v30 ST1: the cover letters' AI task kinds (ai/task.ts defineAiTask), listed on coverLettersFeature.aiTasks. Both
// read their stored input as before (readGenerateTaskInput: an input that does not read fails as `ai_failed`) and are
// charged to the account that queued them (the editor's Generate, the extension's letter, Prepare's letter step).

/** `cover_letter`: a letter without a template (or from an empty one, its AI prompt and font only). */
export const coverLetterTask = defineAiTask({
  kind: 'cover_letter',
  prompts: [coverLetterPrompt],
  parse: readGenerateTaskInput,
  charge: 'person',
  defaultModel: 'cli',
  run: (deps, input, ctx) => generateWithoutTemplate(deps, input, ctx),
});

/** `template_fill`: a template's AI placeholders. */
export const templateFillTask = defineAiTask({
  kind: 'template_fill',
  prompts: [templateFillPrompt],
  parse: readGenerateTaskInput,
  charge: 'person',
  defaultModel: 'cli',
  run: (deps, input, ctx) => generateFromTemplate(deps, input, ctx),
});
