import { randomBytes } from 'node:crypto';
import { sharedMessage } from '@tailorit/shared';
import {
  PROFILE_KEY_ALPHABET,
  PROFILE_KEY_LENGTH,
  SHARING_BAD_PROFILE_MESSAGE,
  SHARING_ERROR_MESSAGES,
  isProfileKey,
  isSharePermission,
  normalizePermissions,
  type ProfileKey,
  type SharePermission,
} from '@tailorit/shared/sharing';
import { constantsOf } from '../constants/service';
import { nowIso, type ActingContext, type ActingOwner, type AppDeps } from '../context';
import type { DbQueries } from '../db/types'; // v33 SHARE-5
import { AppError } from '../http/errors';

// v33 SHARE-0 (PLAN F9; SP v33 PLAN-sharing.md §1 rule 2, §4): whether a grant is live, the one place that decides it.
// A grant (profile_grants, migration 0048) lets its grantee (B) work on its owner's (A's) profile while ALL of these hold:
//   - its state is 'active' (B accepted; A has not stopped it, B has not left it);
//   - its access end date is unset or later than now (deps.now(); the sweep writes 'expired' later, the check never
//     waits for it);
//   - both accounts are enabled (users.disabled_at);
//   - SHARING_ENABLED is on.
// Every request that names a profile (resolveGrant), every list of profiles (reachableProfiles: the overview, the
// activity, the switcher, prepare_queue, MCP's PROFILES list) and every step of background work (assertGrantLive,
// liveGrantById, liveGrantsByIds) reads it again with the same SQL (LIVE_GRANT_SQL): nothing is cached. A key that is
// unknown, someone else's (another grantee, or the owner's own key) or not live gives the same answer: null here,
// profile_ended to a request, with no name and no id. No other module reads profile_grants (SHARE-1's structure scan),
// but features/sharing, which writes it.
//
// A LiveGrant is branded: only this module makes one, so a Payer built from a grant (payer.ts payerOfGrant) always comes
// from a live check.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

declare const LIVE: unique symbol;

/** A grant that was live when it was read (the predicate above), with its owner. Made only by this module. */
export interface LiveGrant {
  /** The profile key (profile_grants.id). */
  readonly id: ProfileKey;
  /** Whose profile: A, by id, sign-in address and name. */
  readonly owner: { readonly id: string; readonly email: string; readonly name: string };
  /** Who may use it: B. */
  readonly granteeId: string;
  /** The boxes A ticked (closed, canonical order). */
  readonly permissions: readonly SharePermission[];
  readonly accessEndsAt: string | null;
  readonly acceptedAt: string;
  /** When the boxes or the end date last changed (MCP's rules pointer). */
  readonly changedAt: string;
  readonly [LIVE]: true;
}

/** The columns every live read answers. */
interface LiveRow {
  id: string;
  owner_user_id: string;
  owner_email: string;
  owner_name: string;
  grantee_user_id: string;
  permissions: string[] | null;
  access_ends_at: string | null;
  accepted_at: string;
  changed_at: string;
}

/**
 * The one live-grant predicate, as a SELECT of the live grants and their owners (alias g for profile_grants, o for the
 * owner, b for the grantee) with the parameter @now; callers add `AND ...` conditions. Exported for the structure
 * scan's tests and for features/sharing's own reads; any other module asks the functions below.
 */
export const LIVE_GRANT_SQL = `SELECT g.id, g.owner_user_id, o.email AS owner_email, o.name AS owner_name, g.grantee_user_id,
         g.permissions, g.access_ends_at, g.accepted_at, g.changed_at
    FROM profile_grants g
    JOIN users o ON o.id = g.owner_user_id
    JOIN users b ON b.id = g.grantee_user_id
   WHERE g.state = 'active'
     AND (g.access_ends_at IS NULL OR g.access_ends_at > CAST(@now AS timestamptz))
     AND o.disabled_at IS NULL
     AND b.disabled_at IS NULL
     AND g.grantee_user_id <> g.owner_user_id`;

