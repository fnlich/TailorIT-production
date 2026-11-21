import type { Request, Response } from 'express';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@tailorit/shared';
import {
  SHARING_ACTIVITY_ACTION_PATTERN,
  SHARING_MESSAGES,
  isProfileKey,
  rowOfPermission,
  type ProfileKey,
  type SharePermission,
  type SharingActivity,
  type SharingActivityArea,
  type SharingActivityGrant,
  type SharingActivityQuery,
  type SharingActivityRow,
  type SharingActivityVia,
} from '@tailorit/shared/sharing';
import { afterCursor, encodeCursor } from '../../core/admin/paging';
import { actorOf } from '../../core/auth/guards';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import type { DailyStep } from '../../core/feature';
import { SHOWN_STATE, sqlTextArray } from './rows';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §10): what B did on A's profile, counted by the hour (profile_activity,
// migration 0048): ids and codes only, never a value. One row per (grant, area, action, via, hour), `events` counting:
// - every write (`write`), and the first read of an area in an hour (`read`, events stays 1), of a request the route
//   guard let act on the profile (trackActingRequest; SHARE-1's guard calls it);
// - B's own AI's calls on the profile (via `mcp`; SHARE-8 calls countActivity), A's extension's AI that B pays
//   (`extension`; SHARE-3);
// - the share's own events (area `sharing`: invited, changed, accepted, declined, left, revoked, cancelled, expired),
//   written in the same transaction as the change (recordGrantEvent).
// Request counts are held in memory and flushed every minute and at shutdown (Feature.start's stop); a failed flush keeps
// them for the next one (at most ACTIVITY_PENDING_MAX buckets). Both sides read the rows (activityOf): A every row of
// A's grants, B the rows of the grants B accepted up to the grant's end. Kept SHARING_ACTIVITY_KEEP_DAYS (a daily step).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** How often the counts in memory are written (a technical interval). */
export const ACTIVITY_FLUSH_EVERY_MS = MINUTE_MS;
/** The most buckets held in memory while the database refuses them (the oldest go first, logged). */
export const ACTIVITY_PENDING_MAX = 20_000;
/** Rows one retention statement deletes at most. */
export const ACTIVITY_DELETE_BATCH = 10_000;

/** One counted event (or `events` of them). */
export interface ActivityEvent {
  grantId: string;
  /** A: whose profile. */
  ownerId: string;
  /** Who did it (B, or A for the share's own events A made). */
  actorId: string;
  area: SharingActivityArea;
  /** A code (SHARING_ACTIVITY_ACTION_PATTERN): `read`, `write`, a tool's or an event's name. */
  action: string;
  via: SharingActivityVia;
  /** Default 1. A `read` always counts 1 per hour. */
  events?: number;
}

interface Bucket {
  grantId: string;
  ownerId: string;
  actorId: string;
  area: SharingActivityArea;
  action: string;
  via: SharingActivityVia;
  hour: string;
  events: number;
}

/** The counts in memory (deps.services.sharingActivity, made by the feature's services hook). */
export interface SharingActivityService {
  readonly pending: Map<string, Bucket>;
  flushing: Promise<number> | null;
}

declare module '../../core/context' {
  interface AppServices {
    /** v33 SHARE-2: the sharing activity's counts in memory, flushed every minute (features/sharing/activity.ts). */
    sharingActivity?: SharingActivityService;
  }
}

export function createActivityService(): SharingActivityService {
  return { pending: new Map(), flushing: null };
}

/** The UTC hour `at` falls in, as profile_activity stores it. */
export function hourOf(at: Date): string {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS).toISOString();
}

/** The activity area of a permission: its grid row (tracker, documents, prepare, queue, apply, autofill, ...). */
export function areaOfPermission(perm: SharePermission): SharingActivityArea {
  return rowOfPermission(perm).id;
}

