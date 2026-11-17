import { Router } from 'express';
import { z } from 'zod';
import { AutofillClosedReportRequestSchema, type AutofillClosedReportResponse } from '@tailorit/shared/autofill';
import { userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { asyncHandler } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { fileClosedReport } from '../job-reviews/closed';
import { allow, perAccountLimit } from './auth';
import { MINUTE_MS } from '@tailorit/shared';

// v30 X1-API: autofill API 9's closed-link report (docs/design/part2/14-extension-reports.md §3.2, §5.1), mounted at
// /api/autofill:
//   POST /jobs/:jobId/closed  Settings or a token (jobs:add) AutofillClosedReportRequest {url, signal, marker?, via,
//                             seenAt} → AutofillClosedReportResponse {outcome: queued | closed | already_closed}
// Refusals (AUTOFILL_CLOSED_REFUSALS): validation_failed 400 (a body the contract refuses, or a job id that is none),
// not_found 404 (no such job this account may see), rate_limited 429 at the daily cap (EXT_REPORTS_PER_ACCOUNT_PER_DAY,
// MSG_EXT_REPORT_LIMIT's words in `message` and the next 12:00 AM PT in `resetAt`, which the extension waits for). The
// report itself is job-reviews/closed.ts's. The debug line names the outcome, the signal and how it was seen: never the
// job, the address or the account together.

/** Reports per account per minute: an anti-flood limit beside the daily cap (the extension sends one at a time). */
export const CLOSED_REPORTS_PER_MINUTE = 30;

const JobIdParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function createAutofillClosedRouter(deps: AppDeps): Router {
  const router = Router();
  const limit = perAccountLimit('autofill-closed-report', CLOSED_REPORTS_PER_MINUTE, MINUTE_MS);

  router.post(
    '/jobs/:jobId/closed',
    allow('either', 'jobs:add'),
    limit,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const jobId = parseInput(JobIdParam, req.params.jobId ?? '', 'job id');
      const request = parseInput(AutofillClosedReportRequestSchema, req.body ?? {}, 'request');
      const result = await fileClosedReport(deps, userId, jobId, {
        url: request.url,
        signal: request.signal,
        marker: request.marker ?? null,
        via: request.via,
        seenAt: request.seenAt,
      });
      deps.log.debug(`[autofill] closed report: ${result.outcome}, ${request.signal} seen by ${request.via}`);
      const body: AutofillClosedReportResponse = { outcome: result.outcome };
      res.json(body);
    }),
  );

  return router;
}
