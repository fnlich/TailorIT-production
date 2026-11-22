import { SHARING_SETTINGS_PATH } from '@tailorit/shared/sharing';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { notify } from '../notifications/index';
import { endGrant, type EndGrantCause } from './end-grant';
import { sqlTextArray } from './rows';

// v34 ACCTDEL (PLAN G10, account deletion; features/account-deletion/service.ts runs these in its order): what deleting
// an account does to sharing, both ways, as stopping a share does (grants.ts stopGrant, invites.ts leave, endGrant):
// 1. endSharesOfAccount (the delete's first transaction, with the account turned off and the request written): every
//    open share the account gave ends `revoked` (an invite it sent is cancelled), and every share it holds ends `left`;
// 2. stopSharedWork (after that commit): endGrant for each share the deletion ended (sharesEndedByDeletion: accepted,
//    and ended from the request's time on, so a deletion run again after a failure finds them too), so the work the
//    share allowed stops (Prepares, AI tasks, backlogs, MCP sets, the held queue rows) as when a share ends any other
//    way; what the account did there and the owner kept (approved queue rows, finished Prepares, entries) stays the
//    owner's, its preparer let go (0055: prepared_by, started_by ON DELETE SET NULL), as after a leave;
// 3. forgetSharesOfAccount (inside the delete's transaction): what still names the account on the other side goes: the
//    notifications that name it or link to its profile (its name or address is their words), and the invites to its
//    address that it declined. The grants themselves, their activity and what the account did go with its row (their
//    foreign keys cascade);
// 4. tellOtherSides (inside the delete's transaction, after 3): each person who worked on the account's profile, or
//    whose profile it worked on, is told a share ended, in words that name nobody (the account is gone, and so are its
//    name and address), and that say who deleted it: the person ("deleted their account") or an administrator ("the
//    account was deleted").
// An invite someone else sent to the address that the account never answered stays theirs, as they typed it: pending,
// expired or cancelled (removing it would tell them the address had an account). One it declined is removed.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** One share the deletion ended, and who is told. */
export interface EndedShare {
  grantId: string;
  cause: Extract<EndGrantCause, 'revoked' | 'left'>;
  /** The other person, told once the account is gone. */
  otherId: string;
  /** Which words they get: the profile they worked on is gone, or someone left theirs. */
  told: 'owner_deleted' | 'grantee_deleted';
}

/**
 * Step 1, on `t` (the delete's first transaction): ends every open share of `userId`, both ways, at `now` (the
 * request's time on a first run). The caller turned the account off in the same transaction, so no ended share is
 * live again. Answers how many it ended.
 */
export async function endSharesOfAccount(deps: Deps, t: DbQueries, userId: string, now: string): Promise<number> {
  const given = await t.run(
    `WITH open AS (SELECT id FROM profile_grants
                    WHERE owner_user_id = @user AND state IN ('pending', 'active') ORDER BY id FOR UPDATE)
     UPDATE profile_grants g
        SET state = 'revoked', ended_at = CAST(@now AS timestamptz), changed_at = CAST(@now AS timestamptz), remove_queued = true
       FROM open o
      WHERE g.id = o.id`,
    { user: userId, now },
  );
  const held = await t.run(
    `UPDATE profile_grants SET state = 'left', ended_at = CAST(@now AS timestamptz), changed_at = CAST(@now AS timestamptz)
      WHERE grantee_user_id = @user AND state = 'active'`,
    { user: userId, now },
  );
  return given.changes + held.changes;
}

/**
 * The shares a deletion of `userId` asked at `requestedAt` ended: accepted ones (someone worked on them; an invite
 * nobody accepted has no work and nobody to tell) of either side that ended from then on, `revoked` (it gave them) or
 * `left` (it held them). Read again when a deletion that stopped part way is run again.
 */
