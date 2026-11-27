import type { Router } from 'express';
import {
  AdminFlagBulkBodySchema,
  AdminFlagDecisionBodySchema,
  AdminFlagsAllBodySchema, // v37 REVIEW
  AdminFlagsFilterSchema, // v37 REVIEW
  AdminFlagsQuerySchema,
  AdminReviewBulkBodySchema,
  AdminReviewDecisionBodySchema,
  AdminReviewsAllBodySchema,
  AdminReviewsAllFilterSchema,
  AdminReviewsQuerySchema,
} from '@tailorit/shared';
import { adminRouter, PositiveId } from '../../core/admin/index';
import type { AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import { listReviews, reviewCounts, reviewDetail, reviewReporters } from './admin';
import { countAllFlags, decideAllFlags, decideFlag, decideFlags, listFlags } from './flags'; // v37 REVIEW: the "all" pair
import { retryReviewRead } from './page-read'; // v32 ADMINAPP (E6)
import { countAllReviews, decideAllReviews, decideReview, decideReviews } from './service';
import { parseInput } from '../../core/http/validate'; // v35 ADMIN
import { addJobEditRoutes } from './edit/routes'; // v38 REVEDIT (SP v38 PLAN.md E1-E6)

// v30 X1-API: Admin › Review's API (docs/design/part2/14-extension-reports.md §6; administrators only, on adminRouter;
// the shapes are CT's @tailorit/shared/reviews). It replaces Admin › Reports' API (/api/admin/reports, which INT-3
// removes with its tab):
//   GET   /api/admin/reviews?lane=closed|new_job&state=&q=&cursor=&limit=  a lane's page, with every lane's count
//   GET   /api/admin/reviews/counts                                         the items needing a decision per lane
//   GET   /api/admin/reviews/:id                                            the detail sheet
//   GET   /api/admin/reviews/:id/reporters                                  the reporting accounts (on expand)
//   PATCH /api/admin/reviews/:id {decision: approve|reject|reopen, note?}   one decision; the sheet after it
//   POST  /api/admin/reviews/bulk {ids, decision: approve|reject, note?}    up to 100; a result per row
//   POST  /api/admin/reviews/:id/retry                                      v32 ADMINAPP (E6): a waiting new job read again
//   GET   /api/admin/reviews/all/count?lane=new_job&state=&q=&from=&importRunId=   v35 ADMIN: the pending ones the filter matches
//                                                                          (v35 FIX-STORE: and `upTo`, what was counted)
//   POST  /api/admin/reviews/all {decision, filter, note?, after?, upTo?}  v35 ADMIN: Approve all / Reject all (New jobs);
//                                                                          v35 FIX-STORE: nothing beyond the count's upTo
//   GET   /api/admin/flags?state=&q=&cursor=&limit=                         the Flags lane (job_reports)
//   PATCH /api/admin/flags/:id {status, closeJob?}                          a flag's decision
//   POST  /api/admin/flags/bulk {ids, status: resolved|dismissed}           up to 100
//   GET   /api/admin/flags/all/count?state=&q=                              v37 REVIEW (R3): the open flags the filter
//                                                                          matches, and `upTo` (what was counted)
//   POST  /api/admin/flags/all {status, filter, after?, upTo?}              v37 REVIEW (R3): Resolve all / Dismiss all
//   GET   /api/admin/reviews/jobs/:jobId                                    v38 REVEDIT (PLAN E1-E6): Edit job's editor;
//   PATCH /api/admin/reviews/jobs/:jobId; POST .../read; POST .../restore    its save, "Read this link", "Use the posting's
//                                                                          text again" (edit/routes.ts)
// v37 REVIEW (SP v37 PLAN.md R1-R3): every list is Waiting by default (pending, Checking too), 100 a page, with `total`,
// `decidable` and `unfiltered`; /reviews/all takes the Closed links lane as well as New jobs.
// The paths are the ones X1-WEB's Admin › Review calls (apps/web/.../settings/admin/review/api.ts REVIEW_ROUTES).

/** Mounted at /api/admin/flags. */
export function createReviewFlagsRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'flag',
    id: PositiveId,
    list: { query: AdminFlagsQuerySchema, run: (_deps, query) => listFlags(deps, query) },
    patch: { body: AdminFlagDecisionBodySchema, run: (_deps, id, change, admin) => decideFlag(deps, id, change, admin) },
    bulk: { body: AdminFlagBulkBodySchema, run: (_deps, bulk, admin) => decideFlags(deps, bulk, admin) },
    // v37 REVIEW (R3): Resolve all / Dismiss all of the lane's filter: the count for the confirm, then the decisions on
    // the server (flags.ts decideAllFlags), audited once with the filter and the flags decided, as the reviews' "all".
    routes: (router, helpers) => {
      router.get(
        '/all/count',
        helpers.handle((req) => countAllFlags(deps, parseInput(AdminFlagsFilterSchema, req.query, 'query'))),
      );
      router.post(
        '/all',
        helpers.handle(async (req, admin) => {
          const body = parseInput(AdminFlagsAllBodySchema, req.body ?? {}, 'change');
          const decided = await decideAllFlags(deps, body, admin);
          await helpers.audit({
            action: `${body.status}_all`,
            ids: ['all'],
            actor: admin,
            change: { filter: body.filter, after: body.after ?? 0, upTo: body.upTo ?? null, matched: decided.body.matched, decided: decided.ids.length },
          });
          return decided.body;
        }),
      );
    },
  });
}

