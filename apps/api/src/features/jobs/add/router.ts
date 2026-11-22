import { Router } from 'express';
import { z } from 'zod';
import {
  AddJobBodySchema,
  AdminAddLinksBodySchema,
  JobIdParam,
  JOB_ADD_STATE_MESSAGE,
  JOB_VERIFY_REASON_MESSAGE,
  UnverifiedApproveBodySchema,
  type AddJobResult,
  type UnverifiedApproval,
  type UnverifiedLinkDetail,
} from '@tailorit/shared';
import { adminRouter, PositiveId } from '../../../core/admin/index';
import { actorOf, requireUser, userOf } from '../../../core/auth/guards'; // v33 SHARE-6: actorOf
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { notFound } from '../../../core/http/errors';
import { closeLink } from '../../../core/seams'; // v32 FIX-API (SB-4)
import { refuse } from '../../../core/http/refuse';
import { parseInput } from '../../../core/http/validate';
import { newInFlight, type InFlight } from '../../autofill/jobs'; // v34 FANOUT: InFlight
import { takeAddSlot } from './limits';
import { approveUnverifiedJob } from './approve'; // v32 ADMINAPP (E6)
import { addJobByLink, verifyJob, type AddJobByLinkOutcome } from './pipeline';
import { batchProgress, queueLinks } from './queue';
import { countUnverifiedLinks, listUnverifiedLinks, rejectLink } from './verification';
import { unverifiedLinkDetail } from './versions'; // v32 FIX-API (SB-1)

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
//   POST /api/admin/jobs/unverified/:jobId/approve v32 ADMINAPP (E6): the job published as it was captured, marked
//                                                approved by the admin (approve.ts; ADMIN_APPROVALS_PER_HOUR each);
//                                                v32 FIX-API (SB-1): {version}, the version the admin read
//   GET  /api/admin/jobs/unverified/:jobId       v32 FIX-API (SB-1): the row's link and every version of its job in
//                                                full (versions.ts), what an approval publishes

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

// v34 FANOUT (the FANOUT review, spec 16): one set of reads under way per app, shared with Add job to profiles
// (POST /api/profiles/jobs/add), so one link added through both at once is read once.
const IN_FLIGHT = new WeakMap<object, InFlight>();

/** The app's adds by link under way (made once per deps). */
export function addInFlightOf(deps: object): InFlight {
  let set = IN_FLIGHT.get(deps);
  if (!set) {
    set = newInFlight();
    IN_FLIGHT.set(deps, set);
  }
  return set;
}

/** Mounted at /api/jobs (beside the jobs router, whose routes never take these paths). */
export function createJobLinksRouter(deps: AppDeps): Router {
  const router = Router();
  const inFlight = addInFlightOf(deps); // v34 FANOUT
  router.use(requireUser);

  // v33 SHARE-6 (PLAN-sharing §4 "Explicit changes"; SHARE-3's exact edit 5): on a shared profile the job and its entry
  // are the owner's (userOf), the add is one of the actor's own an hour (actorOf), and the link's later notices go to
  // the actor (addJobByLink's `actor`).
  router.post('/add', async (req, res) => {
    const user = userOf(req);
    const body = parseInput(AddJobBodySchema, req.body, 'job');
    takeAddSlot(deps, actorOf(req).id);
    const outcome = await addJobByLink(deps, {
      url: body.url,
      userId: user.id,
      origin: 'web',
      details: body.details ?? null,
      save: true,
      inFlight,
      ...(req.acting ? { actor: { id: actorOf(req).id, grantId: req.acting.grantId } } : {}), // v33 SHARE-6
    });
    res.status(outcome.created ? 201 : 200).json(addJobResultOf(deps, outcome));
  });

  router.post('/:id/verify', async (req, res) => {
    const user = userOf(req);
    const id = JobIdParam.safeParse(req.params.id);
    if (!id.success) throw notFound('That job');
    takeAddSlot(deps, actorOf(req).id); // v33 SHARE-6: the actor's hour
    // v33 SHARE-6: the job is the profile's owner's to retry (userOf: role `user` on a shared profile, so no admin power);
    // the one who asked (actorOf) sees the answer, the link's adder hears it otherwise.
    const outcome = await verifyJob(deps, id.data, { id: user.id, admin: user.role === 'admin' }, actorOf(req).id);
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
      // v32 FIX-API (SB-1): what an approval of the row publishes, every version in full.
      router.get(
        '/unverified/:jobId',
        handle(async (req, admin): Promise<UnverifiedLinkDetail> => {
          const id = PositiveId.safeParse(req.params.jobId);
          const detail = id.success ? await unverifiedLinkDetail(deps, id.data, admin) : null;
          if (!detail) throw notFound('That job');
          return detail;
        }),
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
          const at = deps.now().toISOString();
          // v32 FIX-API (SB-4): a job an admin published of the link (its approval ran out) closes with the Reject.
          const noted = await rejectLink(deps, row.url, admin.id, at, (t, jobId) => closeLink(deps, t, { jobId, reason: 'admin', at }));
          await audit({ action: 'reject', ids: [id.data], actor: admin, change: { jobs: noted } });
          return { rejected: true, jobs: noted };
        }),
      );
      // v32 ADMINAPP (E6): the job published as it was captured (approve.ts); the same answer again once approved.
      router.post(
        '/unverified/:jobId/approve',
        handle(async (req, admin): Promise<UnverifiedApproval> => {
          const id = PositiveId.safeParse(req.params.jobId);
          if (!id.success) throw notFound('That job');
          const body = parseInput(UnverifiedApproveBodySchema, req.body ?? {}, 'approval'); // v32 FIX-API (SB-1)
          const outcome = await approveUnverifiedJob(deps, id.data, admin, body);
          if (!outcome.already) {
            await audit({ action: 'approve', ids: [outcome.jobId], actor: admin, change: { jobId: id.data, adders: outcome.adders, at: outcome.approvedAt } });
          }
          return { approved: true, ...outcome };
        }),
      );
    },
  });
}
