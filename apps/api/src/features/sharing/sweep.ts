import { HOUR_MS } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { recordGrantEvent } from './activity';
import { endGrant, type EndGrantCause } from './end-grant';
import { notifySharing, sharingDedupeKey } from './notices';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §2 "Ending a grant", §6): the hourly sweep (Feature.start, the API
// process; once at start, then every hour):
// 1. invites past invite_expires_at → `expired` (nobody is told: the invite simply leaves both lists);
// 2. accesses past access_ends_at → `expired`, and both sides get sharing_ended (the live check already refused the
//    grant from that moment: it reads the date itself; this writes the state);
// 3. endGrant again for every accepted grant that ended in the last SWEEP_LOOKBACK_MS (a crash between the commit and
//    the cleanup, a step that failed): only grants that ended, so a share made again (a new grant) is never touched.
// Two processes may sweep at once: each UPDATE ... RETURNING ends a grant once, endGrant may run twice, the notices are
// deduped.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** How often the sweep runs (a technical interval). */
export const SWEEP_EVERY_MS = HOUR_MS;
/** How far back the sweep runs endGrant again for ended grants (a day and an hour: a day of downtime is covered). */
export const SWEEP_LOOKBACK_MS = 25 * HOUR_MS;

/** A grant the expiry just ended, with both people. */
export interface ExpiredGrant {
  id: string;
  owner_user_id: string;
  owner_name: string;
  owner_email: string;
  grantee_user_id: string | null;
  grantee_name: string | null;
  grantee_email: string | null;
  /** It had been accepted (an access, not an invite). */
  was_active: boolean;
}

/**
 * Writes `expired` on the open grants whose date passed (all, or only `ownerId`'s), with the share's event, on `db`
 * (inside the caller's transaction); answers them. Run afterExpired once it committed.
 */
export async function expireOverdue(deps: Deps, db: DbQueries, ownerId?: string): Promise<ExpiredGrant[]> {
  const now = deps.now().toISOString();
  const rows = await db.all<ExpiredGrant>(
    `WITH done AS (
       UPDATE profile_grants g SET state = 'expired', ended_at = CAST(@now AS timestamptz), changed_at = CAST(@now AS timestamptz)
        WHERE ((g.state = 'pending' AND g.invite_expires_at <= CAST(@now AS timestamptz))
            OR (g.state = 'active' AND g.access_ends_at IS NOT NULL AND g.access_ends_at <= CAST(@now AS timestamptz)))
          ${ownerId === undefined ? '' : 'AND g.owner_user_id = @owner'}
       RETURNING g.id, g.owner_user_id, g.grantee_user_id, g.accepted_at)
     SELECT d.id, d.owner_user_id, o.name AS owner_name, o.email AS owner_email, d.grantee_user_id,
            b.name AS grantee_name, b.email AS grantee_email, (d.accepted_at IS NOT NULL) AS was_active
       FROM done d
       JOIN users o ON o.id = d.owner_user_id
       LEFT JOIN users b ON b.id = d.grantee_user_id
      ORDER BY d.id`,
    { now, owner: ownerId ?? null },
  );
  for (const row of rows) {
    await recordGrantEvent(deps, db, { grantId: row.id, ownerId: row.owner_user_id, actorId: row.owner_user_id, action: 'expired', via: 'system' });
  }
  return rows;
}

/** After the expiry committed: both sides of each access that ended are told, and its work stops. */
export async function afterExpired(deps: Deps, rows: readonly ExpiredGrant[]): Promise<void> {
  for (const row of rows) {
    if (!row.was_active || row.grantee_user_id === null || row.grantee_email === null) continue;
    const key = sharingDedupeKey('sharing_ended', row.id);
    await notifySharing(deps, row.owner_user_id, 'sharing_ended', { name: row.grantee_name, email: row.grantee_email }, key);
    await notifySharing(deps, row.grantee_user_id, 'sharing_ended', { name: row.owner_name, email: row.owner_email }, key);
    await endGrant(deps, row.id, { cause: 'expired' });
  }
}

/** What one sweep did. */
export interface SweepResult {
  expiredInvites: number;
  expiredAccesses: number;
  /** Ended grants endGrant ran for (again). */
  ended: number;
}

/** One sweep (the hourly pass; tests call it). */
export async function runSharingSweep(deps: Deps): Promise<SweepResult> {
  const expired = await deps.db.tx((t) => expireOverdue(deps, t), { label: 'sharing sweep' });
  await afterExpired(deps, expired);
  const since = new Date(deps.now().getTime() - SWEEP_LOOKBACK_MS).toISOString();
  const ended = await deps.db.all<{ id: string; state: EndGrantCause }>(
    `SELECT id, state FROM profile_grants
      WHERE state IN ('revoked', 'left', 'expired') AND accepted_at IS NOT NULL AND ended_at > CAST(@since AS timestamptz)
      ORDER BY ended_at, id`,
    { since },
  );
  for (const row of ended) await endGrant(deps, row.id, { cause: row.state });
  return {
    expiredInvites: expired.filter((row) => !row.was_active).length,
    expiredAccesses: expired.filter((row) => row.was_active).length,
    ended: ended.length,
  };
}

/** Feature.start: the sweep at start, then every SWEEP_EVERY_MS; one at a time. Answers the stop. */
export function startSweep(deps: Deps): () => void {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    runSharingSweep(deps)
      .then((result) => {
        if (result.expiredInvites + result.expiredAccesses > 0) {
          deps.log.info(`[sharing] sweep: ${result.expiredInvites} invites and ${result.expiredAccesses} shares expired`);
        }
      })
      .catch((error: unknown) => deps.log.warn('[sharing] the sweep failed; it runs again in an hour', error))
      .finally(() => {
        running = false;
      });
  };
  pass();
  const timer = setInterval(pass, SWEEP_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
