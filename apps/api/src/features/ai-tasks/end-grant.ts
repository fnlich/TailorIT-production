import { registerEndGrantStep, type EndGrantScope } from '../sharing/end-grant';
import type { AppDeps } from '../../core/context';

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §6 "endGrant", step 2): when a grant stops allowing work, the AI tasks
// paid under it that have not finished are cancelled (their CLI child stopped; the cost so far stays the payer's). A
// scoped run (A took boxes away, the grant stays live) cancels only the tasks queued under one of those boxes
// (ai_tasks.grant_perm). Only rows that name the grant are touched, so a share made again is never; a second run finds
// nothing left. Public work (a job analysis, user_id NULL) never names a grant and is never cancelled here. The AI
// queue refuses such tasks anyway (assertGrantLive at enqueue and at run), so this step only stops them sooner.

/** The `ai_tasks` step: answers how many tasks it cancelled. */
export async function cancelGrantTasks(deps: Pick<AppDeps, 'services'>, scope: EndGrantScope): Promise<number> {
  const ai = deps.services.ai;
  if (!ai) return 0;
  return ai.cancelGrant(scope.grantId, scope.permissions);
}

/** Registers the step (the ai-tasks feature's services hook: the queue exists from there on). */
export function registerAiTasksEndGrantStep(): void {
  registerEndGrantStep('ai_tasks', (deps, scope) => cancelGrantTasks(deps, scope));
}
