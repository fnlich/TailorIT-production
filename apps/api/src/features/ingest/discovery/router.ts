import { AdminCandidatesAddBodySchema, AdminCandidatesBulkBodySchema, AdminCandidatesQuerySchema } from '@tailorit/shared';
import type { Router } from 'express';
import { adminRouter } from '../../../core/admin/index';
import type { AppDeps } from '../../../core/context';
import { parseInput } from '../../../core/http/validate';
import { addCandidates, adminCandidate, bulkCandidates, listCandidates } from './admin';
import { kindMeasures } from './measures';

// v30 S2: Admin › Candidates' routes, administrators only (adminRouter), mounted at /api/admin/candidates:
//   GET  /            the candidates (CT's AdminCandidatesQuery: q, kind, status, discoveredVia, cursor, limit) and
//                     the funnel: AdminCandidatesListSchema
//   POST /bulk        retry or drop up to ADMIN_BULK_MAX: AdminCandidatesBulkResultSchema
//   POST /            an admin's boards (addresses or names): AdminCandidatesAddResultSchema
//   GET  /measures    the measures by board kind: DiscoveryMeasuresSchema
//   GET  /:id         one candidate: JobSourceCandidateSchema

export function createCandidatesRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'candidate',
    list: { query: AdminCandidatesQuerySchema, run: (_deps, query) => listCandidates(deps, query) },
    bulk: { body: AdminCandidatesBulkBodySchema, run: (_deps, body) => bulkCandidates(deps, body) },
    get: (_deps, id) => adminCandidate(deps, id),
    routes(router, { handle, audit }) {
      router.post(
        '/',
        handle(async (req, actor) => {
          const body = parseInput(AdminCandidatesAddBodySchema, req.body ?? {}, 'boards');
          const added = await addCandidates(deps, body);
          if (added.ids.length > 0) await audit({ action: 'add', ids: added.ids, actor, change: { entries: body.entries.length, kind: body.kind } });
          return added.body;
        }),
      );
      router.get(
        '/measures',
        handle(async () => ({ byKind: await kindMeasures(deps.db) })),
      );
    },
  });
}
