import type { Feature } from '../../core/feature';
import { createAutofillTailorRouter, createTailorRouter } from './router';
import { createTailorService, type TailorService } from './service';
import { tailorTask } from './task';

// Tailoring a resume and its cover letter for a job (v1.4, work package D; decisions 14-15 of the v1.3/v1.4 plan):
// tailor_builder0's pipeline (the owner's own earlier project, ISC licence, copied with the owner's permission of
// 2026-11-09), run as the AI task kind `tailor`. Its prompts are tailor_builder0's word for word (prompts/), its code
// ported as it was (keywords.ts, ats.ts, humanize.ts, pipeline.ts, skills/; v30 ST2: the prompts are the prompt
// catalogue's tailor area, ai/prompts/tailor, and the task kind task.ts), with its skill library shipped as
// static/skills/tailor-skills.json for tailoring alone. TailorIT's own pieces: the analysis store (store.ts, migration
// 0813), the source and templates (source.ts), the mapping from and to a resume document (mapping.ts), what is stored
// and linked (output.ts), the task and its limits (service.ts) and the routes (router.ts).

declare module '../../core/context' {
  interface AppServices {
    /** Tailoring (v1.4 D): created when the AI service exists. */
    tailor?: TailorService;
  }
}

export const tailorFeature: Feature = {
  name: 'tailor',
  services(deps) {
    if (!deps.services.ai) return;
    deps.services.tailor = createTailorService(deps);
  },
  // v30 ST2: the AI task kind `tailor` (task.ts), registered by setupServices after `services`.
  aiTasks: [tailorTask],
  routes: [
    { path: '/api/tailor', router: createTailorRouter },
    { path: '/api/autofill', router: createAutofillTailorRouter },
  ],
};
