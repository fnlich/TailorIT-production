import type { Router } from 'express';
import {
  AdminFlagBulkBodySchema,
  AdminFlagDecisionBodySchema,
  AdminFlagsQuerySchema,
  AdminReviewBulkBodySchema,
  AdminReviewDecisionBodySchema,
  AdminReviewsQuerySchema,
} from '@tailorit/shared';
import { adminRouter, PositiveId } from '../../core/admin/index';
import type { AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import { listReviews, reviewCounts, reviewDetail, reviewReporters } from './admin';
import { decideFlag, decideFlags, listFlags } from './flags';
import { decideReview, decideReviews } from './service';

// v30 X1-API: Admin › Review's API (docs/design/part2/14-extension-reports.md §6; administrators only, on adminRouter;
// the shapes are CT's @tailorit/shared/reviews). It replaces Admin › Reports' API (/api/admin/reports, which INT-3
// removes with its tab):
//   GET   /api/admin/reviews?lane=closed|new_job&state=&q=&cursor=&limit=  a lane's page, with every lane's count
//   GET   /api/admin/reviews/counts                                         the items needing a decision per lane
//   GET   /api/admin/reviews/:id                                            the detail sheet
//   GET   /api/admin/reviews/:id/reporters                                  the reporting accounts (on expand)
//   PATCH /api/admin/reviews/:id {decision: approve|reject|reopen, note?}   one decision; the sheet after it
//   POST  /api/admin/reviews/bulk {ids, decision: approve|reject, note?}    up to 100; a result per row
//   GET   /api/admin/flags?state=&q=&cursor=&limit=                         the Flags lane (job_reports)
//   PATCH /api/admin/flags/:id {status, closeJob?}                          a flag's decision
//   POST  /api/admin/flags/bulk {ids, status: resolved|dismissed}           up to 100
// The paths are the ones X1-WEB's Admin › Review calls (apps/web/.../settings/admin/review/api.ts REVIEW_ROUTES).

/** Mounted at /api/admin/flags. */
export function createReviewFlagsRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'flag',
    id: PositiveId,
    list: { query: AdminFlagsQuerySchema, run: (_deps, query) => listFlags(deps, query) },
    patch: { body: AdminFlagDecisionBodySchema, run: (_deps, id, change, admin) => decideFlag(deps, id, change, admin) },
    bulk: { body: AdminFlagBulkBodySchema, run: (_deps, bulk, admin) => decideFlags(deps, bulk, admin) },
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
      router.get(
        '/counts',
        helpers.handle(() => reviewCounts(deps.db)),
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
