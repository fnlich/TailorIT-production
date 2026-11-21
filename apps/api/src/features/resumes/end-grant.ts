import { nowIso, type AppDeps } from '../../core/context';
import { registerEndGrantStep, type EndGrantScope } from '../sharing/end-grant';

// v33 SHARE-3 (PLAN F9; SP v33 PLAN-sharing.md §6 "endGrant", step 3): when a grant stops allowing work, the resume
// backlog rows paid under it stop (the AI tasks they started are cancelled by the `ai_tasks` step, which runs first):
//   - resume_copy_backlog: a copy still waiting is 'stopped' (a copy being made is settled 'stopped' once its cancelled
//     task is read; Try again on A's own profile makes it at A's cost);
//   - resume_analysis_backlog: an upload not read yet is 'skipped' with why (the rules' reading stays; it is read again
//     by Claude only when its text changes or A asks for a copy).
// Only rows that name the grant are touched (a share made again is never); a second run finds nothing left. A scoped
// run (A took boxes away) stops them only when `documents:edit` (the box backlog work runs under) is among those boxes.

/** Why an upload B asked Claude to read on A's profile was not read (resume_analysis_backlog.last_error). */
export const BACKLOG_ACCESS_ENDED = 'Sharing ended before the AI read it.';

/** The `backlogs` step: answers how many rows it stopped. */
export async function stopGrantBacklogs(deps: Pick<AppDeps, 'db' | 'now'>, scope: EndGrantScope): Promise<number> {
  if (scope.permissions !== null && !scope.permissions.includes('documents:edit')) return 0;
  const now = nowIso(deps);
  const copies = await deps.db.run(
    `UPDATE resume_copy_backlog SET state = 'stopped', finished_at = @now, updated_at = @now
      WHERE grant_id = @grant AND state = 'waiting'`,
    { grant: scope.grantId, now },
  );
  const readings = await deps.db.run(
    `UPDATE resume_analysis_backlog SET state = 'skipped', last_error = @why, updated_at = @now
      WHERE grant_id = @grant AND state IN ('waiting', 'failed', 'queued')`,
    { grant: scope.grantId, now, why: BACKLOG_ACCESS_ENDED },
  );
  return copies.changes + readings.changes;
}

/** Registers the step (the resumes feature's services hook). */
export function registerBacklogsEndGrantStep(): void {
  registerEndGrantStep('backlogs', (deps, scope) => stopGrantBacklogs(deps, scope));
}
