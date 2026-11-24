import type { HeldGroup } from '@tailorit/shared/auto-apply';
import type { ProfileKey } from '@tailorit/shared/sharing';
import { liveGrantsByIds, lockedLiveGrant } from '../../../core/auth/grants'; // v33 INT-1
import { nowIso, type AppDeps } from '../../../core/context';
import type { EndGrantScope } from '../../sharing/end-grant';

// v33 SHARE-5 (PLAN F9 "Prepare and the queue"; SP v33 PLAN-sharing.md §6 "Jobs wait for A's OK", "endGrant"): the queue
// rows a person (B) prepared on a profile shared with them (A's) that wait for A's OK (autofill_agent_queue.awaiting_owner,
// migration 0049). A job B prepares goes in held unless A ticked "Apply without my OK" (`apply`) on that share
// (insertPreparedRow, prepared.ts); claimNext never takes a held row and a token never sees one (queue.ts). A approves
// them (they go in after A's own rows, in the order approved) or removes them, per share, from the Auto-apply page
// (features/auto-apply's routes, never while acting): "Approve all" and "Remove" send the newest row A saw (`through`),
// so a job B queues meanwhile is never decided unseen. Ending the share removes them (endGrant's `queue` step), with,
// when A stopped sharing and asked for it (remove_queued), the approved ones no extension took yet; taking `apply` (or
// Prepare's Change) away puts B's rows A never approved back on hold (endGrantQueueStep). Only this folder
// touches the queue's table; every statement names the owner and the grant.
// v33 INT-1 (SHARE-5's open item): only a live share's rows are listed, approved or removed (core/auth/grants.ts's one
// live predicate, and the share must be the owner's). A share that ended (a stop, a leave, an expiry, an admin's
// disable) has its held rows removed by endGrant (or, after the admin-disable race, by the hourly sweep); until then
// they are not shown, and an approve that comes after the end changes nothing, so no row B prepared ever runs as the
// owner's once B's access is gone. The approve and the remove lock the grant (FOR SHARE) for their write: an end that
// comes meanwhile waits, and its endGrant then sees the decision.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The ids part of a statement (`@ids`: a JSON array): every held row of the grant, or only those of `ids`. */
const idsPart = (deps: Pick<AppDeps, 'db'>, ids: readonly string[] | undefined) =>
  ids ? ` AND id IN (SELECT value FROM ${deps.db.dialect.jsonEach('@ids')})` : '';
const idsParam = (ids: readonly string[] | undefined) => (ids ? JSON.stringify(ids) : null);
/**
 * The `through` part (`@through`): only the rows queued at or before it (the SHARE-5 review's decision 1), compared at
 * the millisecond the answers show.
 */
const throughPart = (through: string | undefined) =>
  through === undefined ? '' : " AND date_trunc('milliseconds', created_at) <= CAST(@through AS timestamptz)";

/** Which held rows a decision names: some ids, those queued at or before `through`, or both. */
export interface HeldSelection {
  ids?: readonly string[];
  through?: string;
}

/**
 * The owner's held rows, one group per share (who prepared them, how many, the oldest and the newest), the oldest group
 * first.
 */
export async function heldGroups(deps: Deps, ownerId: string): Promise<HeldGroup[]> {
  const rows = await deps.db.all<{ grant_id: string; name: string; email: string; n: number; oldest: string; newest: string }>(
    `SELECT q.grant_id, coalesce(nullif(btrim(u.name), ''), u.email) AS name, u.email, count(*)::int AS n,
            min(q.created_at) AS oldest, max(q.created_at) AS newest
       FROM autofill_agent_queue q JOIN users u ON u.id = q.prepared_by
      WHERE q.user_id = @owner AND q.awaiting_owner AND q.state = 'queued' AND q.grant_id IS NOT NULL
      GROUP BY q.grant_id, u.name, u.email
      ORDER BY min(q.created_at), q.grant_id`,
    { owner: ownerId },
  );
  // v33 INT-1: a share that ended is not shown (endGrant removes its held rows).
  const live = await liveGrantsByIds(deps, rows.map((row) => row.grant_id));
  return rows.filter((row) => live.get(row.grant_id)?.owner.id === ownerId).map((row) => ({
    grantKey: row.grant_id as ProfileKey,
    name: row.name,
    email: row.email,
    count: row.n,
    oldestAt: row.oldest,
    newestAt: row.newest,
  }));
}

/**
 * The owner's OK: the share's held rows that `selection` names (its ids, those queued at or before `through`) go into
 * the queue (approved now: the extension takes them after the owner's own rows, in this order). Answers how many.
 */
