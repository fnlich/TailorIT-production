import { z } from 'zod';
import { MATCH_STATES } from '../match/schemas';

// v31 FIX-JOBS: the Jobs feed measures every row against the person's resume (docs/design/v3.1/20-visual-identity.md
// §7, the tape meter). GET /api/jobs/matches?ids=1,2,3 answers the keyword match of each listed job in one request: the
// same numbers as the job's detail ("8 of 12 keywords", GET /api/jobs/:id/insights), read without starting an AI
// analysis or writing anything.

/** How many job ids one request may ask for (the list loads 21 at a time). */
export const JOB_ROW_MATCHES_MAX_IDS = 30;

/** One row's measure: the matched and total keywords, and the share in percent (0 when the posting names none). */
export const JobRowMatchSchema = z.object({
  /** The id the request asked for (a page job that gave way to its shared job answers under the asked id). */
  jobId: z.number().int().positive(),
  state: z.enum(MATCH_STATES),
  matchedCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  percentage: z.number().int().min(0).max(100),
});
export type JobRowMatch = z.infer<typeof JobRowMatchSchema>;

/** GET /api/jobs/matches: one item per job the viewer can see, in the order asked; unknown ids are left out. */
export const JobRowMatchesResponseSchema = z.object({ items: z.array(JobRowMatchSchema) });
export type JobRowMatchesResponse = z.infer<typeof JobRowMatchesResponseSchema>;

/**
 * The `ids` of GET /api/jobs/matches: comma-separated positive integers, each once, at most JOB_ROW_MATCHES_MAX_IDS.
 * Null when the value is missing, empty, too long or holds anything else.
 */
export function readRowMatchIds(value: unknown): number[] | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.split(',');
  if (parts.length > JOB_ROW_MATCHES_MAX_IDS) return null;
  const ids: number[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!/^\d{1,12}$/.test(text)) return null;
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
