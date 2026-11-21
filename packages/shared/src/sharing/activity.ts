import { z } from 'zod';
import { IsoDateTime } from '../core/list';
import { GRANT_STATES } from './dto';
import { ProfileKeySchema } from './profile';

// v33 SHARE-0, SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §10): the activity of a shared profile. What the grantee (B) did
// on the owner's (A's) profile, counted by the hour (profile_activity, migration 0048): every write, the first read of an
// area in an hour, B's own AI's calls, and the share's own events (invited, accepted, changed, ended ...). Ids and codes
// only, never a value; names are joined when shown. Both sides read it (B up to the share's end).
//   GET /api/sharing/activity (self) ?key&cursor&limit → SharingActivity
// (SHARE-0 named the areas, the channels and the action's form in ./index; SHARE-2 moved them here beside the shapes.)

/** What an activity row counts in: a permission row's area, or `sharing` (the grant's own events). */
export const SHARING_ACTIVITY_AREAS = [
  'tracker',
  'documents',
  'prepare',
  'queue',
  'apply',
  'autofill',
  'settings',
  'sensitive',
  'exports',
  'mcp',
  'sharing',
] as const;
export type SharingActivityArea = (typeof SHARING_ACTIVITY_AREAS)[number];
/** How the counted work came: the web app, B's own AI (MCP), A's extension (B paying), or the server (the sweep). */
export const SHARING_ACTIVITY_VIAS = ['web', 'mcp', 'extension', 'system'] as const;
export type SharingActivityVia = (typeof SHARING_ACTIVITY_VIAS)[number];
/** An activity row's action: a code (`read`, `write`, `accepted`, ...), never a value. */
export const SHARING_ACTIVITY_ACTION_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** GET /api/sharing/activity's query: one share (`key`) or all of the person's, a page of hours, newest first. */
export const SharingActivityQuerySchema = z.object({
  key: ProfileKeySchema.optional(),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type SharingActivityQuery = z.infer<typeof SharingActivityQuerySchema>;
export type SharingActivityQueryInput = z.input<typeof SharingActivityQuerySchema>;

/** A share the rows name: which side the reader is on, and the other person (names are joined when shown). */
export const SharingActivityGrantSchema = z.object({
  key: ProfileKeySchema,
  /** `owner`: the reader shares their profile (A); `grantee`: it is shared with the reader (B). */
  side: z.enum(['owner', 'grantee']),
  /** The other person's name: the grantee's (A's side; '' before they accepted) or the owner's (B's side). */
  name: z.string(),
  /** The other person's address: the address A invited (A's side) or the owner's (B's side). */
  email: z.string(),
  state: z.enum(GRANT_STATES),
});
export type SharingActivityGrant = z.infer<typeof SharingActivityGrantSchema>;

/** One hour's count of one kind of event on one share (ids and codes only, never a value). */
export const SharingActivityRowSchema = z.object({
  key: ProfileKeySchema,
  /** The hour (UTC) the events fell in. */
  hour: IsoDateTime,
  area: z.enum(SHARING_ACTIVITY_AREAS),
  /** A code: `read` (the first read of the area that hour), `write`, or a share's event (`invited`, `accepted`, ...). */
  action: z.string().regex(SHARING_ACTIVITY_ACTION_PATTERN),
  via: z.enum(SHARING_ACTIVITY_VIAS),
  /** Who did it: the share's owner (A) or its grantee (B). */
  by: z.enum(['owner', 'grantee']),
  events: z.number().int().positive(),
});
export type SharingActivityRow = z.infer<typeof SharingActivityRowSchema>;

/** GET /api/sharing/activity: both sides read it; the grantee's side stops at the share's end. */
export const SharingActivitySchema = z.object({
  /** The shares the rows name (each once). */
  grants: z.array(SharingActivityGrantSchema),
  rows: z.array(SharingActivityRowSchema),
  nextCursor: z.string().optional(),
});
export type SharingActivity = z.infer<typeof SharingActivitySchema>;
