import { constantsOf } from '../../core/constants/index';
import type { DailyStep } from '../../core/feature';
import { cancelStaleMcpPrepares } from './service';
import { DAY_MS } from '@tailorit/shared';

// v30 INT-0: Prepare's steps of the daily housekeeping (Feature.daily; v2.0 ran them in features/account's
// housekeeping, ST4 moved them there as Feature.daily steps, and INT-0 here, beside the table they prune).

/** The prepare_jobs states a Prepare ends in. */
const FINISHED_PREPARE_STATES = ['queued', 'prepared', 'filtered', 'failed', 'cancelled'] as const;

/** Finished prepare_jobs older than PREPARE_KEEP_DAYS, each application's newest kept. */
export const prunePrepareJobs: DailyStep = {
  name: 'prepareJobs',
  // The Queue pane needs each application's newest Prepare only; one a live queue row names is kept too.
  run: async (deps) =>
    (
      await deps.db.run(
        `DELETE FROM prepare_jobs
          WHERE state IN (${FINISHED_PREPARE_STATES.map(() => '?').join(', ')})
            AND coalesce(finished_at, updated_at) < ?
            AND id <> (SELECT newest.id FROM prepare_jobs newest
                        WHERE newest.application_id = prepare_jobs.application_id
                        ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1)
            AND id NOT IN (SELECT q.prepare_id FROM autofill_agent_queue q
                            WHERE q.state IN ('queued', 'running') AND q.prepare_id IS NOT NULL)`,
        [
          ...FINISHED_PREPARE_STATES,
          new Date(deps.now().getTime() - constantsOf(deps).get('PREPARE_KEEP_DAYS') * DAY_MS).toISOString(),
        ],
      )
    ).changes,
};

/** MCP Prepares left waiting PREPARE_MCP_STALE_DAYS, cancelled. */
export const cancelAbandonedMcpPrepares: DailyStep = {
  name: 'staleMcpPrepares',
  // An MCP Prepare waits for the person's own AI; one still active PREPARE_MCP_STALE_DAYS after it started was abandoned.
  // v2.0 (INT): Prepare's own cancel (P2's cancelStaleMcpPrepares), which puts the kit's parts back.
  run: (deps) => cancelStaleMcpPrepares(deps),
};

/** prepareFeature.daily, in the order the v2.0 housekeeping ran them. */
export const PREPARE_DAILY: readonly DailyStep[] = [prunePrepareJobs, cancelAbandonedMcpPrepares];
