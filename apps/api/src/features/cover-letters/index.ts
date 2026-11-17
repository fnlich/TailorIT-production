import type { Feature } from '../../core/feature';
import { createCoverLettersRouter } from './router';
import { coverLetterTask, templateFillTask } from './tasks';

// Cover letters: CRUD, generation, import, preview, export. Owned by work package C.
// AI kinds: `cover_letter` (no template, or an empty one) and `template_fill` (a template's AI placeholders); v30 ST1:
// defined in ./tasks.ts (defineAiTask) and registered from `aiTasks`.
export const coverLettersFeature: Feature = {
  name: 'cover-letters',
  aiTasks: [coverLetterTask, templateFillTask],
  routes: [{ path: '/api/cover-letters', router: createCoverLettersRouter }],
};
