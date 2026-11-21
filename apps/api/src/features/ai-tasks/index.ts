import { createAiService } from '../../ai/index';
import type { Feature } from '../../core/feature';
import { registerAiTasksEndGrantStep } from './end-grant'; // v33 SHARE-3
import { AI_TASKS_ACTING } from './acting'; // v33 SHARE-6
import { createAiTasksRouter } from './router';

// AI task queue over the local Claude CLI; task polling. Owned by work package F4.
export const aiTasksFeature: Feature = {
  name: 'ai-tasks',
  // Listed before every feature that queues AI work, so they can register their handlers on deps.services.ai.
  services: (deps) => {
    deps.services.ai = createAiService(deps);
    registerAiTasksEndGrantStep(); // v33 SHARE-3: ending a grant cancels the AI tasks paid under it
  },
  routes: [{ path: '/api/ai/tasks', router: createAiTasksRouter, acting: AI_TASKS_ACTING /* v33 SHARE-6 */ }],
  start: (deps) => deps.services.ai?.start(),
};
