import { z } from 'zod';
import { AUTOFILL_LOOKUP_URL_MAX, AutofillJobCreditSchema } from './lookup';

// The person's tracker from the extension (version 3): the jobs it can fill a form for when the page is not the one
// TailorIT matched (the side panel's "Autofill for another job"), and marking a job Applied once its form was sent
// (POST /api/autofill/applied, after the panel's "Submit application", the person's own submit or the auto-apply
// agent's). The page's address travels in the body only, as the lookup's does; TailorIT never stores, logs or echoes
// it.

/** The most jobs GET /api/autofill/jobs/search answers. */
export const AUTOFILL_JOB_SEARCH_MAX = 10;
/** The longest search text. */
export const AUTOFILL_JOB_SEARCH_QUERY_MAX = 200;

/**
 * GET /api/autofill/jobs/search?q= (scope jobs:lookup): the account's tracked jobs (tracker entries of a TailorIT job,
 * archived ones included) whose title or company holds every word of `q`, in any case, most recently updated first;
 * with `q` blank or absent, the most recently updated. At most AUTOFILL_JOB_SEARCH_MAX.
 */
export const AutofillJobSearchQuerySchema = z.object({
  q: z.string().max(AUTOFILL_JOB_SEARCH_QUERY_MAX).default(''),
});
export type AutofillJobSearchQuery = z.infer<typeof AutofillJobSearchQuerySchema>;

/** One job the person may fill this form for: its id is what the lookup's `jobId` takes. */
export const AutofillJobSearchItemSchema = z.object({
  jobId: z.number().int().positive(),
  title: z.string(),
  company: z.string(),
  /** Where it is, as the lookup writes it; '' when the posting does not say. */
  location: z.string(),
  /** Version 9 (v30 FIX-B, REQ-1): the source's credit line, as the lookup's job carries it; absent: none asked. */
  credit: AutofillJobCreditSchema.optional(),
});
export type AutofillJobSearchItem = z.infer<typeof AutofillJobSearchItemSchema>;

export const AutofillJobSearchResponseSchema = z.object({
  items: z.array(AutofillJobSearchItemSchema).max(AUTOFILL_JOB_SEARCH_MAX),
});
export type AutofillJobSearchResponse = z.infer<typeof AutofillJobSearchResponseSchema>;

/**
 * POST /api/autofill/applied (scope tracker:write): this application was sent. The job is `jobId` (any job TailorIT
 * has: the lookup's, a search's, the agent's), else the one the lookup finds at `url`, else, for a posting
 * POST /api/autofill/jobs can add, the one added now as that route adds it. Its tracker entry is then made or restored
 * as Add job's Save makes it (TailorIT's best resume linked) and moved to Applied, today; one already at Applied or
 * further keeps its status, so asking twice changes nothing. With neither a job nor an entry the person added by hand
 * for the posting's link, 404 `not_found`. The answer is the lookup's for the same address, job and `resumeId`, as it
 * stands now. One of `url` and `jobId` is required.
 */
export const AutofillAppliedRequestSchema = z
  .object({
    url: z.string().min(1).max(AUTOFILL_LOOKUP_URL_MAX).optional(),
    jobId: z.number().int().positive().optional(),
    /** The resume the person chose (the lookup's), for the answer only. */
    resumeId: z.string().min(1).max(64).optional(),
  })
  .superRefine((request, ctx) => {
    if (request.url === undefined && request.jobId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'Name the page or the job' });
    }
  });
export type AutofillAppliedRequest = z.infer<typeof AutofillAppliedRequestSchema>;

/**
 * What POST /api/autofill/applied refuses with, besides every token route's refusals (401, 403, 409 `conflict` for
 * another API version, 429), and the status of each: `validation_failed` (neither an address nor a job, or one over
 * its cap), `not_found` (no such job, and no job or hand-added entry at the address; or a posting its board no longer
 * has), and, when the job had to be added first, POST /api/autofill/jobs's `unsupported` (a posting it will not read:
 * one off its board's public list, a site whose robots.txt keeps it out), `ats_failed`, `ats_unavailable` and
 * `internal`.
 */
export const AUTOFILL_APPLIED_REFUSALS = {
  validation_failed: 400,
  unsupported: 400,
  not_found: 404,
  ats_failed: 502,
  ats_unavailable: 503,
  internal: 500,
} as const;
