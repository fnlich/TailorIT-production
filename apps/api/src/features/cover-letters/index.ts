import type { Feature } from '../../core/feature';
import { COVER_LETTERS_ACTING } from './acting'; // v33 SHARE-3
import { createCoverLettersRouter } from './router';
import { coverLetterTask, templateFillTask } from './tasks';

// Cover letters: CRUD, generation, import, preview, export. Owned by work package C.
// AI kinds: `cover_letter` (no template, or an empty one) and `template_fill` (a template's AI placeholders); v30 ST1:
// defined in ./tasks.ts (defineAiTask) and registered from `aiTasks`.
export const coverLettersFeature: Feature = {
  name: 'cover-letters',
  aiTasks: [coverLetterTask, templateFillTask],
  routes: [{ path: '/api/cover-letters', router: createCoverLettersRouter, acting: COVER_LETTERS_ACTING /* v33 SHARE-3 */ }],
};
