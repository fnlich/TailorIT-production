import { z } from 'zod';
import { AutofillSeedSchema } from '../autofill/profile';

// v3.2 FILL: "Fill from my resume" (Settings › Autofill › Profile) as the Settings page reads it. The autofill contract's
// AutofillSeed (packages/shared/src/autofill, copied byte for byte by the extension) stays as it is; these Settings-only
// shapes wrap it.

/**
 * GET /api/autofill/profile/seed and POST's 200: the contract's seed, and which of its filled paths came from the
 * account or the job preferences rather than from the resume (the sign-in email, the preferences' phone): the page never
 * offers to put one of those over an answer of the person's.
 */
export const ProfileSeedViewSchema = AutofillSeedSchema.extend({
  fromSettings: z.array(z.string()).default([]),
  /**
   * Why the AI did not read an uploaded file just now (POST only: AI off or unavailable, or the day's AI use spent), as
   * the refusal said it; null otherwise. The page may raise its plan or limit alert from it (E4).
   */
  unread: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
  /**
   * v32 FIX-API (REV-SECBEH SF-1): which of its filled paths came from the AI's reading of an uploaded file (kept only
   * where the file's text says it): the page marks each "AI read, check it" until it is edited.
   */
  fromAi: z.array(z.string()).default([]),
});
export type ProfileSeedView = z.infer<typeof ProfileSeedViewSchema>;

/**
 * POST /api/autofill/profile/seed: "Fill from my resume" on that resume (else the default, else the latest). A built
 * resume answers 200 with its seed. An uploaded file is read by the AI first, once (the reading is kept for the account
 * for 30 days): 202 { taskId } while it reads; the page follows the task (GET /api/ai/tasks/:id), then asks GET
 * /api/autofill/profile/seed, which answers from the reading. Without AI (off, or the day's AI use spent) an upload
 * answers 200 at once with what its text shows without AI (email, phone, links) and a note that says why.
 */
export const ProfileSeedBodySchema = z.object({ resumeId: z.string().min(1).max(64).optional() });
export type ProfileSeedBody = z.infer<typeof ProfileSeedBodySchema>;

/** POST's answer: the seed (200), or the AI reading's task (202). */
export const ProfileSeedStartSchema = z.union([ProfileSeedViewSchema, z.object({ taskId: z.string().min(1) })]);
export type ProfileSeedStart = z.infer<typeof ProfileSeedStartSchema>;