function bucketOf(deps: Deps, event: ActivityEvent): Bucket | null {
  if (!isProfileKey(event.grantId) || !event.ownerId || !event.actorId) return null;
  if (!SHARING_ACTIVITY_ACTION_PATTERN.test(event.action)) return null;
  const events = event.action === 'read' ? 1 : Math.max(1, Math.floor(event.events ?? 1));
  return {
    grantId: event.grantId,
    ownerId: event.ownerId,
    actorId: event.actorId,
    area: event.area,
    action: event.action,
    via: event.via,
    hour: hourOf(deps.now()),
    events,
  };
}

const keyOf = (bucket: Bucket) =>
  `${bucket.grantId}|${bucket.area}|${bucket.action}|${bucket.via}|${bucket.hour}|${bucket.actorId}`;

/**
 * The upsert of buckets: a read keeps its row's 1, a write adds its events. A bucket whose grant or account is gone is
 * dropped (the FK would refuse the whole statement).
 */
const UPSERT = `INSERT INTO profile_activity(grant_id, owner_user_id, actor_user_id, area, action, via, hour, events)
  SELECT x.grant_id, x.owner_id, x.actor_id, x.area, x.action, x.via, x.hour, x.events
    FROM unnest(CAST(@grants AS text[]), CAST(@owners AS text[]), CAST(@actors AS text[]), CAST(@areas AS text[]),
                CAST(@actions AS text[]), CAST(@vias AS text[]), CAST(@hours AS timestamptz[]), CAST(@events AS integer[]))
         AS x(grant_id, owner_id, actor_id, area, action, via, hour, events)
   WHERE EXISTS (SELECT 1 FROM profile_grants g WHERE g.id = x.grant_id)
     AND EXISTS (SELECT 1 FROM users o WHERE o.id = x.owner_id)
     AND EXISTS (SELECT 1 FROM users a WHERE a.id = x.actor_id)
  ON CONFLICT (grant_id, area, action, via, hour) DO UPDATE
     SET events = CASE WHEN excluded.action = 'read' THEN profile_activity.events
                       ELSE profile_activity.events + excluded.events END`;

async function writeBuckets(db: DbQueries, buckets: readonly Bucket[]): Promise<number> {
  if (buckets.length === 0) return 0;
  // One statement may not name the same row twice (ON CONFLICT): buckets that differ only by actor are summed.
  const rows = new Map<string, Bucket>();
  for (const bucket of buckets) {
    const key = `${bucket.grantId}|${bucket.area}|${bucket.action}|${bucket.via}|${bucket.hour}`;
    const seen = rows.get(key);
    if (!seen) rows.set(key, { ...bucket });
    else if (bucket.action !== 'read') seen.events += bucket.events;
  }
  const list = [...rows.values()];
  const result = await db.run(UPSERT, {
    grants: sqlTextArray(list.map((b) => b.grantId)),
    owners: sqlTextArray(list.map((b) => b.ownerId)),
    actors: sqlTextArray(list.map((b) => b.actorId)),
    areas: sqlTextArray(list.map((b) => b.area)),
    actions: sqlTextArray(list.map((b) => b.action)),
    vias: sqlTextArray(list.map((b) => b.via)),
    hours: sqlTextArray(list.map((b) => b.hour)),
    events: `{${list.map((b) => b.events).join(',')}}`,
  });
  return result.changes;
}

/**
 * Counts `event` (in memory until the next flush). Without the feature's service (a test app without the feature) it
 * is written at once. Never throws.
 */
export function countActivity(deps: Deps, event: ActivityEvent): void {
  const bucket = bucketOf(deps, event);
  if (!bucket) return;
  const service = deps.services.sharingActivity;
  if (!service) {
    void writeBuckets(deps.db, [bucket]).catch((error: unknown) =>
      deps.log.warn('[sharing] an activity count was not written', error),
    );
    return;
  }
  const key = keyOf(bucket);
  const seen = service.pending.get(key);
  if (seen) {
    if (bucket.action !== 'read') seen.events += bucket.events;
    return;
  }
  if (service.pending.size >= ACTIVITY_PENDING_MAX) {
    const oldest = service.pending.keys().next().value;
    if (oldest !== undefined) service.pending.delete(oldest);
  }
  service.pending.set(key, bucket);
}

