import { DAY_MS } from '@tailorit/shared';
import {
  GRANT_ENDED_STATES,
  SHARING_MESSAGES,
  canonicalMailbox,
  normalizePermissions,
  type GrantCreateBody,
  type GrantCreated,
  type GrantPatchBody,
  type GrantStopBody,
  type GrantView,
  type SharePermission,
  type SharingGrants,
} from '@tailorit/shared/sharing';
import { newGrantCanary, newProfileKey, permissionsLiteral, sharingSettings } from '../../core/auth/grants';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps, SessionUser } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { AppError, conflict, validationFailed } from '../../core/http/errors';
import { recordGrantEvent } from './activity';
import { endGrant } from './end-grant';
import { notifySharing, sharingDedupeKey } from './notices';
import { GRANT_COLUMNS, GRANT_FROM, grantViewOf, type GrantRow } from './rows';
import { afterExpired, expireOverdue } from './sweep';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §2): the owner's side (A) of sharing: the people A shares the profile
// with, the invite, a change of boxes or end date, and stopping (or cancelling an invite). Every change runs on A's own
// profile only (the routes are `never` while acting: nobody passes access on).
//
// The invite answers the same (202, MSG_SHARING_INVITE_SENT) for every address: it never reads who has an account, so
// it cannot be used to find out (as the sign-in code request, features/auth/service.ts). Its refusals read only A's
// own data: A's own address or mailbox (canonicalMailbox: a +tag dropped, gmail dots dropped), a share already open to
// that address, SHARING_GRANTS_PER_OWNER open shares, SHARING_INVITES_PER_DAY invites in 24 hours (both counted under
// lockPerson(A)). Nothing is emailed: B sees the invite in the account menu and Settings › Sharing when they sign in
// with that address.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** The most ended shares A's list shows (newest first), besides every open one. */
export const ENDED_GRANTS_SHOWN = 50;

const message = (deps: Deps, key: (typeof SHARING_MESSAGES)[keyof typeof SHARING_MESSAGES], params?: Record<string, string | number>) =>
  constantsOf(deps).message(key, params);

/** 404: a share that is not A's, or not there any more. */
export const grantGone = (deps: Deps) => new AppError('not_found', message(deps, SHARING_MESSAGES.grantGone));
/** 403: SHARING_ENABLED is off (a new share or an accept). */
export const sharingOff = (deps: Deps) => new AppError('forbidden', message(deps, SHARING_MESSAGES.off));

/** An end date as stored: null, or an ISO time after now (400 otherwise). */
function endDateOf(deps: Deps, value: string | null): string | null {
  if (value === null) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= deps.now().getTime()) {
    const words = message(deps, SHARING_MESSAGES.endDatePast);
    throw validationFailed(words, { accessEndsAt: words });
  }
  return new Date(at).toISOString();
}

