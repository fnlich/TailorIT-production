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
import { HeldDecisionBodySchema, type HeldApproved, type HeldList, type HeldRemoved } from '@tailorit/shared/auto-apply';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { perAccountLimit } from '../autofill/auth';
import { approveHeld, heldGroups, rejectHeld } from '../autofill/agent/held'; // v33 SHARE-5
import { viewerOf } from '../prepare/kit'; // v33 SHARE-5
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
// v33 SHARE-5 (PLAN F9 "Prepare and the queue"; SP v33 PLAN-sharing.md §6; @tailorit/shared/auto-apply held.ts): the jobs
// someone the profile is shared with prepared wait for the owner's OK, per share (acting.ts: `never` while acting):
//   GET  /held                                                     → HeldList {groups} (one per share, oldest first)
//   POST /approve  HeldDecisionBody {grantKey, ids?, through?}     → HeldApproved {approved} (they go into the queue)
//   POST /reject   HeldDecisionBody {grantKey, ids?, through?}     → HeldRemoved {removed} (they leave the queue)
// Without ids, `through` (the group's newestAt as shown) is required: only rows queued at or before it change (400).
// The panes, on a shared profile (Prepare & queue's See): without the Sensitive answers permission an eligibility
// filter reason shows as one word; a held row says "Waiting for <owner>'s OK".

/** v33 SHARE-5: the owner's approve and reject presses, per account per minute. */
export const HELD_DECISIONS_PER_MINUTE = 30;

/** The page's reads of the two panes and the kit, per account per minute. */
export const AUTO_APPLY_READS_PER_MINUTE = 240;

export function createAutoApplyRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const readLimit = perAccountLimit('auto-apply-read', AUTO_APPLY_READS_PER_MINUTE, MINUTE_MS);
  const decisionLimit = perAccountLimit('auto-apply-held', HELD_DECISIONS_PER_MINUTE, MINUTE_MS); // v33 SHARE-5

  router.get('/saved', readLimit, async (req, res) => {
    const query = parseInput(SavedJobListQuerySchema, req.query ?? {}, 'query');
    const body: SavedJobList = await savedJobs(deps, userOf(req).id, query, viewerOf(req)); // v33 SHARE-5
    res.json(body);
  });

  router.get('/queue', readLimit, async (req, res) => {
    const query = parseInput(QueuePaneQuerySchema, req.query ?? {}, 'query');
    // v33 SHARE-5: on a shared profile, held rows name the owner ("Waiting for Ana's OK").
    const owner = req.acting?.owner;
    const reader = { viewer: viewerOf(req), ...(owner ? { ownerName: owner.name.trim() || owner.email } : {}) };
    const body: QueuePane = await queuePane(deps, userOf(req).id, query, reader);
    res.json(body);
  });

  router.get('/items/:queueId/kit', readLimit, async (req, res) => {
    const queueId = parseInput(AutofillAgentIdSchema, req.params.queueId, 'auto-apply job id');
    const body: PreparedKit = await preparedKit(deps, userOf(req).id, queueId);
    res.json(body);
  });

  // v33 SHARE-5: the owner's OK for the jobs someone they share their profile with prepared (never while acting).
  router.get('/held', readLimit, async (req, res) => {
    const body: HeldList = { groups: await heldGroups(deps, userOf(req).id) };
    res.json(body);
  });

  router.post('/approve', decisionLimit, async (req, res) => {
    const { grantKey, ids, through } = parseInput(HeldDecisionBodySchema, req.body ?? {}, 'approval');
    const body: HeldApproved = { approved: await approveHeld(deps, userOf(req).id, grantKey, { ids, through }) };
    res.json(body);
  });

  router.post('/reject', decisionLimit, async (req, res) => {
    const { grantKey, ids, through } = parseInput(HeldDecisionBodySchema, req.body ?? {}, 'removal');
    const body: HeldRemoved = { removed: await rejectHeld(deps, userOf(req).id, grantKey, { ids, through }) };
    res.json(body);
  });

  return router;
}