/** Mounted at /api/admin/reviews. */
export function createReviewRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'review',
    id: PositiveId,
    list: { query: AdminReviewsQuerySchema, run: (_deps, query) => listReviews(deps, query) },
    get: (_deps, id) => reviewDetail(deps, id),
    patch: { body: AdminReviewDecisionBodySchema, run: (_deps, id, change, admin) => decideReview(deps, id, change, admin) },
    bulk: { body: AdminReviewBulkBodySchema, run: (_deps, bulk, admin) => decideReviews(deps, bulk, admin) },
    routes: (router, helpers) => {
      // v38 REVEDIT (PLAN E1-E6): Edit job on every lane (/jobs/:jobId, its read and its restore: edit/routes.ts).
      addJobEditRoutes(deps, router, helpers);
      router.get(
        '/counts',
        helpers.handle(() => reviewCounts(deps.db)),
      );
      // v35 ADMIN (PLAN H3): Approve all / Reject all of the New jobs lane's filter: the count for the confirm, then the
      // decisions on the server (service.ts decideAllReviews), audited once with the filter and the reviews decided.
      router.get(
        '/all/count',
        helpers.handle((req) => countAllReviews(deps, parseInput(AdminReviewsAllFilterSchema, req.query, 'query'))),
      );
      router.post(
        '/all',
        helpers.handle(async (req, admin) => {
          const body = parseInput(AdminReviewsAllBodySchema, req.body ?? {}, 'change');
          const decided = await decideAllReviews(deps, body, admin);
          await helpers.audit({
            action: `${body.decision}_all`,
            ids: ['all'],
            actor: admin,
            change: { filter: body.filter, after: body.after ?? 0, upTo: body.upTo ?? null, matched: decided.body.matched, decided: decided.ids.length },
          });
          return decided.body;
        }),
      );
      // v32 ADMINAPP (E6): Retry read of a new job waiting for approval (page-read.ts retryReviewRead).
      router.post(
        '/:id/retry',
        helpers.handle(async (req, admin) => {
          const id = PositiveId.safeParse(req.params.id);
          const read = id.success ? await retryReviewRead(deps, id.data) : undefined;
          if (!id.success || !read) throw notFound('That review');
          await helpers.audit({ action: 'retry', ids: [id.data], actor: admin, change: { state: read.state } });
          return read;
        }),
      );
      router.get(
        '/:id/reporters',
        helpers.handle(async (req) => {
          const id = PositiveId.safeParse(req.params.id);
          const found = id.success ? await reviewReporters(deps, id.data) : null;
          if (!found) throw notFound('That review');
          return found;
        }),
      );
    },
  });
}
