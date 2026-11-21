import {
  SHARING_MESSAGES,
  isProfileKey,
  normalizePermissions,
  sameMailbox,
  type ProfileKey,
  type SharedProfiles,
  type SharingInvite,
} from '@tailorit/shared/sharing';
import { reachableProfiles, sharingSettings } from '../../core/auth/grants';
import { normalizeEmail } from '../../core/auth/users';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps, SessionUser } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { AppError, conflict } from '../../core/http/errors';
import { recordGrantEvent } from './activity';
import { endGrant } from './end-grant';
import { grantGone, sharingOff } from './grants';
import { notifySharing, sharingDedupeKey } from './notices';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §2): the grantee's side (B): the profiles shared with B and B's invites
// (the switcher's list, Settings › Sharing), accepting, declining and leaving, and the header's invite count with its
// lazy notice. An invite is B's when it was sent to B's sign-in address (verified: B proved it to sign in). Every refusal
// of an invite answers the same (404 MSG_SHARING_INVITE_GONE): unknown, someone else's, answered, expired, its owner
// disabled, B's own mailbox.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

const inviteGone = (deps: Deps) =>
  new AppError('not_found', constantsOf(deps).message(SHARING_MESSAGES.inviteGone));

/** The invites waiting for the person whose (normalised) address is @email, their own @me excluded (alias g, o). */
const INVITES_WHERE = `g.state = 'pending' AND g.grantee_email = @email AND g.invite_expires_at > CAST(@now AS timestamptz)
  AND o.disabled_at IS NULL AND g.owner_user_id <> @me`;

/** GET /api/sharing/profiles: the live profiles shared with `actor` and the invites waiting for them. */
export async function sharedProfiles(deps: Deps, actor: SessionUser): Promise<SharedProfiles> {
  if (!sharingSettings(deps).enabled) return { enabled: false, profiles: [], invites: [] };
  const grants = await reachableProfiles(deps, actor.id);
  const invites = await deps.db.all<{
    id: string;
    permissions: string[] | null;
    invite_expires_at: string;
    created_at: string;
    owner_name: string;
    owner_email: string;
  }>(
    `SELECT g.id, g.permissions, g.invite_expires_at, g.created_at, o.name AS owner_name, o.email AS owner_email
       FROM profile_grants g JOIN users o ON o.id = g.owner_user_id
      WHERE ${INVITES_WHERE}
      ORDER BY g.created_at DESC, g.id`,
    { email: normalizeEmail(actor.email), me: actor.id, now: deps.now().toISOString() },
  );
  return {
    enabled: true,
    profiles: grants.map((grant) => ({
      key: grant.id,
      name: grant.owner.name,
      email: grant.owner.email,
      permissions: [...grant.permissions],
      accessEndsAt: grant.accessEndsAt === null ? null : new Date(grant.accessEndsAt).toISOString(),
      acceptedAt: new Date(grant.acceptedAt).toISOString(),
    })),
    invites: invites
      .filter((row) => !sameMailbox(row.owner_email, actor.email))
      .map(
        (row): SharingInvite => ({
          key: row.id as ProfileKey,
          fromName: row.owner_name,
          fromEmail: row.owner_email,
          permissions: normalizePermissions(row.permissions ?? []),
          expiresAt: new Date(row.invite_expires_at).toISOString(),
          createdAt: new Date(row.created_at).toISOString(),
        }),
      ),
  };
}

interface InviteRow {
  id: string;
  owner_user_id: string;
  owner_name: string;
  owner_email: string;
}

/** The invite `key` when it waits for `actor` (locked for the answer); 404 inviteGone otherwise. */
async function lockedInviteOf(deps: Deps, t: DbQueries, actor: SessionUser, key: string): Promise<InviteRow> {
  if (!isProfileKey(key)) throw inviteGone(deps);
  const row = await t.one<InviteRow>(
    `SELECT g.id, g.owner_user_id, o.name AS owner_name, o.email AS owner_email
       FROM profile_grants g JOIN users o ON o.id = g.owner_user_id
      WHERE g.id = @key AND ${INVITES_WHERE}
      FOR UPDATE OF g`,
    { key, email: normalizeEmail(actor.email), me: actor.id, now: deps.now().toISOString() },
  );
  if (!row || sameMailbox(row.owner_email, actor.email)) throw inviteGone(deps);
  return row;
}

/**
 * POST /api/sharing/profiles/:key/accept: B accepts an invite to B's address, under SHARING_PROFILES_PER_GRANTEE live
 * profiles (counted under lockPerson(B)). A is told (sharing_accepted).
 */
