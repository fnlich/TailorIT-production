import { STATUS, type PrepareStartResponse } from '@tailorit/shared';
import type { FanoutBulkBody, ProfileChoice, SharePermission } from '@tailorit/shared/sharing';
import { payerOfGrant, type PersonPayer } from '../../../core/accounts/payer';
import type { AppDeps } from '../../../core/context';
import { aiUnavailableError } from '../../../core/accounts/refusals';
import { bulkApplications } from '../../applications/service';
import { resolveTargets, runOn, targetHolds, type FanoutActor, type FanoutAnswer, type FanoutOptions } from './targets';
import { underOf } from './unsave'; // v36 FIX-API (D1)

// v34 FANOUT (PLAN G1, G4 "Tracker"): the Job Tracker's All profiles view's bulk actions, each card on its own profile:
// a move to a stage, Archive (`onlySaved`: an Undo of a Save to leaves entries moved past Saved alone), Restore (the
// Tracker's bulk, applications/service.ts bulkApplications: never Delete) with
// that profile's Job Tracker Change, and Prepare (the Prepare service's start, mode `server`) with its Prepare
// Change. A Prepare on a shared profile keeps every rule of one started there: A pays (payerOfGrant under the
// grant: A's AI budget and Prepares an hour), the owner's last queue and resume places are kept (SHARING_QUEUE_RESERVE,
// SHARING_RESUME_RESERVE), at most SHARING_WAITING_PER_GRANT wait, and what A prepares waits for the owner's OK unless
// the share has Apply without my OK (startPrepare and insertPreparedRow decide each from the grant itself). At most
// PREPARE_BATCH_MAX cards a profile (startPrepare's own check: that profile's refusal). A's own profile first.

type Deps = AppDeps;

/** One profile's bulk outcome (FanoutBulkResult's ok fields). */
export interface BulkOnTarget {
  affected: number;
  /** v36 FIX-API (D1): `archive` only, when not zero: what the archive did with the auto-apply queue. */
  dequeued?: number;
  applying?: number;
  queueLocked?: number;
  outcomes?: PrepareStartResponse['results'];
}

/** The box each action needs on a profile. */
export const BULK_PERMISSION: Record<FanoutBulkBody['action'], SharePermission> = {
  status: 'tracker:edit',
  archive: 'tracker:edit',
  unarchive: 'tracker:edit',
  prepare: 'prepare:run',
};

/** Who pays for a Prepare A starts on their own profile (on a shared one: A under its grant). */
export interface BulkPayers {
  /** A paying on their own profile (the route's payerOf(req)). */
  own: PersonPayer;
}

/**
 * POST /api/profiles/applications/bulk: each item on its own profile (A's own first, then the profiles in the order
 * they first appear). Answers each profile's outcome.
 */
export async function bulkOnProfiles(
  deps: Deps,
  actor: FanoutActor,
  body: FanoutBulkBody,
  payers: BulkPayers,
  options: FanoutOptions = {},
): Promise<FanoutAnswer<BulkOnTarget>> {
  const perm = BULK_PERMISSION[body.action];
  const byProfile = new Map<ProfileChoice, string[]>();
  for (const item of body.items) {
    const ids = byProfile.get(item.profile) ?? [];
    if (!ids.includes(item.applicationId)) ids.push(item.applicationId);
    byProfile.set(item.profile, ids);
  }
  const resolved = await resolveTargets(deps, actor, [...byProfile.keys()], [perm], options);
  let wake = false;
  const results = await runOn(
    deps,
    actor,
    resolved,
    perm,
    async (target): Promise<BulkOnTarget> => {
      const ids = byProfile.get(target.profile) ?? [];
      if (body.action !== 'prepare') {
        // v36 FIX-API (D1): an archive acts under the target's share (its Queue changes decide what leaves the queue).
        const answer = await bulkApplications(
          deps,
          target.ownerId,
          {
            ids,
            action: body.action,
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(body.occurredOn !== undefined ? { occurredOn: body.occurredOn } : {}),
            ...(body.onlySaved ? { onlySaved: true } : {}),
          },
          underOf(actor, target),
        );
        if (answer.affected > 0 && (body.action === 'unarchive' || body.status === STATUS.saved)) wake = true;
        return answer;
      }
      const prepare = deps.services.prepare;
      if (!prepare) throw aiUnavailableError(deps);
      // A under the grant on a shared profile (payerOfGrant: profile_not_shared, read as unknown, without the box).
      const payer = target.grant ? payerOfGrant(target.grant, 'prepare:run') : payers.own;
      const answer = await prepare.startPrepare(target.ownerId, { applicationIds: ids, rebuild: false }, 'server', {
        payer,
        viewer: { sensitive: targetHolds(target, 'sensitive:view') },
      });
      const affected = answer.results.filter((result) => result.outcome === 'started' || result.outcome === 'queued').length;
      return { affected, outcomes: answer.results };
    },
    { ...options, wrote: (value) => value.affected > 0 },
  );
  // Restored or moved-back Saved entries may be due a resume: the match worker chooses within seconds.
  if (wake) deps.services.resumeMatch?.nudge();
  return results;
}