/** One of A's grants, locked for the change. */
async function lockedGrantOf(deps: Deps, t: DbQueries, ownerId: string, key: string): Promise<GrantRow | undefined> {
  return t.one<GrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM ${GRANT_FROM} WHERE g.id = @key AND g.owner_user_id = @owner FOR UPDATE OF g`,
    { key, owner: ownerId, now: deps.now().toISOString() },
  );
}

async function grantRowOf(deps: Deps, db: DbQueries, key: string): Promise<GrantRow> {
  const row = await db.one<GrantRow>(`SELECT ${GRANT_COLUMNS} FROM ${GRANT_FROM} WHERE g.id = @key`, {
    key,
    now: deps.now().toISOString(),
  });
  if (!row) throw new Error(`profile_grants ${key} is gone`);
  return row;
}

/** GET /api/sharing/grants: the people A shares the profile with: every open share, then the latest ended ones. */
export async function listGrants(deps: Deps, ownerId: string): Promise<SharingGrants> {
  const rows = await deps.db.all<GrantRow>(
    `(SELECT ${GRANT_COLUMNS} FROM ${GRANT_FROM}
       WHERE g.owner_user_id = @owner AND g.state IN ('pending', 'active'))
     UNION ALL
     (SELECT ${GRANT_COLUMNS} FROM ${GRANT_FROM}
       WHERE g.owner_user_id = @owner AND g.state NOT IN ('pending', 'active')
       ORDER BY g.ended_at DESC, g.id LIMIT @ended)
     ORDER BY created_at DESC, id`,
    { owner: ownerId, ended: ENDED_GRANTS_SHOWN, now: deps.now().toISOString() },
  );
  return { grants: rows.map(grantViewOf) };
}

/** POST /api/sharing/grants: A invites `body.email` with the boxes ticked. The same answer for every address. */
export async function createGrant(deps: Deps, owner: SessionUser, body: GrantCreateBody): Promise<GrantCreated> {
  const settings = sharingSettings(deps);
  if (!settings.enabled) throw sharingOff(deps);
  if (body.email === owner.email.trim().toLowerCase() || canonicalMailbox(body.email) === canonicalMailbox(owner.email)) {
    const words = message(deps, SHARING_MESSAGES.ownEmail);
    throw validationFailed(words, { email: words });
  }
  const accessEndsAt = endDateOf(deps, body.accessEndsAt);
  const now = deps.now();
  const nowIso = now.toISOString();

  const { key, expired } = await deps.db.tx(
    async (t) => {
      await t.lockPerson(owner.id);
      // A's own shares whose date passed end first (as the sweep would): a lapsed invite frees its place and address.
      const expired = await expireOverdue(deps, t, owner.id);
      const open = await t.one<{ duplicate: boolean; open: number }>(
        `SELECT bool_or(lower(grantee_email) = @email) AS duplicate, count(*) AS open
           FROM profile_grants WHERE owner_user_id = @owner AND state IN ('pending', 'active')`,
        { owner: owner.id, email: body.email },
      );
      if (open?.duplicate) throw conflict(message(deps, SHARING_MESSAGES.alreadyShared));
      if (Number(open?.open ?? 0) >= settings.grantsPerOwner) {
        throw conflict(message(deps, SHARING_MESSAGES.grantsMax, { max: settings.grantsPerOwner }));
      }
      const day = await t.one<{ sent: number; oldest: string | null }>(
        `SELECT count(*) AS sent, min(created_at) AS oldest FROM profile_grants
          WHERE owner_user_id = @owner AND created_at > CAST(@since AS timestamptz)`,
        { owner: owner.id, since: new Date(now.getTime() - DAY_MS).toISOString() },
      );
      if (Number(day?.sent ?? 0) >= settings.invitesPerDay) {
        const freesAt = day?.oldest ? Date.parse(day.oldest) + DAY_MS : now.getTime() + DAY_MS;
        const retryAfterSeconds = Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000));
        throw new AppError('rate_limited', message(deps, SHARING_MESSAGES.invitesPerDay, { max: settings.invitesPerDay }), {
          retryAfterSeconds,
        });
      }
      const key = newProfileKey();
      await t.run(
        `INSERT INTO profile_grants(id, owner_user_id, grantee_email, permissions, state, invite_expires_at, access_ends_at,
           remove_queued, canary, created_at, changed_at)
         VALUES (@id, @owner, @email, CAST(@perms AS text[]), 'pending', CAST(@expires AS timestamptz),
           CAST(@ends AS timestamptz), true, @canary, CAST(@now AS timestamptz), CAST(@now AS timestamptz))`,
        {
          id: key,
          owner: owner.id,
          email: body.email,
          perms: permissionsLiteral(body.permissions),
          expires: new Date(now.getTime() + settings.inviteDays * DAY_MS).toISOString(),
          ends: accessEndsAt,
          canary: newGrantCanary(),
          now: nowIso,
        },
      );
      await recordGrantEvent(deps, t, { grantId: key, ownerId: owner.id, actorId: owner.id, action: 'invited' });
      return { key, expired };
    },
    { label: 'sharing invite' },
  );
  await afterExpired(deps, expired);
  const grant = grantViewOf(await grantRowOf(deps, deps.db, key));
  return { message: message(deps, SHARING_MESSAGES.inviteSent, { email: body.email }), grant };
}

/**
 * PATCH /api/sharing/grants/:key: A's new boxes and/or end date for an open share (an ended one: 404). Effective on B's
 * next request (the live check reads them). An accepted share's change tells B (sharing_changed); boxes taken away
 * stop the work they allowed (endGrant, cause `permissions`).
 */
export async function changeGrant(deps: Deps, owner: SessionUser, key: string, body: GrantPatchBody): Promise<GrantView> {
  const nowIso = deps.now().toISOString();
  const outcome = await deps.db.tx(
    async (t) => {
      const row = await lockedGrantOf(deps, t, owner.id, key);
      if (!row || (row.shown_state !== 'pending' && row.shown_state !== 'active')) throw grantGone(deps);
      const before = normalizePermissions(row.permissions ?? []);
      const permissions = body.permissions ?? before;
      const beforeEnds = row.access_ends_at === null ? null : new Date(row.access_ends_at).toISOString();
      const ends = body.accessEndsAt === undefined ? beforeEnds : endDateOf(deps, body.accessEndsAt);
      const removed = before.filter((perm) => !permissions.includes(perm));
      const changed = permissions.join(' ') !== before.join(' ') || ends !== beforeEnds;
      if (!changed) return { row, changed: false, removed: [] as SharePermission[] };
      await t.run(
        `UPDATE profile_grants SET permissions = CAST(@perms AS text[]), access_ends_at = CAST(@ends AS timestamptz),
                changed_at = CAST(@now AS timestamptz)
          WHERE id = @key`,
        { key, perms: permissionsLiteral(permissions), ends, now: nowIso },
      );
      await recordGrantEvent(deps, t, { grantId: key, ownerId: owner.id, actorId: owner.id, action: 'changed' });
      return { row: await grantRowOf(deps, t, key), changed: true, removed };
    },
    { label: 'sharing change' },
  );
  const { row } = outcome;
  if (outcome.changed && row.state === 'active' && row.grantee_user_id !== null) {
    await notifySharing(
      deps,
      row.grantee_user_id,
      'sharing_changed',
      { name: owner.name, email: owner.email },
      sharingDedupeKey('sharing_changed', key, nowIso),
    );
    if (outcome.removed.length > 0) await endGrant(deps, key, { cause: 'permissions', permissions: outcome.removed });
  }
  return grantViewOf(row);
}

/**
 * POST /api/sharing/grants/:key/stop: A stops sharing (an accepted share: B is told, B's work stops, and with
 * `removeQueued` the jobs B queued that no extension took are removed too) or cancels an invite. A share that already
 * ended answers the same (204), changing nothing.
 */
export async function stopGrant(deps: Deps, owner: SessionUser, key: string, body: GrantStopBody): Promise<void> {
  const nowIso = deps.now().toISOString();
  const stopped = await deps.db.tx(
    async (t) => {
      const row = await lockedGrantOf(deps, t, owner.id, key);
      if (!row) throw grantGone(deps);
      if ((GRANT_ENDED_STATES as readonly string[]).includes(row.state)) return null;
      await t.run(
        `UPDATE profile_grants SET state = 'revoked', ended_at = CAST(@now AS timestamptz), changed_at = CAST(@now AS timestamptz),
                remove_queued = @removeQueued
          WHERE id = @key`,
        { key, now: nowIso, removeQueued: body.removeQueued },
      );
      const action = row.state === 'active' ? 'revoked' : 'cancelled';
      await recordGrantEvent(deps, t, { grantId: key, ownerId: owner.id, actorId: owner.id, action });
      return row;
    },
    { label: 'sharing stop' },
  );
  if (!stopped || stopped.state !== 'active' || stopped.grantee_user_id === null) return;
  await notifySharing(
    deps,
    stopped.grantee_user_id,
    'sharing_ended',
    { name: owner.name, email: owner.email },
    sharingDedupeKey('sharing_ended', key),
  );
  await endGrant(deps, key, { cause: 'revoked' });
}