/**
 * Writes the counts held in memory (the minute's flush, and shutdown's). A failure keeps them for the next flush.
 * Answers how many rows it wrote or changed. One flush at a time.
 */
export async function flushActivity(deps: Deps): Promise<number> {
  const service = deps.services.sharingActivity;
  if (!service) return 0;
  if (service.flushing) await service.flushing.catch(() => 0);
  if (service.pending.size === 0) return 0;
  const taken = [...service.pending.values()];
  service.pending.clear();
  const flushing = writeBuckets(deps.db, taken);
  service.flushing = flushing;
  try {
    return await flushing;
  } catch (error) {
    // Put them back (newer counts of the same bucket added since are summed in).
    for (const bucket of taken) {
      const key = keyOf(bucket);
      const seen = service.pending.get(key);
      if (!seen) service.pending.set(key, bucket);
      else if (bucket.action !== 'read') seen.events += bucket.events;
    }
    deps.log.warn(`[sharing] the activity flush failed; ${taken.length} counts wait for the next one`, error);
    return 0;
  } finally {
    service.flushing = null;
  }
}

/**
 * The share's own event (area `sharing`), written now on `db` (inside the change's own transaction: it commits and
 * rolls back with it).
 */
export async function recordGrantEvent(
  deps: Deps,
  db: DbQueries,
  event: { grantId: string; ownerId: string; actorId: string; action: string; via?: SharingActivityVia },
): Promise<void> {
  const bucket = bucketOf(deps, { ...event, area: 'sharing', via: event.via ?? 'web' });
  if (bucket) await writeBuckets(db, [bucket]);
}

/**
 * For the route guard (SHARE-1), once it let a request act on a shared profile (req.acting set): when the answer is a
 * success, counts it in the area of the route's permission: a write (POST, PUT, PATCH, DELETE), or the area's first read
 * of the hour (GET, HEAD). Nothing for a request that acts on no profile.
 */
export function trackActingRequest(deps: Deps, req: Request, res: Response): void {
  const acting = req.acting;
  if (!acting) return;
  const actorId = actorOf(req).id;
  const action = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
  const area = areaOfPermission(acting.routePerm);
  res.once('finish', () => {
    if (res.statusCode >= 400) return;
    countActivity(deps, { grantId: acting.grantId, ownerId: acting.owner.id, actorId, area, action, via: 'web' });
  });
}

// Retention -------------------------------------------------------------------------------------------------------------

const PRUNE = `DELETE FROM profile_activity WHERE ctid IN (
    SELECT ctid FROM profile_activity WHERE hour < CAST(@cutoff AS timestamptz) LIMIT @batch)`;

/** Activity older than SHARING_ACTIVITY_KEEP_DAYS (idx_profile_activity_hour), in batches. */
export const pruneActivity: DailyStep = {
  name: 'activity-retention',
  run: async (deps) => {
    const cutoff = new Date(deps.now().getTime() - constantsOf(deps).get('SHARING_ACTIVITY_KEEP_DAYS') * DAY_MS).toISOString();
    let total = 0;
    for (;;) {
      const deleted = (await deps.db.run(PRUNE, { cutoff, batch: ACTIVITY_DELETE_BATCH })).changes;
      total += deleted;
      if (deleted < ACTIVITY_DELETE_BATCH) return total;
    }
  },
};

// Reading it ------------------------------------------------------------------------------------------------------------

interface VisibleGrant {
  id: string;
  side: 'owner' | 'grantee';
  name: string;
  email: string;
  state: SharingActivityGrant['state'];
}

interface ActivityRowDb {
  grant_id: string;
  hour: string;
  area: SharingActivityArea;
  action: string;
  via: SharingActivityVia;
  events: number;
  by_owner: boolean;
  sort_id: string;
}

