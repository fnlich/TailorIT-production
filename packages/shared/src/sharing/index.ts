import type { MessageKey } from '../constants/constants';
import type { ErrorCode } from '../core/errors';

// v33 SHARE-0: shared profiles (PLAN F9; SP v33 PLAN-sharing.md). A person (A, the owner) shares their profile with
// another account (B, the grantee): B sees and prepares A's data as A allowed, switches a tab to A's profile, sees
// every profile at once, and B's own AI works on it over MCP. B pays for every TailorIT AI use B starts there. Also
// `@tailorit/shared/sharing`.
//
// - ./permissions: the permission keys, the closure rules (isClosed, missingImplied), the grid's rows and presets.
// - ./profile: the profile key (ProfileKeySchema), the header, query and `as` names, linkAs, the canonical mailbox.
// - ./dto: the sharing routes' shapes and the acting profile of GET /api/account.
// The API's side: core/auth/grants.ts (the one live-grant predicate), core/auth/guards.ts (userOf, actorOf, payerOf,
// holds, rateKeyOf), core/accounts/payer.ts (the Payer brand), core/context.ts (req.acting, req.actingCandidate).

export * from './permissions';
export * from './profile';
export * from './dto';
// v33 SHARE-2: the invite's 202 and the overview (./views); the activity's areas, channels and shapes (./activity: the
// areas, channels and action form SHARE-0 defined here moved there, unchanged).
export * from './views';
export * from './activity';
// end v33 SHARE-2
// v34 FANOUT: one action on several profiles (./fanout: the targets, the per-profile answers, the PATCH bodies).
export * from './fanout';
// v36 APPLYAPI: Share All, a preview and a start (./share-all: SP v36 PLAN A3).
export * from './share-all';

/**
 * The refusals of a request that names a profile. `profile_ended`: the key is unknown, someone else's or not live
 * (one answer for the three, no name, no id; the web drops the key and reloads on the person's own profile).
 * `profile_not_shared`: live, but without the permission the route needs. `own_profile_only`: the route is never done
 * on a shared profile (account security, sharing itself, admin), or an extension token named a profile.
 */
export const SHARING_ERROR_CODES = ['profile_ended', 'profile_not_shared', 'own_profile_only'] as const satisfies readonly ErrorCode[];
export type SharingErrorCode = (typeof SHARING_ERROR_CODES)[number];
/** Each refusal's words. */
export const SHARING_ERROR_MESSAGES = {
  profile_ended: 'MSG_SHARING_PROFILE_ENDED',
  profile_not_shared: 'MSG_SHARING_NOT_SHARED',
  own_profile_only: 'MSG_SHARING_OWN_PROFILE_ONLY',
} as const satisfies Record<SharingErrorCode, MessageKey>;
/** A malformed key, a header and a query that disagree, or the query form where it is not taken: validation_failed. */
export const SHARING_BAD_PROFILE_MESSAGE = 'MSG_SHARING_BAD_PROFILE' as const satisfies MessageKey;

/** The sharing routes' refusals and answers (SHARE-2), by what happened. */
export const SHARING_MESSAGES = {
  /** SHARING_ENABLED is off. */
  off: 'MSG_SHARING_OFF',
  /** A's own address, or one whose canonical mailbox is A's. */
  ownEmail: 'MSG_SHARING_OWN_EMAIL',
  /** A pending or active grant of A to that address exists. */
  alreadyShared: 'MSG_SHARING_ALREADY_SHARED',
  /** SHARING_GRANTS_PER_OWNER ({max}). */
  grantsMax: 'MSG_SHARING_GRANTS_MAX',
  /** SHARING_PROFILES_PER_GRANTEE ({max}). */
  profilesMax: 'MSG_SHARING_PROFILES_MAX',
  /** SHARING_INVITES_PER_DAY ({max}). */
  invitesPerDay: 'MSG_SHARING_INVITES_PER_DAY',
  /** An invite that is not pending any more, expired, or not to the person's address. */
  inviteGone: 'MSG_SHARING_INVITE_GONE',
  /** The 202 of an invite, the same for every address ({email}). */
  inviteSent: 'MSG_SHARING_INVITE_SENT',
  // v33 SHARE-2
  /** An end date (new or changed) that is not after now. */
  endDatePast: 'MSG_SHARING_END_DATE_PAST',
  /** A share that is not the person's, or ended (A's change, A's stop, B's leave). */
  grantGone: 'MSG_SHARING_GRANT_GONE',
  /** An activity cursor that does not read. */
  activityStale: 'MSG_SHARING_ACTIVITY_STALE',
  // end v33 SHARE-2
} as const satisfies Record<string, MessageKey>;
