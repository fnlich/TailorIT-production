import { z } from 'zod';
import { IsoDateTime } from '../core/list';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';
import { ProfileKeySchema } from '../sharing/profile';

// v33 SHARE-5 (PLAN F9 "Prepare and the queue"; SP v33 PLAN-sharing.md §6 "Jobs wait for A's OK"): the jobs someone A
// shares their profile with (B) prepared on it wait for A's OK before A's extension applies to them, unless A ticked
// "Apply without my OK" (`apply`) on that share. A's Auto-apply page groups them per share ("From Bob · 12 wait for your
// OK", Approve all, Remove); B, working on A's profile, sees each such row marked (QueuePaneItem.awaitingOwner, "Waiting
// for Ana's OK"). The extension (API 9) never sees a held row. Routes (session, the owner's own profile only: refused
// while a request names a shared profile, `never`):
//   GET  /api/auto-apply/held      → HeldList {groups}: one group per share with held rows, the oldest first
//   POST /api/auto-apply/approve   HeldDecisionBody {grantKey, ids?, through?} → HeldApproved {approved}: the share's
//                                  held rows (or those of `ids`) go into the queue; the extension takes them after A's
//                                  own rows
//   POST /api/auto-apply/reject    HeldDecisionBody {grantKey, ids?, through?} → HeldRemoved {removed}: they leave the queue
// `ids` omitted: every held row of that share queued at or before `through` (then REQUIRED: the group's `newestAt` as A
// saw it), so a job B prepares while A decides is never approved or removed unseen (400 without it). `through` with
// `ids`: only those of them queued at or before it. An id that is not a held row of that share is left out (the count
// says what changed). The SHARE-5 review (decision 1, 2026-11-20) added `newestAt` and `through`.

/** One share's jobs that wait for the owner's OK: who prepared them (name, email), how many, since when. */
export const HeldGroupSchema = z.object({
  /** The share (its profile key): what Approve all and Remove send back. */
  grantKey: ProfileKeySchema,
  /** The person who prepared them (their name; their email when they have none). */
  name: z.string(),
  email: z.string(),
  count: z.number().int().positive(),
  /** When the oldest of them was queued. */
  oldestAt: IsoDateTime,
  /** When the newest of them was queued: what Approve all and Remove send back as `through`. */
  newestAt: IsoDateTime,
});
export type HeldGroup = z.infer<typeof HeldGroupSchema>;

/** GET /api/auto-apply/held. */
export const HeldListSchema = z.object({ groups: z.array(HeldGroupSchema) });
export type HeldList = z.infer<typeof HeldListSchema>;

/** The most ids one approve or reject names: the queue's own ceiling (QUEUE_SIZE_MAX's bound). */
export const HELD_IDS_CEILING = PUBLIC_CONSTANT_SPECS.QUEUE_SIZE_MAX.max;

/**
 * POST /api/auto-apply/approve and /reject: the share, and optionally some of its held rows (queue row ids). Without
 * `ids`, `through` is required: only the held rows queued at or before it change (the group's `newestAt` as shown).
 */
export const HeldDecisionBodySchema = z
  .object({
    grantKey: ProfileKeySchema,
    ids: z.array(z.string().min(1).max(64)).min(1).max(HELD_IDS_CEILING).optional(),
    through: IsoDateTime.refine((value) => !Number.isNaN(Date.parse(value)), 'Send a date and time (ISO 8601).').optional(),
  })
  .strict()
  .refine((body) => body.ids !== undefined || body.through !== undefined, {
    message: 'Send the jobs (ids), or when the newest of them was queued (through).',
    path: ['through'],
  });
export type HeldDecisionBody = z.infer<typeof HeldDecisionBodySchema>;

/** POST /api/auto-apply/approve's answer: how many held rows went into the queue. */
export const HeldApprovedSchema = z.object({ approved: z.number().int().nonnegative() });
export type HeldApproved = z.infer<typeof HeldApprovedSchema>;

/** POST /api/auto-apply/reject's answer: how many held rows left the queue. */
export const HeldRemovedSchema = z.object({ removed: z.number().int().nonnegative() });
export type HeldRemoved = z.infer<typeof HeldRemovedSchema>;
