import { Router } from 'express';
import { AutofillLookupRequestSchema } from '@tailorit/shared/autofill';
import { userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { asyncHandler } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { aliasValueHash } from './alias-key';
import { allow, perAccountLimit } from './auth';
import { greenhouseReadsOf } from './forms/greenhouse';
import { formKnownAndRead } from './forms/service';
import { lookupPosting, readPage } from './lookup';
// v1.5 P
import { draftReadyFor } from '../prepare/known';
import { MINUTE_MS } from '@tailorit/shared';
// end v1.5 P

// The job behind an application page (work package AF), mounted at /api/autofill:
//   POST /lookup  Settings or a token (jobs:lookup) {url, includePostingText} → AutofillLookupResponse (v1.3: with
//                 `formKnown`; a shared Greenhouse job whose questions TailorIT lacks has them read from its board's public
//                 API after the answer, forms/greenhouse.ts: the one write a lookup leads to, and it records no account)
// A POST, so the page's address stays out of the path and the query, which the error handler logs on a 5xx. It is
// never logged here either: the debug line names the account, the ATS kind, whether a job and an application were
// found and how, the resume's reason and the time. Never which job or application: their ids lead back to the page,
// and the lookup is read-only so that nothing records which postings a person opens.

export function createAutofillLookupRouter(deps: AppDeps): Router {
  const router = Router();
  const lookupLimit = perAccountLimit('autofill-lookup', 60, MINUTE_MS);

  router.post(
    '/lookup',
    allow('either', 'jobs:lookup'),
    lookupLimit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const request = parseInput(AutofillLookupRequestSchema, req.body ?? {}, 'request');
      const started = performance.now();
      const answer = await lookupPosting(deps, userId, request);
      // v1.3 A: whether TailorIT keeps the job's form questions (the extension prefetches them), the lookup's one read
      // of the form; a shared Greenhouse job's questions are read from its board after this answer when it keeps none.
      const page = request.jobId === undefined ? readPage(request.url, request.employerUrl, aliasValueHash(deps)) : null;
      answer.formKnown = await formKnownAndRead(deps, greenhouseReadsOf(deps), answer.job?.id ?? null, page);
      // v1.5 P: whether the person's prepared draft for the job is ready (absent with no draft).
      const draftReady = await draftReadyFor(deps, userId, answer.job?.id ?? null);
      if (draftReady !== undefined) answer.draftReady = draftReady;
      // end v1.5 P
      const found = answer.job ? `a job (${answer.job.matchedBy})` : 'no job';
      const tracked = answer.application ? `an application (${answer.application.matchedBy})` : 'no application';
      deps.log.debug(
        `[autofill] lookup for account ${userId}: ${answer.ats?.kind ?? 'no ATS'}, ${found}, ${tracked}, resume ` +
          `${answer.suggestedResume?.reason ?? 'none'}, ${Math.round(performance.now() - started)} ms`,
      );
      res.json(answer);
    }),
  );

  return router;
}
