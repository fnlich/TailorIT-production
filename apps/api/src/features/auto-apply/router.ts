import { Router } from 'express';
import {
  QueuePaneQuerySchema,
  SavedJobListQuerySchema,
  MINUTE_MS,
  type PreparedKit,
  type QueuePane,
  type SavedJobList,
} from '@tailorit/shared';
import { AutofillAgentIdSchema } from '@tailorit/shared/autofill';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { perAccountLimit } from '../autofill/auth';
import { preparedKit } from './kit';
import { queuePane } from './queue-pane';
import { savedJobs } from './saved';

// v2.0: the Auto-apply page's read models (docs/design/v2.0/05-prepare-flow.md, "Read models for the web"), mounted at
// /api/auto-apply, the session only:
//   GET /saved?cursor=&limit=&filter=all|ready|filtered|queued   → SavedJobList (the Saved Jobs pane)
//   GET /queue?cursor=&limit=                                     → QueuePane (the Queue pane; `preparing` on the first
//                                                                   page only)
//   GET /items/:queueId/kit                                       → PreparedKit (the manual flow's copy-ready kit)
// The page polls the two panes every 3 s while anything is preparing or applying, so the reads have a per-account limit
// of their own, apart from the page's changes. Nothing here writes, but the Saved pane's recompute of stale filter
// verdicts (no AI) and the queue's 30-minute stale release, as GET /api/autofill/agent/queue does.

/** The page's reads of the two panes and the kit, per account per minute. */
export const AUTO_APPLY_READS_PER_MINUTE = 240;

export function createAutoApplyRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const readLimit = perAccountLimit('auto-apply-read', AUTO_APPLY_READS_PER_MINUTE, MINUTE_MS);

  router.get('/saved', readLimit, async (req, res) => {
    const query = parseInput(SavedJobListQuerySchema, req.query ?? {}, 'query');
    const body: SavedJobList = await savedJobs(deps, userOf(req).id, query);
    res.json(body);
  });

  router.get('/queue', readLimit, async (req, res) => {
    const query = parseInput(QueuePaneQuerySchema, req.query ?? {}, 'query');
    const body: QueuePane = await queuePane(deps, userOf(req).id, query);
    res.json(body);
  });

  router.get('/items/:queueId/kit', readLimit, async (req, res) => {
    const queueId = parseInput(AutofillAgentIdSchema, req.params.queueId, 'auto-apply job id');
    const body: PreparedKit = await preparedKit(deps, userOf(req).id, queueId);
    res.json(body);
  });

  return router;
}