function liveGrantOf(row: LiveRow): LiveGrant {
  return Object.freeze({
    id: row.id as ProfileKey,
    owner: Object.freeze({ id: row.owner_user_id, email: row.owner_email, name: row.owner_name }),
    granteeId: row.grantee_user_id,
    permissions: Object.freeze(normalizePermissions(row.permissions ?? [])),
    accessEndsAt: row.access_ends_at,
    acceptedAt: row.accepted_at,
    changedAt: row.changed_at,
  }) as LiveGrant;
}

/** `perms` as a PostgreSQL text[] literal ('{tracker:view,mcp}'): bind it as CAST(@perms AS text[]). */
export function permissionsLiteral(perms: Iterable<SharePermission>): string {
  return `{${normalizePermissions(perms).join(',')}}`;
}

const asList = (perms: SharePermission | readonly SharePermission[] | undefined): readonly SharePermission[] =>
  perms === undefined ? [] : typeof perms === 'string' ? [perms] : perms;

/** Whether a live grant holds every one of `perms`. */
export function grantHolds(grant: LiveGrant, perms: SharePermission | readonly SharePermission[]): boolean {
  return asList(perms).every((perm) => grant.permissions.includes(perm));
}

/** SHARING_ENABLED, read now (an admin's change applies to the next request). */
export const sharingEnabled = (deps: Deps): boolean => constantsOf(deps).get('SHARING_ENABLED');

/**
 * The grant `key` names for `actorId` (the signed-in person) when it is live and theirs; null otherwise: a malformed
 * key, an unknown one, someone else's (including the owner's own key) or one that ended. attachActing (SHARE-1) calls it
 * for every request that names a profile; one primary-key read.
 */
export async function resolveGrant(deps: Deps, actorId: string, key: string): Promise<LiveGrant | null> {
  if (!isProfileKey(key) || !actorId || !sharingEnabled(deps)) return null;
  const row = await deps.db.one<LiveRow>(`${LIVE_GRANT_SQL} AND g.id = @key AND g.grantee_user_id = @actor`, {
    key,
    actor: actorId,
    now: nowIso(deps),
  });
  return row ? liveGrantOf(row) : null;
}

/**
 * Every live grant `actorId` holds with all of `perms` (none: every live grant), oldest accepted first. The only way
 * the overview, the activity, the switcher, prepare_queue and MCP's PROFILES list find profiles.
 */
export async function reachableProfiles(
  deps: Deps,
  actorId: string,
  perms: readonly SharePermission[] = [],
): Promise<LiveGrant[]> {
  if (!actorId || !sharingEnabled(deps)) return [];
  const rows = await deps.db.all<LiveRow>(
    `${LIVE_GRANT_SQL} AND g.grantee_user_id = @actor AND g.permissions @> CAST(@perms AS text[]) ORDER BY g.accepted_at, g.id`,
    { actor: actorId, perms: permissionsLiteral(perms), now: nowIso(deps) },
  );
  return rows.map(liveGrantOf);
}

/** The grant `grantId` when it is live (whatever it holds), else null: background work that knows its row's grant. */
export async function liveGrantById(deps: Deps, grantId: string | null | undefined): Promise<LiveGrant | null> {
  if (!grantId || !isProfileKey(grantId) || !sharingEnabled(deps)) return null;
  const row = await deps.db.one<LiveRow>(`${LIVE_GRANT_SQL} AND g.id = @key`, { key: grantId, now: nowIso(deps) });
  return row ? liveGrantOf(row) : null;
}

// v33 SHARE-5 (the SHARE-5 review, 2026-11-20: decisions 2 and 5) --------------------------------------------------------
/**
 * The grant `grantId` when it is live (as liveGrantById), read on `db` inside the caller's transaction with its row
 * locked until that transaction ends:
 * - `share` (FOR SHARE): a change, a stop, a leave or an expiry of the grant (each locks or updates its row) waits for
 *   the caller's commit, so what the caller decided from it (a job queued, held or not) is in place when that change's
 *   endGrant runs; a caller that comes after such a change reads the grant as it committed.
 * - `update` (FOR NO KEY UPDATE): as `share`, and a second such caller of the same grant waits too: a count, then a
 *   write per grant (SHARING_WAITING_PER_GRANT).
 * Lock the grant before the owner's person lock (lockPerson), as every caller does.
 */
