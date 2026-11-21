import { Router, type Request } from 'express';
import { SaveAllBodySchema, searchParamsToJobsQuery, HOUR_MS, type JobsQuery } from '@tailorit/shared';
import { rateKeyOf, requireUser, userOf } from '../../core/auth/guards'; // v33 SHARE-6: rateKeyOf
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { asyncHandler } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { createSaveAll } from './save-all';

// Save all (work package WP7), mounted at /api/jobs/save-all ahead of the jobs router, so the jobs router's /:id
// routes never see these paths. Both read the list's filters from the query string exactly as GET /api/jobs does
// (the list's own query string; a cursor is ignored). Every route needs a signed-in account; the POST also needs the
// app's Origin, like every mutating request (the app-wide check).
//   GET  /preview   { matched, saveable, willSave }: the numbers of the "Save N jobs?" confirm
//   POST /          body { occurredOn? }: saves up to SAVE_BATCH_MAX jobs (100), in the list's order (SaveAllResponse)
// One run per account at a time (409), and SAVE_ALL_RUNS_PER_HOUR runs per account per hour (429). v30 ST3: the
// limit is that constant (each run may create up to SAVE_BATCH_MAX applications), read on each request (INT-0), and
// its refusal MSG_SAVE_ALL_PER_HOUR.

/** The list's filters, read as GET /api/jobs reads them, without a cursor (Save all always starts at the top). */
function listQueryOf(req: Request): JobsQuery {
  return { ...searchParamsToJobsQuery(req.query as Record<string, unknown>), cursor: undefined };
}

export function createSaveAllRouter(deps: AppDeps): Router {
  const router = Router();
  const saveAll = createSaveAll(deps);
  // v30 INT-0: the limit is read on each request (and its refusal names it), so an admin's edit applies at once.
  const max = () => constantsOf(deps).get('SAVE_ALL_RUNS_PER_HOUR');
  const runLimit = keyedRateLimit({
    windowMs: HOUR_MS,
    limit: max,
    key: (req) => `save-all:${rateKeyOf(req, HOUR_MS)}`, // v33 SHARE-6: the actor's runs an hour, on any profile
    message: (retryAfterSeconds) =>
      constantsOf(deps).message('MSG_SAVE_ALL_PER_HOUR', { max: max(), minutes: Math.max(1, Math.ceil(retryAfterSeconds / 60)) }),
    // A run counts, finished or failed on our side; a refusal (a bad day, another run going, the limit) does not.
    counts: (_req, status) => status < 400 || status >= 500,
  });
  router.use(requireUser);

  router.get('/preview', async (req, res) => {
    res.json(await saveAll.preview(userOf(req).id, listQueryOf(req)));
  });

  router.post(
    '/',
    runLimit,
    asyncHandler(async (req, res) => {
      const user = userOf(req);
      const { occurredOn } = parseInput(SaveAllBodySchema, req.body ?? {}, 'request');
      res.json(await saveAll.run(user.id, listQueryOf(req), occurredOn));
    }),
  );

  return router;
}
