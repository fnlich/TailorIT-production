import { Router, type Request } from 'express';
import { AutofillFormsKnownRequestSchema, type ExtensionScope } from '@tailorit/shared/autofill';
import { userOf } from '../../../core/auth/guards';
import type { AppDeps } from '../../../core/context';
import { parseInput } from '../../../core/http/validate';
import { allow, perAccountLimit } from '../auth';
import { greenhouseReadsOf } from './greenhouse';
import { knownForm } from './service';
import { MINUTE_MS } from '@tailorit/shared';

// A job's known form (TailorIT v1.3), mounted at /api/autofill:
//   POST /forms/known  Settings or a token (jobs:lookup) AutofillFormsKnownRequest {url|jobId, employerUrl?, fields?}
//                      → AutofillFormsKnownResponse {jobId, questions, answers}: the questions TailorIT keeps for the
//                      job's form, and this account's earlier answers (with profile:read; a same-job answer to a
//                      self-identification, legal or pay question with profile:sensitive too)
// A POST, so the page's address stays out of the path and the query. As the lookup's, 60 a minute per account. The
// debug line names the account and counts; never the address, the job, a question or an answer.
// POST /submissions is jobs-router.ts's, beside /applied, whose limits and posting reads it shares.

/** Whether the caller may read what `scope` guards: the session always, a token when its connection holds it. */
function holds(req: Request, scope: ExtensionScope): boolean {
  return req.authVia !== 'token' || req.extensionToken?.scopes.includes(scope) === true;
}

export function createAutofillFormsRouter(deps: AppDeps): Router {
  const router = Router();
  const knownLimit = perAccountLimit('autofill-forms-known', 60, MINUTE_MS);

  router.post('/forms/known', allow('either', 'jobs:lookup'), knownLimit, async (req, res) => {
    const userId = userOf(req).id;
    const request = parseInput(AutofillFormsKnownRequestSchema, req.body ?? {}, 'request');
    const reach = { answers: holds(req, 'profile:read'), sensitive: holds(req, 'profile:sensitive') };
    const body = await knownForm(deps, userId, request, reach, greenhouseReadsOf(deps));
    const same = body.answers.filter((answer) => answer.match === 'sameJob').length;
    deps.log.debug(
      `[autofill] known form for account ${userId}: ${body.jobId === null ? 'no job' : 'a job'}, ` +
        `${body.questions.length} question(s), ${same} same-job and ${body.answers.length - same} other-job answer(s)`,
    );
    res.json(body);
  });

  return router;
}