export async function lockedLiveGrant(
  deps: Deps,
  db: Pick<DbQueries, 'one'>,
  grantId: string | null | undefined,
  lock: 'share' | 'update',
): Promise<LiveGrant | null> {
  if (!grantId || !isProfileKey(grantId) || !sharingEnabled(deps)) return null;
  const row = await db.one<LiveRow>(`${LIVE_GRANT_SQL} AND g.id = @key ${lock === 'share' ? 'FOR SHARE' : 'FOR NO KEY UPDATE'} OF g`, {
    key: grantId,
    now: nowIso(deps),
  });
  return row ? liveGrantOf(row) : null;
}
// end v33 SHARE-5

/** The live grants among `grantIds` (one read for a pass over many rows: the runner, the queue), by id. */
export async function liveGrantsByIds(deps: Deps, grantIds: Iterable<string | null | undefined>): Promise<Map<string, LiveGrant>> {
  const ids = [...new Set([...grantIds].filter((id): id is string => typeof id === 'string' && isProfileKey(id)))];
  if (ids.length === 0 || !sharingEnabled(deps)) return new Map();
  const rows = await deps.db.all<LiveRow>(`${LIVE_GRANT_SQL} AND g.id = ANY(CAST(@ids AS text[]))`, {
    ids: `{${ids.join(',')}}`,
    now: nowIso(deps),
  });
  return new Map(rows.map((row) => [row.id, liveGrantOf(row)]));
}

/**
 * Background work's check (a Prepare's step, an AI task at enqueue and at run, a backlog row, MCP's per-call work): the
 * grant `grantId` is live and holds `perms`. Throws profile_ended when it is not live (or there is none), and
 * profile_not_shared when it lacks a permission; the caller stops the work (a Prepare: `cancelled`, `access_ended`).
 */
export async function assertGrantLive(
  deps: Deps,
  grantId: string | null | undefined,
  perms: SharePermission | readonly SharePermission[],
): Promise<LiveGrant> {
  const grant = await liveGrantById(deps, grantId);
  if (!grant) throw profileEnded();
  if (!grantHolds(grant, perms)) throw profileNotShared();
  return grant;
}

/** A grant its grantee accepted, live or ended since, with what only the server uses (MCP's tripwire). */
export interface HeldGrant {
  readonly id: ProfileKey;
  readonly ownerId: string;
  /** The grant's tripwire (profile_grants.canary): never sent to A or B, never logged. */
  readonly canary: string;
  /** When the boxes, the end date or the state last changed. */
  readonly changedAt: string;
  /** Live now (the predicate above). */
  readonly live: boolean;
}

/**
 * Every grant `actorId` accepted, live or ended since, the newest change first: MCP's tripwires (a save that holds any
 * of them is refused, on any profile; the live grant's wraps its owner's text) and its rules pointer (a change since the
 * last read). One read; the only way outside features/sharing to see a grant's canary.
 */
export async function heldGrants(deps: Deps, actorId: string): Promise<HeldGrant[]> {
  if (!actorId) return [];
  const enabled = sharingEnabled(deps);
  const rows = await deps.db.all<{ id: string; owner_user_id: string; canary: string; changed_at: string; live: boolean }>(
    `SELECT h.id, h.owner_user_id, h.canary, h.changed_at, (h.id IN (SELECT l.id FROM (${LIVE_GRANT_SQL} AND g.grantee_user_id = @actor) l)) AS live
       FROM profile_grants h
      WHERE h.grantee_user_id = @actor AND h.accepted_at IS NOT NULL
      ORDER BY h.changed_at DESC, h.id`,
    { actor: actorId, now: nowIso(deps) },
  );
  return rows.map((row) =>
    Object.freeze({
      id: row.id as ProfileKey,
      ownerId: row.owner_user_id,
      canary: row.canary,
      changedAt: row.changed_at,
      live: enabled && row.live,
    }),
  );
}

/** The owner as a request acting on the grant sees them: `userOf(req)`, the role forced to `user`. */
export function actingOwnerOf(grant: LiveGrant): ActingOwner {
  return { id: grant.owner.id, email: grant.owner.email, name: grant.owner.name, role: 'user' };
}

