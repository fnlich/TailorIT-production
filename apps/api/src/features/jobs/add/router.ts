import { Router } from 'express';
import { z } from 'zod';
import {
  AddJobBodySchema,
  AdminAddLinksBodySchema,
  JobIdParam,
  JOB_ADD_STATE_MESSAGE,
  JOB_VERIFY_REASON_MESSAGE,
  UnverifiedAllBodySchema,
  UnverifiedApproveBodySchema,
  UnverifiedBulkBodySchema,
  UnverifiedListQuerySchema,
  type AddJobResult,
  type UnverifiedApproval,
  type UnverifiedLinkDetail,
} from '@tailorit/shared';
import { isNeverReadLink } from '@tailorit/shared/sourcing'; // v38 FIX-APP (ux L3)
import { adminRouter, PositiveId } from '../../../core/admin/index';
import { actorOf, requireUser, userOf } from '../../../core/auth/guards'; // v33 SHARE-6: actorOf
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { notFound } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import { parseInput } from '../../../core/http/validate';
import { newInFlight, type InFlight } from '../../autofill/jobs'; // v34 FANOUT: InFlight
import { takeAddSlot } from './limits';
import { approveUnverifiedJob } from './approve'; // v32 ADMINAPP (E6)
import { addJobByLink, verifyJob, type AddJobByLinkOutcome } from './pipeline';
import { pauseMessage } from './verdict'; // v37 CLOSED (C3)
import { batchProgress } from './queue';
import { listUnverifiedLinks } from './verification';
import { addJobImportRoutes } from './import-router'; // v35 IMPORT
import { importLinkOf } from './import-rows'; // v35 IMPORT
import { pastedLinksSource, startImport } from './import-store'; // v35 IMPORT
import { allUnverified, bulkUnverified, countUnverifiedUpTo, rejectUnverifiedLink } from './unverified-bulk'; // v35 IMPORT; v35 FIX-STORE: countUnverifiedUpTo
import { rowTableOf } from '../../ingest/row-table'; // v35 IMPORT
import { parseImportRows, mappingOf } from './import-rows'; // v35 IMPORT
import { nowIso } from '../../../core/context'; // v35 IMPORT
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
  // v37 CLOSED (C3): a read while the site (every Workday site) paused TailorIT says when to try again; every other
  // answer is as before (no `pause` field in any answer).
  if (outcome.pause) {
    const { pause, ...rest } = outcome;
    return { ...rest, message: pauseMessage(deps, pause) };
  }
  // v37 FIX-REV (REVIEW361-ux M5): a Retry read that found the posting closed closed the person's own job (pipeline.ts
  // verifyJob, C5): it says so ("This posting has closed, so TailorIT marked the job closed."), not that nothing was added.
  const retryClosed = retry && outcome.state === 'refused' && outcome.reason === 'closed';
  // v38 FIX-APP (D1): a posting read that names no company asks for it. v38 FIX-APP (ux L3): a job of a site TailorIT
  // never reads is its adder's for good (no "until TailorIT can read it").
  const key = outcome.needsCompany
    ? 'MSG_JOB_ADD_NEEDS_COMPANY'
    : retryClosed
    ? 'MSG_JOB_RETRY_CLOSED'
    : outcome.state === 'private_unverified'
      ? outcome.needsDetails
        ? outcome.reason === 'terms'
          ? 'MSG_JOB_VERIFY_TERMS' // v37 FIX-37B (E8): the agreed words say it all (the web adds no second line)
          : 'MSG_JOB_ADD_NEEDS_DETAILS'
        : neverRead(outcome)
          ? 'MSG_JOB_ADD_NEVER_READ'
          : retry
          ? 'MSG_JOB_ONLY_YOU_UNTIL_VERIFIED'
          : 'MSG_JOB_ADD_PRIVATE'
      : outcome.state === 'refused' && outcome.reason
        ? JOB_VERIFY_REASON_MESSAGE[outcome.reason]
        : JOB_ADD_STATE_MESSAGE[outcome.state];
  return { ...outcome, message: constantsOf(deps).message(key) };
}

/**
 * v38 FIX-APP (REVIEW38-ux L3): an outcome on a site TailorIT never reads: a reason that is the platform's lasting answer
 * (a bot check on every page, the employer's own login), or a link on a platform it never reads (SuccessFactors' robots).
 */
