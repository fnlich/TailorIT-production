import { z } from 'zod';
import { IsoDateTime } from '../core/list';
import { RoleFamilyIdSchema } from '../roles/dto';
import { SHARE_PRESETS, SharePermissionSchema, SharePermissionsSchema } from './permissions';
import { ProfileKeySchema } from './profile';

// v33 SHARE-0 (PLAN F9; SP v33 PLAN-sharing.md §2, §8, §9): the shapes the sharing routes (SHARE-2) answer and take, and
// the acting profile GET /api/account names (SHARE-3). The web's switcher (SHARE-4) and Settings › Sharing (SHARE-7) read
// them. The overview's and the activity's shapes are SHARE-2's.
//   GET    /api/sharing/profiles          (self)  → SharedProfiles: the profiles shared with me, my invites
//   GET    /api/sharing/grants            (self)  → SharingGrants: the people I share my profile with
//   POST   /api/sharing/grants            (never) GrantCreateBody → 202 (the same for every address)
//   PATCH  /api/sharing/grants/:key       (never) GrantPatchBody → GrantView
//   POST   /api/sharing/grants/:key/stop  (never) GrantStopBody → 204 (A stops sharing or cancels an invite)
//   POST   /api/sharing/profiles/:key/accept | /decline | /leave  (never) → 204 (B)

/**
 * A grant's state. `pending`: invited, not answered (until invite_expires_at). `active`: accepted. Ended, never live
 * again: `declined` (B said no), `revoked` (A stopped sharing or cancelled the invite), `left` (B left), `expired` (the
 * invite or the access end date passed: the sweep writes it; the live check reads the date itself).
 */
export const GRANT_STATES = ['pending', 'active', 'declined', 'revoked', 'left', 'expired'] as const;
export type GrantState = (typeof GRANT_STATES)[number];
/** The states that hold an owner's place and an address (SHARING_GRANTS_PER_OWNER; one per owner and address). */
export const GRANT_OPEN_STATES = ['pending', 'active'] as const satisfies readonly GrantState[];
/** The states a grant never leaves. */
export const GRANT_ENDED_STATES = ['declined', 'revoked', 'left', 'expired'] as const satisfies readonly GrantState[];
export const isGrantEnded = (state: GrantState): boolean => (GRANT_ENDED_STATES as readonly string[]).includes(state);

/** POST /api/sharing/grants: A invites `email` with these boxes (closed), access ending at `accessEndsAt` (or never). */
export const GrantCreateBodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  permissions: SharePermissionsSchema,
  accessEndsAt: IsoDateTime.nullable().default(null),
});
export type GrantCreateBody = z.infer<typeof GrantCreateBodySchema>;
export type GrantCreateBodyInput = z.input<typeof GrantCreateBodySchema>;

/** PATCH /api/sharing/grants/:key: new boxes (closed) and/or a new end date (null: none); effective on B's next request. */
export const GrantPatchBodySchema = z
  .object({
    permissions: SharePermissionsSchema.optional(),
    accessEndsAt: IsoDateTime.nullable().optional(),
  })
  .refine((body) => body.permissions !== undefined || body.accessEndsAt !== undefined, 'Change the boxes or the end date');
export type GrantPatchBody = z.infer<typeof GrantPatchBodySchema>;
export type GrantPatchBodyInput = z.input<typeof GrantPatchBodySchema>;

/** POST /api/sharing/grants/:key/stop: "Also remove the jobs they queued that haven't started" (ticked by default). */
export const GrantStopBodySchema = z.object({ removeQueued: z.boolean().default(true) });
export type GrantStopBody = z.infer<typeof GrantStopBodySchema>;

/** One person A shares (or offered to share) their profile with, as A sees it in Settings › Sharing. */
export const GrantViewSchema = z.object({
  key: ProfileKeySchema,
  /** The address A invited (stored normalised). */
  email: z.string(),
  /** The grantee's name once they accepted; null before. */
  name: z.string().nullable(),
  state: z.enum(GRANT_STATES),
  permissions: z.array(SharePermissionSchema),
  preset: z.enum(SHARE_PRESETS),
  inviteExpiresAt: IsoDateTime,
  accessEndsAt: IsoDateTime.nullable(),
  removeQueued: z.boolean(),
  createdAt: IsoDateTime,
  acceptedAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
});
export type GrantView = z.infer<typeof GrantViewSchema>;

/** GET /api/sharing/grants. */
export const SharingGrantsSchema = z.object({ grants: z.array(GrantViewSchema) });
export type SharingGrants = z.infer<typeof SharingGrantsSchema>;

/** A live profile shared with the signed-in person (B): the switcher's row; `permissions` drive the web's can(). */
export const SharedProfileSchema = z.object({
  key: ProfileKeySchema,
  /** The owner's name ('' when they set none: show the email). */
  name: z.string(),
  email: z.string(),
  permissions: z.array(SharePermissionSchema),
  accessEndsAt: IsoDateTime.nullable(),
  acceptedAt: IsoDateTime,
});
export type SharedProfile = z.infer<typeof SharedProfileSchema>;

/** An invite waiting for the signed-in person's answer (pending, not expired, to their address). */
export const SharingInviteSchema = z.object({
  key: ProfileKeySchema,
  fromName: z.string(),
  fromEmail: z.string(),
  permissions: z.array(SharePermissionSchema),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
});
export type SharingInvite = z.infer<typeof SharingInviteSchema>;

/** GET /api/sharing/profiles: `enabled` false (SHARING_ENABLED off) lists nothing. */
export const SharedProfilesSchema = z.object({
  enabled: z.boolean(),
  profiles: z.array(SharedProfileSchema),
  invites: z.array(SharingInviteSchema),
});
export type SharedProfiles = z.infer<typeof SharedProfilesSchema>;

/**
 * GET /api/account's `profile` (AccountSummary.profile): the profile the request acts on, the person's own when it names
 * none. The web reads the profile's default resume and field here, never from the signed-in account (SHARE-4's scan).
 * `roleFamily` is the profile's field (ROLES's RoleFamilyId; null: detected from the default resume, none yet).
 */
export const ActingProfileSchema = z.object({
  name: z.string(),
  email: z.string(),
  defaultResumeId: z.string().nullable(),
  // v33 INT-A: one of ROLES's 26 role-family ids (a job category id is refused).
  roleFamily: RoleFamilyIdSchema.nullable(),
});
export type ActingProfile = z.infer<typeof ActingProfileSchema>;