export async function approveHeld(deps: Deps, ownerId: string, grantId: string, selection: HeldSelection): Promise<number> {
  const { ids, through } = selection;
  const now = nowIso(deps);
  // v33 INT-1: only while the share is live and the owner's (an ended share's rows are endGrant's to remove).
  const result = await deps.db.tx(async (t) => {
    const grant = await lockedLiveGrant(deps, t, grantId, 'share');
    if (!grant || grant.owner.id !== ownerId) return { changes: 0 };
    return t.run(
      `UPDATE autofill_agent_queue SET awaiting_owner = false, approved_at = CAST(@now AS timestamptz), updated_at = CAST(@now AS timestamptz)
        WHERE user_id = @owner AND grant_id = @grant AND awaiting_owner AND state = 'queued'${idsPart(deps, ids)}${throughPart(through)}`,
      { owner: ownerId, grant: grantId, now, ids: idsParam(ids), through: through ?? null },
    );
  }, { label: 'auto-apply approve' });
  if (result.changes > 0) deps.log.debug(`[auto-apply] account ${ownerId} approved ${result.changes} job(s) prepared on a share`);
  return result.changes;
}

/** The owner's No: the share's held rows that `selection` names leave the queue. Answers how many. */
export async function rejectHeld(deps: Deps, ownerId: string, grantId: string, selection: HeldSelection): Promise<number> {
  const { ids, through } = selection;
  // v33 INT-1: as approveHeld, only a live share of the owner's (endGrant removes an ended one's held rows).
  const result = await deps.db.tx(async (t) => {
    const grant = await lockedLiveGrant(deps, t, grantId, 'share');
    if (!grant || grant.owner.id !== ownerId) return { changes: 0 };
    return t.run(
      `DELETE FROM autofill_agent_queue
        WHERE user_id = @owner AND grant_id = @grant AND awaiting_owner AND state = 'queued'${idsPart(deps, ids)}${throughPart(through)}`,
      { owner: ownerId, grant: grantId, ids: idsParam(ids), through: through ?? null },
    );
  }, { label: 'auto-apply reject' });
  if (result.changes > 0) deps.log.debug(`[auto-apply] account ${ownerId} removed ${result.changes} job(s) prepared on a share`);
  return result.changes;
}

/**
 * The grant's held rows that no extension took go; with `alsoUnclaimed` (A stopped sharing and asked to "Also remove
 * the jobs they queued that haven't started", remove_queued) every queued row of the grant no extension took goes too
 * (approved, or unheld under `apply`). Rows a run took, and finished ones, stay. Answers how many.
 */
export async function removeGrantQueueRows(deps: Deps, ownerId: string, grantId: string, alsoUnclaimed: boolean): Promise<number> {
  const result = await deps.db.run(
    `DELETE FROM autofill_agent_queue
      WHERE user_id = @owner AND grant_id = @grant AND state = 'queued' AND claimed_by IS NULL
        AND ${alsoUnclaimed ? 'true' : 'awaiting_owner'}`,
    { owner: ownerId, grant: grantId },
  );
  return result.changes;
}

/**
 * The grant's queued rows the owner never approved that went in unheld (under `apply`) and no extension took go back on
 * hold: they wait for the owner's OK again. Answers how many.
 */
export async function reholdGrantQueueRows(deps: Deps, ownerId: string, grantId: string): Promise<number> {
  const now = nowIso(deps);
  const result = await deps.db.run(
    `UPDATE autofill_agent_queue SET awaiting_owner = true, updated_at = CAST(@now AS timestamptz)
      WHERE user_id = @owner AND grant_id = @grant AND state = 'queued' AND claimed_by IS NULL AND NOT awaiting_owner
        AND approved_at IS NULL`,
    { owner: ownerId, grant: grantId, now },
  );
  return result.changes;
}

/**
 * endGrant's `queue` step (registered by features/auto-apply; the SHARE-5 review's decisions 2 and 3). Rows a run took,
 * finished rows and the owner's own are never touched; safe to run twice (a second run changes nothing).
 * - The share ended (permissions null): its held rows go (nobody may prepare them on it any more). Only when the owner
 *   stopped sharing (cause `revoked`) and asked for it (remove_queued) do its other unclaimed rows go too (approved, or
 *   unheld under `apply`); after B left, an expiry or an admin's disable, the rows the owner approved stay theirs.
 * - A box taken away (permissions listed): `apply` or Prepare's Change (`prepare:run`) away, its unheld rows
 *   the owner never approved go back on hold (nothing B prepares runs without the owner's OK); `prepare:run` away, its
 *   held rows then go (B can no longer prepare there; the approved ones stay). Any other box: nothing.
 */
export async function endGrantQueueStep(
  deps: Deps,
  scope: Pick<EndGrantScope, 'grantId' | 'ownerId' | 'permissions' | 'removeQueued' | 'cause'>,
): Promise<number> {
  const { grantId, ownerId, permissions } = scope;
  if (permissions === null) {
    return removeGrantQueueRows(deps, ownerId, grantId, scope.cause === 'revoked' && scope.removeQueued);
  }
  const prepare = permissions.includes('prepare:run');
  let changed = 0;
  if (prepare || permissions.includes('apply')) changed += await reholdGrantQueueRows(deps, ownerId, grantId);
  if (prepare) changed += await removeGrantQueueRows(deps, ownerId, grantId, false);
  return changed;
}
