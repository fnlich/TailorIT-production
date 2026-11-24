import { z } from 'zod';
import { PUBLIC_CONSTANT_SPECS } from '../constants/public/specs';
import { IsoDate } from '../core/list';
import { FanoutLeftSchema, FanoutRefusedSchema, FanoutSaveJobsResultSchema, FanoutTargetsQuerySchema, FanoutTargetsSchema } from './fanout';
import { ProfileChoiceSchema } from './profile';

// v36 APPLYAPI (SP v36 PLAN A3; REQUEST.md "There will be `Share All` button with dropdown if have any granted user. if
// clicked, the saved jobs will be shared to the other user."): Share All, the Auto-apply page's button that shares every
// job in Saved on one profile (the source: every Saved tab, newest saved first) to the profiles the person may save to.
// A pair, as Prepare All's plan and start (BEH-8): the preview says, per target, what the share would do and names the
// source's entries it takes; the start shares exactly those entries (one no longer in the source's Saved is left out,
// counted `gone`), never an entry saved after the preview.
//
//   GET  /api/profiles/saved/share-all/preview?source=me|key&targets=all|me,key → FanoutShareAllPreviewAnswer
//   POST /api/profiles/saved/share-all  FanoutShareAllBody                     → FanoutShareAllAnswer
//
// Both are fan-out routes (acting `self`: the tab's X-TailorIT-Profile is ignored, `'me'` is always the signed-in
// person). Sharing is v3.4's Copy to (POST /api/profiles/applications/copy): the job alone, saved at Saved on each target
// (never the notes, the status history, the documents, the kit or the queue row; each target picks its own resume); a
// job the target had removed from Saved comes back ("back in Saved"); a job the target tracks at any other status is
// left alone. The source needs the Job Tracker's See there, each target its Change; a profile that may not be used
// (unknown, someone else's, ended, or without the box) answers MSG_FANOUT_PROFILE_UNUSABLE as every fan-out does, the
// source too (then nothing runs: `results` and `left` are empty). At most SHARE_ALL_MAX entries (Admin › Constants;
// past it the preview takes the newest and says how many are `over`); the start saves them on each target in chunks of
// SAVE_BATCH_MAX. No notification; each shared profile's activity counts the read (the source) and the write (each
// target that changed).

/** The most entries one Share All takes: SHARE_ALL_MAX's own bound (a technical ceiling; the server checks the constant). */
export const SHARE_ALL_CEILING = PUBLIC_CONSTANT_SPECS.SHARE_ALL_MAX.max;

const count = z.number().int().nonnegative();

/** One profile's result: `ok: true` with `fields`, or the fan-out's refusal. */
function shareAllResult<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion('ok', [
    z.object({ profile: ProfileChoiceSchema, name: z.string(), ok: z.literal(true), ...fields }),
    FanoutRefusedSchema,
  ]);
}

// The preview --------------------------------------------------------------------------------------------------------

/** GET /api/profiles/saved/share-all/preview?source=me|<key>&targets=all|me,<key>... */
export const FanoutShareAllPreviewQuerySchema = z.object({
  /** The profile whose Saved jobs are shared: the person's own (`me`) or a shared one (its key). */
  source: ProfileChoiceSchema,
  targets: FanoutTargetsQuerySchema,
});
export type FanoutShareAllPreviewQuery = z.infer<typeof FanoutShareAllPreviewQuerySchema>;

/** The source's Saved jobs, as the preview reads them. */
export const FanoutShareAllSourceSchema = shareAllResult({
  /** Its Saved entries with a job (every Saved tab). */
  saved: count,
  /** Those Share All takes: the newest saved, at most `max`. */
  taking: count,
  /** Those past `max`, left for another Share All (saved - taking). */
  over: count,
  /** SHARE_ALL_MAX now. */
  max: z.number().int().positive(),
});
export type FanoutShareAllSource = z.infer<typeof FanoutShareAllSourceSchema>;

/**
 * What the share would do on one target, for the jobs of the entries taken. Each job counts once, in one of: added (a
 * new Saved entry), backInSaved (removed from Saved there earlier: it comes back), alreadyThere (tracked there at Saved,
 * Applied or later: left as it is), notFound (a job that profile does not see: another person's own job, a job held for
 * review that only others track). The start answers the same four as Copy to's saved, restored, alreadyTracked and
 * notFound.
 */
export const FanoutShareAllPreviewResultSchema = shareAllResult({
  added: count,
  backInSaved: count,
  alreadyThere: count,
  notFound: count,
});
export type FanoutShareAllPreviewResult = z.infer<typeof FanoutShareAllPreviewResultSchema>;

export const FanoutShareAllPreviewAnswerSchema = z.object({
  source: FanoutShareAllSourceSchema,
  /** The source's entries the start shares (send them back as they are); [] when the source is refused or has none. */
  applicationIds: z.array(z.string()).max(SHARE_ALL_CEILING),
  /** Each target's numbers, the person's own first (as every fan-out). */
  results: z.array(FanoutShareAllPreviewResultSchema),
  /** For `targets=all`: the live shares left out because their boxes do not allow saving there. */
  left: z.array(FanoutLeftSchema),
});
export type FanoutShareAllPreviewAnswer = z.infer<typeof FanoutShareAllPreviewAnswerSchema>;

// The start ----------------------------------------------------------------------------------------------------------

/** POST /api/profiles/saved/share-all: the entries the preview named, shared from `source` to every target. */
export const FanoutShareAllBodySchema = z
  .object({
    source: ProfileChoiceSchema,
    targets: FanoutTargetsSchema,
    /** The preview's applicationIds (at most SHARE_ALL_MAX, else 400 MSG_SHARE_ALL_TOO_MANY). */
    applicationIds: z.array(z.string().min(1).max(64)).min(1).max(SHARE_ALL_CEILING),
    /** The browser's day (default today, UTC), as every save's. */
    occurredOn: IsoDate.optional(),
  })
  .strict();
export type FanoutShareAllBody = z.infer<typeof FanoutShareAllBodySchema>;

/** The source's read at the start: the entries asked, those still in its Saved (shared), their jobs, and the others. */
export const FanoutShareAllReadSchema = shareAllResult({
  asked: count,
  /** Entries still in the source's Saved with a job: their jobs are shared. */
  shared: count,
  /** The distinct jobs they name. */
  jobs: count,
  /** Entries no longer in the source's Saved (applied, removed, or not this profile's): left out. */
  gone: count,
});
export type FanoutShareAllRead = z.infer<typeof FanoutShareAllReadSchema>;

/**
 * The source's read, then each target's save of every job, as Copy to answers it (FanoutSavedFields: saved, restored,
 * alreadyTracked, notFound, notReached, items for Undo, pendingMatches, incomplete).
 */
export const FanoutShareAllAnswerSchema = z.object({
  source: FanoutShareAllReadSchema,
  results: z.array(FanoutSaveJobsResultSchema),
  left: z.array(FanoutLeftSchema),
});
export type FanoutShareAllAnswer = z.infer<typeof FanoutShareAllAnswerSchema>;