/**
 * GET /api/sharing/activity: the rows of the shares `readerId` is on, newest hour first: as the owner, every row of the
 * grant; as the grantee, the rows of a grant they accepted up to its end. `query.key` narrows it to one share (another
 * person's key reads as none).
 */
export async function activityOf(deps: Deps, readerId: string, query: SharingActivityQuery): Promise<SharingActivity> {
  const staleMessage = constantsOf(deps).message(SHARING_MESSAGES.activityStale);
  const after = query.cursor
    ? afterCursor(query.cursor, { sortColumn: 'a.hour', idColumn: SORT_ID, staleMessage })
    : null;
  const rows = await deps.db.all<ActivityRowDb>(
    `SELECT a.grant_id, a.hour, a.area, a.action, a.via, a.events, (a.actor_user_id = g.owner_user_id) AS by_owner,
            ${SORT_ID} AS sort_id
       FROM profile_activity a
       JOIN profile_grants g ON g.id = a.grant_id
      WHERE (g.owner_user_id = @reader
             OR (g.grantee_user_id = @reader AND g.accepted_at IS NOT NULL
                 AND (g.ended_at IS NULL OR a.hour <= g.ended_at)))
        ${query.key ? 'AND a.grant_id = @key' : ''}
        ${after ? `AND ${after.sql}` : ''}
      ORDER BY a.hour DESC, ${SORT_ID} DESC
      LIMIT @limit`,
    { reader: readerId, key: query.key ?? null, limit: query.limit + 1, ...(after?.params ?? {}) },
  );
  const page = rows.slice(0, query.limit);
  const grants = await visibleGrants(
    deps,
    readerId,
    [...new Set(page.map((row) => row.grant_id))],
  );
  const known = new Set(grants.map((grant) => grant.id));
  const out: SharingActivity = {
    grants: grants.map((grant) => ({
      key: grant.id as ProfileKey,
      side: grant.side,
      name: grant.name,
      email: grant.email,
      state: grant.state,
    })),
    rows: page
      .filter((row) => known.has(row.grant_id))
      .map(
        (row): SharingActivityRow => ({
          key: row.grant_id as ProfileKey,
          hour: new Date(row.hour).toISOString(),
          area: row.area,
          action: row.action,
          via: row.via,
          by: row.by_owner ? 'owner' : 'grantee',
          events: Number(row.events),
        }),
      ),
  };
  const last = page.at(-1);
  if (rows.length > query.limit && last) out.nextCursor = encodeCursor({ c: new Date(last.hour).toISOString(), id: last.sort_id });
  return out;
}

/** The keyset's second key: one row of an hour. */
const SORT_ID = `(a.grant_id || '|' || a.area || '|' || a.action || '|' || a.via)`;

/** The grants `ids` as `readerId` sees them (their side, the other person). */
async function visibleGrants(deps: Deps, readerId: string, ids: readonly string[]): Promise<VisibleGrant[]> {
  if (ids.length === 0) return [];
  return deps.db.all<VisibleGrant>(
    `SELECT g.id,
            CASE WHEN g.owner_user_id = @reader THEN 'owner' ELSE 'grantee' END AS side,
            CASE WHEN g.owner_user_id = @reader THEN coalesce(b.name, '') ELSE o.name END AS name,
            CASE WHEN g.owner_user_id = @reader THEN g.grantee_email ELSE o.email END AS email,
            ${SHOWN_STATE} AS state
       FROM profile_grants g
       JOIN users o ON o.id = g.owner_user_id
       LEFT JOIN users b ON b.id = g.grantee_user_id
      WHERE g.id = ANY(CAST(@ids AS text[]))
        AND (g.owner_user_id = @reader OR (g.grantee_user_id = @reader AND g.accepted_at IS NOT NULL))
      ORDER BY g.created_at DESC, g.id`,
    { reader: readerId, ids: sqlTextArray(ids), now: deps.now().toISOString() },
  );
}