export async function sharesEndedByDeletion(db: Pick<DbQueries, 'all'>, userId: string, requestedAt: string): Promise<EndedShare[]> {
  const rows = await db.all<{ id: string; owner_user_id: string; grantee_user_id: string | null }>(
    `SELECT id, owner_user_id, grantee_user_id FROM profile_grants
      WHERE (owner_user_id = @user OR grantee_user_id = @user) AND accepted_at IS NOT NULL
        AND state IN ('revoked', 'left') AND ended_at >= CAST(@since AS timestamptz)
      ORDER BY id`,
    { user: userId, since: requestedAt },
  );
  return rows.flatMap((row): EndedShare[] => {
    if (row.owner_user_id === userId) {
      return row.grantee_user_id ? [{ grantId: row.id, cause: 'revoked', otherId: row.grantee_user_id, told: 'owner_deleted' }] : [];
    }
    return [{ grantId: row.id, cause: 'left', otherId: row.owner_user_id, told: 'grantee_deleted' }];
  });
}

/** Step 2, after step 1 committed: the work each share allowed stops (endGrant), as stopGrant and leave run it. Never throws. */
export async function stopSharedWork(deps: Deps, shares: readonly EndedShare[]): Promise<void> {
  for (const share of shares) {
    try {
      await endGrant(deps, share.grantId, { cause: share.cause });
    } catch (error) {
      deps.log.error(`[sharing] stopping the work of a share of a deleted account failed (${share.grantId})`, error);
    }
  }
}

/**
 * Step 3, on `t` (the delete's own transaction, before the account's row goes): every grant that names the account
 * (either side, any state) and every invite to `email` it declined; the notifications of other people that name the
 * account or link to its profile are deleted, then the declined invites. Answers how many rows went.
 */
export async function forgetSharesOfAccount(deps: Deps, t: DbQueries, userId: string, email: string): Promise<number> {
  const grants = await t.all<{ id: string }>(
    `SELECT id FROM profile_grants
      WHERE owner_user_id = @user OR grantee_user_id = @user
         OR (grantee_user_id IS NULL AND state = 'declined' AND grantee_email = @email)
      ORDER BY id`,
    { user: userId, email },
  );
  // A notification names the account by its words ({name}: its name or address) or by its profile: the dedupe key and
  // the link hold the grant's key, a Prepare's the profile owner's id. The keys and ids are random, so a match is
  // never a false one.
  const marks = [userId, ...grants.map((row) => row.id)];
  const notes = await t.run(
    `DELETE FROM notifications n
      WHERE n.user_id <> @user
        AND EXISTS (SELECT 1 FROM unnest(CAST(@marks AS text[])) AS m(mark)
                     WHERE strpos(coalesce(n.dedupe_key, ''), m.mark) > 0 OR strpos(coalesce(n.link, ''), m.mark) > 0)`,
    { user: userId, marks: sqlTextArray(marks) },
  );
  const declined = await t.run(
    `DELETE FROM profile_grants WHERE grantee_user_id IS NULL AND state = 'declined' AND grantee_email = @email`,
    { email },
  );
  return notes.changes + declined.changes;
}

/** The words each other side reads, by who deleted the account (the request's `via`). */
const WORDS = {
  owner_deleted: {
    title: 'MSG_NOTIFY_SHARED_PROFILE_DELETED_TITLE',
    self: 'MSG_NOTIFY_SHARED_PROFILE_DELETED_BODY',
    admin: 'MSG_NOTIFY_SHARED_PROFILE_DELETED_ADMIN_BODY',
  },
  grantee_deleted: {
    title: 'MSG_NOTIFY_SHARE_GRANTEE_DELETED_TITLE',
    self: 'MSG_NOTIFY_SHARE_GRANTEE_DELETED_BODY',
    admin: 'MSG_NOTIFY_SHARE_GRANTEE_DELETED_ADMIN_BODY',
  },
} as const;

/**
 * Step 4, in the delete's transaction (after step 3): each other side is told a share ended, naming nobody, in the
 * words of who deleted the account. Answers how many were told. Never throws (notify's insert is in a savepoint).
 */
export async function tellOtherSides(deps: Deps, shares: readonly EndedShare[], via: 'self' | 'admin'): Promise<number> {
  let told = 0;
  for (const share of shares) {
    const words = WORDS[share.told];
    const outcome = await notify(deps, share.otherId, {
      kind: 'sharing_ended',
      title: words.title,
      body: [words[via]],
      link: SHARING_SETTINGS_PATH,
      dedupeKey: `sharing_ended:${share.grantId}`,
    });
    if (outcome === 'written') told += 1;
  }
  return told;
}