/** req.acting for a request the route guard lets act on `grant` under the route's permission `routePerm`. */
export function actingContextOf(grant: LiveGrant, routePerm: SharePermission): ActingContext {
  if (!isSharePermission(routePerm) || !grant.permissions.includes(routePerm)) throw profileNotShared();
  return { grantId: grant.id, owner: actingOwnerOf(grant), permissions: grant.permissions, routePerm };
}

// Keys and tripwires ----------------------------------------------------------------------------------------------------

/** The largest byte value a key character is drawn from without bias: 4 x 62. */
const KEY_BYTE_LIMIT = 256 - (256 % PROFILE_KEY_ALPHABET.length);

/** A new profile key: `p` and 11 base62 characters from the system's random source (about 65 bits). */
export function newProfileKey(): ProfileKey {
  let key = 'p';
  while (key.length < PROFILE_KEY_LENGTH) {
    for (const byte of randomBytes(16)) {
      if (byte >= KEY_BYTE_LIMIT) continue;
      key += PROFILE_KEY_ALPHABET[byte % PROFILE_KEY_ALPHABET.length];
      if (key.length === PROFILE_KEY_LENGTH) break;
    }
  }
  return key as ProfileKey;
}

/** A new grant's MCP tripwire (profile_grants.canary): 32 random hex characters, never shown. */
export function newGrantCanary(): string {
  return randomBytes(16).toString('hex');
}

// The refusals ----------------------------------------------------------------------------------------------------------
// In the words in use (sharedMessage: the constants service sets them, an admin's edit included), so the synchronous
// guards (userOf, payerOf) can throw them without deps.

/** 403 profile_ended: the named profile is unknown, someone else's or no longer shared (no name, no id). */
export const profileEnded = () => new AppError('profile_ended', sharedMessage(SHARING_ERROR_MESSAGES.profile_ended));
/** 403 profile_not_shared: shared, without the permission this needs. */
export const profileNotShared = () =>
  new AppError('profile_not_shared', sharedMessage(SHARING_ERROR_MESSAGES.profile_not_shared));
/** 403 own_profile_only: never done on a shared profile (or an extension token named one). */
export const ownProfileOnly = () => new AppError('own_profile_only', sharedMessage(SHARING_ERROR_MESSAGES.own_profile_only));
/** 400 validation_failed: a malformed key, a header and a query that disagree, the query form where it is not taken. */
export const badProfile = () => new AppError('validation_failed', sharedMessage(SHARING_BAD_PROFILE_MESSAGE));

// The numbers -----------------------------------------------------------------------------------------------------------

/** The sharing constants, read now (Admin › Constants applies at once): the limits, the reserves, the retention. */
export interface SharingSettings {
  enabled: boolean;
  /** Open grants (pending or active) one owner may have. */
  grantsPerOwner: number;
  /** Live profiles one grantee may accept. */
  profilesPerGrantee: number;
  /** Invites one owner may send in 24 hours. */
  invitesPerDay: number;
  /** Days an invite waits. */
  inviteDays: number;
  /** Hours a grantee's MCP Prepare waits before it expires. */
  mcpStaleHours: number;
  /** Waiting Prepares one grant may have. */
  waitingPerGrant: number;
  /** The owner's last resume places a grantee never takes. */
  resumeReserve: number;
  /** The owner's last queue places a grantee never takes. */
  queueReserve: number;
  /** Days activity rows are kept. */
  activityKeepDays: number;
}

export function sharingSettings(deps: Deps): SharingSettings {
  const constants = constantsOf(deps);
  return {
    enabled: constants.get('SHARING_ENABLED'),
    grantsPerOwner: constants.get('SHARING_GRANTS_PER_OWNER'),
    profilesPerGrantee: constants.get('SHARING_PROFILES_PER_GRANTEE'),
    invitesPerDay: constants.get('SHARING_INVITES_PER_DAY'),
    inviteDays: constants.get('SHARING_INVITE_DAYS'),
    mcpStaleHours: constants.get('SHARING_MCP_STALE_HOURS'),
    waitingPerGrant: constants.get('SHARING_WAITING_PER_GRANT'),
    resumeReserve: constants.get('SHARING_RESUME_RESERVE'),
    queueReserve: constants.get('SHARING_QUEUE_RESERVE'),
    activityKeepDays: constants.get('SHARING_ACTIVITY_KEEP_DAYS'),
  };
}