export async function acceptInvite(deps: Deps, actor: SessionUser, key: string): Promise<void> {
  const settings = sharingSettings(deps);
  if (!settings.enabled) throw sharingOff(deps);
  const nowIso = deps.now().toISOString();
  const invite = await deps.db.tx(
    async (t) => {
      await t.lockPerson(actor.id);
      const invite = await lockedInviteOf(deps, t, actor, key);
      const held = await t.one<{ n: number }>(
        `SELECT count(*) AS n FROM profile_grants
          WHERE grantee_user_id = @me AND state = 'active'
            AND (access_ends_at IS NULL OR access_ends_at > CAST(@now AS timestamptz))`,
        { me: actor.id, now: nowIso },
      );
      if (Number(held?.n ?? 0) >= settings.profilesPerGrantee) {
        throw conflict(constantsOf(deps).message(SHARING_MESSAGES.profilesMax, { max: settings.profilesPerGrantee }));
      }
      await t.run(
        `UPDATE profile_grants SET state = 'active', grantee_user_id = @me, accepted_at = CAST(@now AS timestamptz),
                changed_at = CAST(@now AS timestamptz)
          WHERE id = @key`,
        { key, me: actor.id, now: nowIso },
      );
      await recordGrantEvent(deps, t, { grantId: key, ownerId: invite.owner_user_id, actorId: actor.id, action: 'accepted' });
      return invite;
    },
    { label: 'sharing accept' },
  );
  await notifySharing(deps, invite.owner_user_id, 'sharing_accepted', actor, sharingDedupeKey('sharing_accepted', key));
}

/** POST /api/sharing/profiles/:key/decline: B says no to an invite to B's address. A is told (sharing_declined). */
export async function declineInvite(deps: Deps, actor: SessionUser, key: string): Promise<void> {
  const nowIso = deps.now().toISOString();
  const invite = await deps.db.tx(
    async (t) => {
      const invite = await lockedInviteOf(deps, t, actor, key);
      await t.run(
        `UPDATE profile_grants SET state = 'declined', ended_at = CAST(@now AS timestamptz), changed_at = CAST(@now AS timestamptz)
          WHERE id = @key`,
        { key, now: nowIso },
      );
      await recordGrantEvent(deps, t, { grantId: key, ownerId: invite.owner_user_id, actorId: actor.id, action: 'declined' });
      return invite;
    },
    { label: 'sharing decline' },
  );
  await notifySharing(deps, invite.owner_user_id, 'sharing_declined', actor, sharingDedupeKey('sharing_declined', key));
}

/**
 * POST /api/sharing/profiles/:key/leave: B leaves a profile shared with them (an accepted share, live or not yet swept).
 * A is told (sharing_ended) and B's work there stops (endGrant). A key that is not B's accepted share: 404 grantGone.
 */
export async function leaveProfile(deps: Deps, actor: SessionUser, key: string): Promise<void> {
  if (!isProfileKey(key)) throw grantGone(deps);
  const nowIso = deps.now().toISOString();
  const left = await deps.db.tx(
    async (t) => {
      const row = await t.one<{ owner_user_id: string }>(
        `SELECT owner_user_id FROM profile_grants WHERE id = @key AND grantee_user_id = @me AND state = 'active' FOR UPDATE`,
        { key, me: actor.id },
      );
      if (!row) throw grantGone(deps);
      await t.run(
        `UPDATE profile_grants SET state = 'left', ended_at = CAST(@now AS timestamptz), changed_at = CAST(@now AS timestamptz)
          WHERE id = @key`,
        { key, now: nowIso },
      );
      await recordGrantEvent(deps, t, { grantId: key, ownerId: row.owner_user_id, actorId: actor.id, action: 'left' });
      return row;
    },
    { label: 'sharing leave' },
  );
  await notifySharing(deps, left.owner_user_id, 'sharing_ended', actor, sharingDedupeKey('sharing_ended', key));
  await endGrant(deps, key, { cause: 'left' });
}

// The header ------------------------------------------------------------------------------------------------------------

/** The header's parameters for HEADER_INVITE_COLUMNS (./header-sql.ts). */
export function headerInviteParams(deps: Deps): { sharing: boolean; now: string } {
  return { sharing: sharingSettings(deps).enabled, now: deps.now().toISOString() };
}

/**
 * The header saw invites without a notice (invites_unnoticed > 0): writes sharing_invited once per invite (dedupe
 * `sharing_invited:<key>`), now that the invited person signed in. Written lazily (never when A invites), so an invite
 * never tells A, by its timing or its answer, who has an account. Never throws; answers how many it wrote.
 */
export async function noticeInvites(deps: Deps, reader: { id: string; email: string }): Promise<number> {
  try {
    const rows = await deps.db.all<{ id: string; owner_name: string; owner_email: string }>(
      `SELECT g.id, o.name AS owner_name, o.email AS owner_email
         FROM profile_grants g JOIN users o ON o.id = g.owner_user_id
        WHERE ${INVITES_WHERE}
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = @me AND n.dedupe_key = 'sharing_invited:' || g.id)
        ORDER BY g.created_at, g.id`,
      { email: normalizeEmail(reader.email), me: reader.id, now: deps.now().toISOString() },
    );
    let written = 0;
    for (const row of rows) {
      if (sameMailbox(row.owner_email, reader.email)) continue;
      const outcome = await notifySharing(
        deps,
        reader.id,
        'sharing_invited',
        { name: row.owner_name, email: row.owner_email },
        sharingDedupeKey('sharing_invited', row.id),
      );
      if (outcome === 'written') written += 1;
    }
    return written;
  } catch (error) {
    deps.log.warn('[sharing] the invite notices were not written; the next header read tries again', error);
    return 0;
  }
}
