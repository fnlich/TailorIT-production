import { Router } from 'express';
import {
  AutofillAddJobRequestSchema,
  AutofillAppliedRequestSchema,
  AutofillFromPageRequestSchema,
  AutofillJobSearchQuerySchema,
  AutofillSubmissionRequestSchema,
  type AutofillJobSearchResponse,
} from '@tailorit/shared/autofill';
import { userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { asyncHandler } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { allow, perAccountLimit } from './auth';
import { submitApplication } from './forms/service';
import { addFromPage, type FromPageVia } from './from-page';
import { addJob, newInFlight } from './jobs';
import { markApplied, searchJobs, type AppliedVia } from './tracker';
import { MINUTE_MS, HOUR_MS } from '@tailorit/shared';

// Adding the job an application page shows (work package AF, API version 2), finding another of the person's jobs and
// marking one Applied (version 3), mounted at /api/autofill:
//   POST /jobs         Settings or a token (jobs:add) {url, resumeId?} → AutofillAddJobResponse {created, lookup}
//   POST /jobs/from-page  Settings or a token (jobs:add) AutofillFromPageRequest {url, employerUrl?, title, company,
//                      location?, description, criteria?, resumeId?} → AutofillAddJobResponse: version 5, the job a
//                      page shows from the text the person sees there (from-page.ts), when no ATS API reads it
//   GET  /jobs/search  Settings or a token (jobs:lookup) ?q= → AutofillJobSearchResponse {items}: the account's
//                      tracked jobs, then TailorIT's other open jobs, for "Autofill for another job"
//   POST /applied      Settings or a token (tracker:write) {url?, jobId?, resumeId?} → AutofillLookupResponse: the
//                      job's tracker entry at Applied (the job added first when TailorIT lacks it and can read it, for
//                      the session or a token with jobs:add)
//   POST /submissions  Settings or a token (tracker:write) AutofillSubmissionRequest → AutofillSubmissionResponse:
//                      v1.3, /applied's move plus the form's questions and the person's answers (forms/), the job
//                      shared first; it shares /applied's limits (one count for the four) and its posting reads
// POSTs with the address in the body, as the lookup takes it, so it stays out of the path and the query. Add job reads
// at most one posting from its board (jobs.ts), hence the tight limits: 10 a minute and 60 an hour per account; Applied
// and adding from the page, which may read one too, share them (one count for the three). The debug lines name the
// account, the ATS ("no ATS" for a job found by its link), whether the job was new or how it was found, and the time;
// never the address, the board, the posting, the page's text, the job (its id leads back to the page) or the search's
// words. A refusal's sentence names the ATS only.

/** Searches per account per minute: the panel searches as the person types. */
export const JOB_SEARCHES_PER_MINUTE = 60;
/** Add job and Applied together, per account: a minute's and an hour's. */
export const BOARD_READS_PER_MINUTE = 10;
export const BOARD_READS_PER_HOUR = 60;

const FROM_PAGE_VIA: Record<FromPageVia, string> = {
  existing: 'already in TailorIT',
  ats: 'read from its ATS',
  page: "made from the page's text",
};

const VIA: Record<AppliedVia, string> = {
  job: 'the job named',
  address: 'the job at the address',
  added: 'the job added to TailorIT now',
  by_hand: 'an entry added by hand',
};

export function createAutofillJobsRouter(deps: AppDeps): Router {
  const router = Router();
  // One count for Add job, adding from the page and Applied: each may read a posting from its board.
  const minuteLimit = perAccountLimit('autofill-add-job', BOARD_READS_PER_MINUTE, MINUTE_MS);
  const hourLimit = perAccountLimit('autofill-add-job-hour', BOARD_READS_PER_HOUR, HOUR_MS);
  const searchLimit = perAccountLimit('autofill-job-search', JOB_SEARCHES_PER_MINUTE, MINUTE_MS);
  /** The postings (and Ashby listings) being read now: one read each at a time, whoever asked. */
  const inFlight = newInFlight();

  router.post(
    '/jobs',
    allow('either', 'jobs:add'),
    minuteLimit,
    hourLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillAddJobRequestSchema, req.body ?? {}, 'request');
      const started = performance.now();
      const { answer, kind } = await addJob(deps, userId, request, inFlight);
      const which = answer.created ? 'added to TailorIT' : 'already in TailorIT';
      deps.log.debug(
        `[autofill] add job for account ${userId}: ${kind ?? 'no ATS'}, ${which}, saved to the tracker, ` +
          `${Math.round(performance.now() - started)} ms`,
      );
      res.json(answer);
    }),
  );

  router.post(
    '/jobs/from-page',
    allow('either', 'jobs:add'),
    minuteLimit,
    hourLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillFromPageRequestSchema, req.body ?? {}, 'request');
      const started = performance.now();
      const { answer, kind, via } = await addFromPage(deps, userId, request, inFlight);
      deps.log.debug(
        `[autofill] add job from page for account ${userId}: ${kind ?? 'no ATS'}, ${FROM_PAGE_VIA[via]}, ` +
          `saved to the tracker, ${Math.round(performance.now() - started)} ms`,
      );
      res.json(answer);
    }),
  );

  router.get('/jobs/search', allow('either', 'jobs:lookup'), searchLimit, async (req, res) => {
    const userId = userOf(req).id;
    const { q } = parseInput(AutofillJobSearchQuerySchema, req.query, 'query');
    const body: AutofillJobSearchResponse = { items: await searchJobs(deps, userId, q) };
    deps.log.debug(`[autofill] job search for account ${userId}: ${body.items.length} job(s)`);
    res.json(body);
  });

  router.post(
    '/applied',
    allow('either', 'tracker:write'),
    minuteLimit,
    hourLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillAppliedRequestSchema, req.body ?? {}, 'request');
      const started = performance.now();
      // Adding a posting TailorIT lacks is Add job's: the session, or a token with jobs:add.
      const mayAdd = req.authVia !== 'token' || req.extensionToken?.scopes.includes('jobs:add') === true;
      const { answer, via, moved, kind } = await markApplied(deps, userId, request, inFlight, { mayAdd });
      deps.log.debug(
        `[autofill] applied for account ${userId}: ${kind ?? 'no ATS'}, ${VIA[via]}, ` +
          `${moved ? 'moved to Applied' : 'at Applied or further already'}, ${Math.round(performance.now() - started)} ms`,
      );
      res.json(answer);
    }),
  );

  // v1.3 A
  router.post(
    '/submissions',
    allow('either', 'tracker:write'),
    minuteLimit,
    hourLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillSubmissionRequestSchema, req.body ?? {}, 'request');
      const started = performance.now();
      const mayAdd = req.authVia !== 'token' || req.extensionToken?.scopes.includes('jobs:add') === true;
      const { body, via, moved, kind } = await submitApplication(deps, userId, request, inFlight, { mayAdd });
      // Counts only: never a question, an answer, the address or the job.
      const answers = body.answersKept === null ? 'answers not kept (setting off)' : `${body.answersKept} answer(s) kept`;
      deps.log.debug(
        `[autofill] submission for account ${userId}: ${kind ?? 'no ATS'}, ${VIA[via]}, job ${body.job}, ` +
          `${moved ? 'moved to Applied' : 'at Applied or further already'}, ${body.questionsAdded} new of ` +
          `${body.questionsKnown} question(s), ${answers}, ${Math.round(performance.now() - started)} ms`,
      );
      res.json(body);
    }),
  );
  // end v1.3 A

  return router;
}
