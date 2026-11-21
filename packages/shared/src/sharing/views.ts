import { z } from 'zod';
import { IsoDateTime } from '../core/list';
import { GrantViewSchema } from './dto';
import { SharePermissionSchema } from './permissions';
import { ProfileChoiceSchema } from './profile';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §2, §8): the sharing routes' answers that SHARE-0's dto.ts left to
// SHARE-2 (the invite's 202, the overview; the activity's are in ./activity). Settings › Sharing and the Profiles page
// (SHARE-7) read them.
//   POST /api/sharing/grants        (never) GrantCreateBody → 202 GrantCreated (the same for every address)
//   GET  /api/sharing/overview      (self)                  → SharingOverview

/** The web page of Settings › Sharing: the sharing notifications' link, and "Copy link" (never carries a key). */
export const SHARING_SETTINGS_PATH = '/settings/sharing';
/** The web page that shows every profile at once (the overview). */
export const SHARING_PROFILES_PATH = '/profiles';

/**
 * POST /api/sharing/grants' 202: the saved invite as A's list shows it, and the sentence to show
 * (MSG_SHARING_INVITE_SENT). The answer is the same whether or not the address has an account (`grant.name` is null
 * until someone accepts), so an invite never tells A who uses TailorIT.
 */
export const GrantCreatedSchema = z.object({
  message: z.string(),
  grant: GrantViewSchema,
});
export type GrantCreated = z.infer<typeof GrantCreatedSchema>;

// The overview (GET /api/sharing/overview) ------------------------------------------------------------------------------

/**
 * One profile's card on the Profiles page: the person's own (`profile: 'me'`, first) and each live profile shared with
 * them that holds `prepare:view` (oldest accepted first).
 */
export const SharingOverviewProfileSchema = z.object({
  profile: ProfileChoiceSchema,
  /** The profile's person: the owner's name ('' when they set none: show the email), or the person's own. */
  name: z.string(),
  email: z.string(),
  /** The boxes the owner ticked; null on the person's own profile (everything). */
  permissions: z.array(SharePermissionSchema).nullable(),
  /** When the share ends by date (null: no end date, or the person's own profile). */
  accessEndsAt: IsoDateTime.nullable(),
  counts: z.object({
    /** Saved jobs on the board (not archived); null without `tracker:view`. */
    saved: z.number().int().nonnegative().nullable(),
    /** Jobs past Saved on the board (not archived); null without `tracker:view`. */
    applied: z.number().int().nonnegative().nullable(),
    /** Prepares waiting or running. */
    preparing: z.number().int().nonnegative(),
    /** Auto-apply queue rows ready or applying (not waiting for an OK). */
    queued: z.number().int().nonnegative(),
    /**
     * Prepared jobs waiting for an OK: on the person's own profile, the ones others prepared for them to approve; on a
     * shared profile, the ones this person prepared that wait for the owner's OK.
     */
    waitingForOk: z.number().int().nonnegative(),
    /** Auto-apply rows that need a person to finish them. */
    needsYou: z.number().int().nonnegative(),
  }),
  /** Something is preparing or applying (the page asks again sooner). */
  busy: z.boolean(),
});
export type SharingOverviewProfile = z.infer<typeof SharingOverviewProfileSchema>;

/** What an item of "Needs you" asks: finish an auto-apply run, or approve a job someone prepared on your profile. */
export const SHARING_OVERVIEW_ITEM_KINDS = ['needs_you', 'awaiting_ok'] as const;
export type SharingOverviewItemKind = (typeof SHARING_OVERVIEW_ITEM_KINDS)[number];

/** One item of the merged "Needs you" list (newest first; only profiles with `tracker:view`). */
export const SharingOverviewItemSchema = z.object({
  profile: ProfileChoiceSchema,
  kind: z.enum(SHARING_OVERVIEW_ITEM_KINDS),
  queueId: z.string(),
  applicationId: z.string().nullable(),
  jobId: z.number().int(),
  title: z.string(),
  company: z.string(),
  /** When it started waiting (the row's last change). */
  at: IsoDateTime,
});
export type SharingOverviewItem = z.infer<typeof SharingOverviewItemSchema>;

/** GET /api/sharing/overview: every profile at once (`self`: always the signed-in person's view). */
export const SharingOverviewSchema = z.object({
  /** SHARING_ENABLED: off, only the person's own profile is listed. */
  enabled: z.boolean(),
  profiles: z.array(SharingOverviewProfileSchema),
  /** At most 20, newest first. */
  needsYou: z.array(SharingOverviewItemSchema),
  /** Any profile is busy: the page polls every 10 s, else every 60 s. */
  busy: z.boolean(),
});
export type SharingOverview = z.infer<typeof SharingOverviewSchema>;
