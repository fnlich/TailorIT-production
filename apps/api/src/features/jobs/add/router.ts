import { Router } from 'express';
import { z } from 'zod';
import {
  AddJobBodySchema,
  AdminAddLinksBodySchema,
  JobIdParam,
  JOB_ADD_STATE_MESSAGE,
  JOB_VERIFY_REASON_MESSAGE,
  type AddJobResult,
} from '@tailorit/shared';
import { adminRouter, PositiveId } from '../../../core/admin/index';
import { requireUser, userOf } from '../../../core/auth/guards';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { notFound } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import { parseInput } from '../../../core/http/validate';
import { newInFlight } from '../../autofill/jobs';
import { takeAddSlot } from './limits';
import { addJobByLink, verifyJob, type AddJobByLinkOutcome } from './pipeline';
import { batchProgress, queueLinks } from './queue';
import { countUnverifiedLinks, listUnverifiedLinks, rejectLink } from './verification';

// v31 LINK: the add-by-link routes (docs/design/v3.1/21-jobs-from-links.md §7).
//   POST /api/jobs/add {url, details?}           the web's Add job (signed in; JOB_ADDS_PER_HOUR per account): the
//                                                pipeline's answer (AddJobResult); the job saved to the person's tracker
//   POST /api/jobs/:id/verify                    Retry read of a job only its adder sees (its adder or an admin; the
//                                                same hourly budget)
//   POST /api/admin/jobs/add {urls[]}            an admin's links, queued for TailorIT's own read (at most
//                                                ADMIN_ADD_LINKS_MAX): 202 QueuedLinks
//   GET  /api/admin/jobs/add/:batchId            a queued batch's progress
//   GET  /api/admin/jobs/unverified?cursor=      Admin › Review's "Couldn't verify" list (/count: how many links)
//   POST /api/admin/jobs/unverified/:jobId/retry Retry read (every adder's own job of the link gives way when read)
//   POST /api/admin/jobs/unverified/:jobId/reject the link is never published (each adder keeps their own job)

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/**
 * An outcome as the routes answer it: with its words (the state's, or why). `retry`: a Retry read's answer (a job still
 * unread is "only you", not "couldn't read" again).
 */
export function addJobResultOf(deps: Deps, outcome: AddJobByLinkOutcome, retry = false): AddJobResult {
  const key =
    outcome.state === 'private_unverified'
      ? outcome.needsDetails
        ? 'MSG_JOB_ADD_NEEDS_DETAILS'
        : retry
          ? 'MSG_JOB_ONLY_YOU_UNTIL_VERIFIED'
          : 'MSG_JOB_ADD_PRIVATE'
      : outcome.state === 'refused' && outcome.reason
        ? JOB_VERIFY_REASON_MESSAGE[outcome.reason]
        : JOB_ADD_STATE_MESSAGE[outcome.state];
  return { ...outcome, message: constantsOf(deps).message(key) };
}

/** Mounted at /api/jobs (beside the jobs router, whose routes never take these paths). */
export function createJobLinksRouter(deps: AppDeps): Router {
  const router = Router();
  const inFlight = newInFlight();
  router.use(requireUser);

  router.post('/add', async (req, res) => {
    const user = userOf(req);
    const body = parseInput(AddJobBodySchema, req.body, 'job');
    takeAddSlot(deps, user.id);
    const outcome = await addJobByLink(deps, {
      url: body.url,
      userId: user.id,
      origin: 'web',
      details: body.details ?? null,
      save: true,
      inFlight,
    });
    res.status(outcome.created ? 201 : 200).json(addJobResultOf(deps, outcome));
  });

  router.post('/:id/verify', async (req, res) => {
    const user = userOf(req);
    const id = JobIdParam.safeParse(req.params.id);
    if (!id.success) throw notFound('That job');
    takeAddSlot(deps, user.id);
    const outcome = await verifyJob(deps, id.data, { id: user.id, admin: user.role === 'admin' });
    res.json(addJobResultOf(deps, outcome, true));
  });

  return router;
}

const BatchId = z.string().trim().min(1).max(64);
const UnverifiedQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

/** Mounted at /api/admin/jobs. */
export function createAdminJobLinksRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'job link',
    routes(router, { handle, audit }) {
      router.post(
        '/add',
        handle(async (req, admin) => {
          const body = parseInput(AdminAddLinksBodySchema, req.body ?? {}, 'links');
          const max = constantsOf(deps).get('ADMIN_ADD_LINKS_MAX');
          if (body.urls.length > max) throw refuse(deps, 'validation_failed', 'MSG_JOB_ADD_TOO_MANY_LINKS', { max });
          const queued = await queueLinks(deps, { urls: body.urls, origin: 'admin', addedBy: admin.id });
          await audit({ action: 'add', ids: [queued.batchId], actor: admin, change: { links: body.urls.length, queued: queued.queued } });
          req.res!.status(202);
          return queued;
        }),
      );
      router.get(
        '/add/:batchId',
        handle(async (req) => {
          const batchId = BatchId.safeParse(req.params.batchId);
          const progress = batchId.success ? await batchProgress(deps, batchId.data) : null;
          if (!progress) throw notFound('That batch of links');
          return progress;
        }),
      );
      router.get(
        '/unverified',
        handle((req) => listUnverifiedLinks(deps, parseInput(UnverifiedQuery, req.query, 'query'))),
      );
      router.get(
        '/unverified/count',
        handle(() => countUnverifiedLinks(deps)),
      );
      router.post(
        '/unverified/:jobId/retry',
        handle(async (req, admin) => {
          const id = PositiveId.safeParse(req.params.jobId);
          if (!id.success) throw notFound('That job');
          const outcome = await verifyJob(deps, id.data, { id: admin.id, admin: true });
          await audit({ action: 'retry', ids: [id.data], actor: admin, change: { state: outcome.state } });
          return addJobResultOf(deps, outcome, true);
        }),
      );
      router.post(
        '/unverified/:jobId/reject',
        handle(async (req, admin) => {
          const id = PositiveId.safeParse(req.params.jobId);
          const row = id.success
            ? await deps.db.one<{ url: string }>('SELECT url FROM job_verifications WHERE job_id = ?', [id.data])
            : undefined;
          if (!id.success || !row) throw notFound('That job');
          const noted = await rejectLink(deps.db, row.url, admin.id, deps.now().toISOString());
          await audit({ action: 'reject', ids: [id.data], actor: admin, change: { jobs: noted } });
          return { rejected: true, jobs: noted };
        }),
      );
    },
  });
}