function neverRead(outcome: Pick<AddJobByLinkOutcome, 'reason' | 'url'>): boolean {
  return outcome.reason === 'bot_check' || outcome.reason === 'needs_login' || (outcome.reason === 'robots' && isNeverReadLink(outcome.url));
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
      ...(body.company ? { company: body.company } : {}), // v38 FIX-APP (D1): the company step's
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

  // v35 IMPORT (SP v35 PLAN.md H1): a person's imports (a file, a Google Sheet): import-router.ts.
  addJobImportRoutes(deps, router);

  return router;
}

const BatchId = z.string().trim().min(1).max(64);

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
          // v35 IMPORT (H6): an admin's links are an import with a run on Runs (Pasted links), each link one row; the
          // answer keeps v3.1's shape (QueuedLinks), its batch the import's queued rows.
          const table = rowTableOf('paste', body.urls.map((url, index) => ({ row: index + 1, cells: [url] })), false);
          const rows = parseImportRows(table, mappingOf(table));
          const source = await deps.db.tx((t) => pastedLinksSource(t, nowIso(deps)), { label: 'import source' });
          const made = await startImport(deps, {
            kind: 'admin',
            way: 'paste',
            name: rows.length === 1 ? '1 pasted link' : `${rows.length.toLocaleString('en-US')} pasted links`,
            rows,
            actorId: admin.id,
            origin: 'admin',
            source,
          });
          const queued = {
            batchId: made.runId !== null ? `run:${made.runId}` : `import:${made.importId}`,
            queued: made.queued,
            alreadyQueued: 0,
            repeated: rows.filter((row) => row.result === 'repeated').length,
            refused: rows
              .filter((row) => row.result === 'failed')
              .slice(0, 100)
              .map((row) => {
                const link = importLinkOf(row.linkCell);
                return { url: (row.url ?? row.linkCell.split(/[?#]/)[0] ?? '').slice(0, 300), reason: 'reason' in link ? ('invalid_link' as const) : ('unreadable_host' as const) };
              }),
          };
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
      // v35 IMPORT (H3): the From filter (from, importId, runId) on the list and its count.
      router.get(
        '/unverified',
        handle((req) => listUnverifiedLinks(deps, parseInput(UnverifiedListQuerySchema, req.query, 'query'))),
      );
      // v35 FIX-STORE (S6): with `upTo`, what was counted (unverified-bulk.ts).
      router.get(
        '/unverified/count',
        handle((req) => countUnverifiedUpTo(deps, parseInput(UnverifiedListQuerySchema, req.query, 'query'))),
      );
      // v35 IMPORT (H3): Approve or Reject a selection, or every row the filter matches (unverified-bulk.ts).
      router.post(
        '/unverified/bulk',
        handle(async (req, admin) => {
          const body = parseInput(UnverifiedBulkBodySchema, req.body ?? {}, 'selection');
          const result = await bulkUnverified(deps, admin, body.action, body.jobIds);
          await audit({ action: `bulk_${body.action}`, ids: body.jobIds, actor: admin, change: { done: result.done, skipped: result.skipped } });
          return result;
        }),
      );
      router.post(
        '/unverified/all',
        handle(async (req, admin) => {
          const body = parseInput(UnverifiedAllBodySchema, req.body ?? {}, 'filter');
          const filter = { ...(body.from ? { from: body.from } : {}), ...(body.importId ? { importId: body.importId } : {}), ...(body.runId ? { runId: body.runId } : {}) };
          const result = await allUnverified(deps, admin, body.action, filter, body.upTo); // v35 FIX-STORE (S6): body.upTo
          await audit({ action: `all_${body.action}`, ids: [], actor: admin, change: { ...filter, upTo: body.upTo ?? null, done: result.done, skipped: result.skipped, left: result.left } });
          return result;
        }),
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
          // v32 FIX-API (SB-4): a job an admin published of the link (its approval ran out) closes with the Reject. v35 IMPORT:
          // and a held job an admin import made of it (unverified-bulk.ts rejectUnverifiedLink).
          const noted = await rejectUnverifiedLink(deps, row.url, admin.id);
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
