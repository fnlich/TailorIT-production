import { Router, type Request } from 'express';
import { ResumeCopyBatchIdSchema } from '@tailorit/shared';
import { aiUnavailableError } from '../../../core/accounts/index';
import { payerOf, requireUser, userOf } from '../../../core/auth/guards'; // v33 SHARE-3: payerOf
import type { AppDeps } from '../../../core/context';
import { parseInput } from '../../../core/http/validate';
import { dismissCopies, listCopies, retryCopies, stopCopies } from './store';

// The Resumes tab's view of the copy line (GET /api/resumes/copies, polled while a copy waits or is being made) and
// the buttons of its notices: Stop the rest, Try again and Dismiss, each for one batch of the account's own (another
// account's batch id changes nothing). Each answers the view again.
// v33 SHARE-3 (PLAN F9 "Who pays"): on a profile shared with them, B's Try again makes B pay for those copies (the
// rows' payer), and the view's pause is the viewer's own AI usage (payerOf), never the profile owner's.

function batchOf(req: Request): string {
  return parseInput(ResumeCopyBatchIdSchema, req.params.batchId, 'batch id');
}

/** Mounted at /api/resumes/copies. */
export function createResumeCopiesRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  /** GET /api/resumes/copies → ResumeCopiesResponse. */
  router.get('/', async (req, res) => {
    res.json(await listCopies(deps, userOf(req).id, payerOf(req).id));
  });

  /**
   * Stop the rest: the batch's copies still waiting are stopped; one being made finishes. v33 SHARE-3 (review): B, on A's
   * profile, stops only the copies B pays for.
   */
  router.post('/:batchId/stop', async (req, res) => {
    const userId = userOf(req).id;
    const payer = payerOf(req);
    await stopCopies(deps, userId, batchOf(req), payer);
    res.json(await listCopies(deps, userId, payer.id));
  });

  /** Try again: the batch's stopped copies and those that may work now wait in line again (503 while AI is off). */
  router.post('/:batchId/retry', async (req, res) => {
    const userId = userOf(req).id;
    const batchId = batchOf(req);
    const line = deps.services.resumeCopies;
    // v2.0: MSG_AI_UNAVAILABLE, whatever the server's reason (a person is never told it).
    if (!line?.enabled) throw aiUnavailableError(deps);
    const payer = payerOf(req); // v33 SHARE-3: Try again sets who pays
    if ((await retryCopies(deps, userId, batchId, payer)) > 0) line.nudge();
    res.json(await listCopies(deps, userId, payer.id));
  });

  /** Dismiss: the batch's finished copies leave the view; the resumes made stay. */
  router.post('/:batchId/dismiss', async (req, res) => {
    const userId = userOf(req).id;
    await dismissCopies(deps, userId, batchOf(req));
    res.json(await listCopies(deps, userId, payerOf(req).id));
  });

  return router;
}
