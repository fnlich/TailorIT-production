import type { TailorResult } from '@tailorit/shared/autofill';
import { TAILOR_PROMPTS } from '../../ai/prompts/tailor/index';
import { defineAiTask } from '../../ai/task';

// v30 ST2: the AI task kind `tailor` (v1.4 D: tailor_builder0's pipeline, the AI_CLI_MODEL), defined with defineAiTask
// and listed on the tailor feature (setupServices registers it right after the feature's services, which made the
// TailorService). The work is the service's handler: it reads its stored input itself (TailorTaskInputSchema, refused
// with its own words, as it always has) and keeps each running task's step for GET …/tailor/:id.

export const tailorTask = defineAiTask<unknown, TailorResult>({
  kind: 'tailor',
  prompts: TAILOR_PROMPTS,
  parse: (raw) => raw,
  // The account that asked pays (a Prepare's tailoring too: its person).
  charge: 'person',
  defaultModel: 'cli',
  run: (deps, input, ctx) => {
    const service = deps.services.tailor;
    // Never: the task is registered only where the AI service is, and the feature made the TailorService with it.
    if (!service) throw new Error('The tailor task ran without its TailorService.');
    return service.handler(input, ctx);
  },
});
