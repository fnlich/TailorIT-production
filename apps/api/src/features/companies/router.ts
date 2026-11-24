import { Router, type Request } from 'express';
import { z } from 'zod';
import { CompanyJobsQuerySchema } from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import { constantsOf } from '../../core/constants/service'; // v36 IMPORTTIME
import { nowIso, type AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { postedRuleOf } from '../jobs/rows'; // v36 IMPORTTIME
import { companyVisibleTo } from '../jobs/visibility';
import { companyJobs, companyPage } from './page';
import { adminApprovalForAdminsOnly } from '../jobs/add/approval-view'; // v36 JOBS

// v30 ST3: the company checks moved here unchanged from store.ts, so this router imports nothing of the jobs store.
// v3.0 D2-C: through the async client. v30 E0-API: moved from features/jobs/companies-router.ts into the companies
// feature, with the company page (/companies/:id: the profile, its open positions and closed history).

const CompanyIdParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function companyIdOf(req: Request): number {
  const parsed = CompanyIdParam.safeParse(req.params.id);
  if (!parsed.success) throw notFound('That company');
  return parsed.data;
}

/** A company the account may see: a shared one, or its own (made for one of its page jobs). */
export async function requireCompany(deps: Pick<AppDeps, 'db'>, companyId: number, userId: string): Promise<void> {
  const row = await deps.db.one(`SELECT id FROM companies WHERE id = ? AND ${companyVisibleTo('')}`, [companyId, userId]);
  if (!row) throw notFound('That company');
}

export async function setCompanyHidden(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, companyId: number, hidden: boolean): Promise<void> {
  if (hidden) {
    await deps.db.run(deps.db.dialect.insertOrIgnore('user_hidden_companies(user_id, company_id, created_at) VALUES (?, ?, ?)'), [
      userId,
      companyId,
      nowIso(deps),
    ]);
  } else {
    await deps.db.run('DELETE FROM user_hidden_companies WHERE user_id = ? AND company_id = ?', [userId, companyId]);
  }
}

/**
 * Mounted at /api/companies:
 *   GET    /:id        the company page (CompanyPage): a merged company answers its survivor
 *   GET    /:id/jobs   ?state=open|closed&cursor=: a page of its open positions or closed history (CompanyJobsResponse)
 *   POST   /:id/hide   "Hide jobs from {company}"; DELETE /:id/hide its undo
 */
export function createCompaniesRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  router.use(adminApprovalForAdminsOnly); // v36 JOBS (PLAN J7): "Approved by an admin" for admins only

  router.get('/:id', async (req, res) => {
    res.json(await companyPage(deps, companyIdOf(req), userOf(req).id));
  });

  router.get('/:id/jobs', async (req, res) => {
    const query = parseInput(CompanyJobsQuerySchema, req.query, 'query');
    res.json(await companyJobs(deps, companyIdOf(req), userOf(req).id, query, postedRuleOf(constantsOf(deps)))); // v36 IMPORTTIME
  });

  router.post('/:id/hide', async (req, res) => {
    const user = userOf(req);
    const companyId = companyIdOf(req);
    await requireCompany(deps, companyId, user.id);
    await setCompanyHidden(deps, user.id, companyId, true);
    res.json({ hidden: true });
  });

  router.delete('/:id/hide', async (req, res) => {
    const user = userOf(req);
    const companyId = companyIdOf(req);
    await requireCompany(deps, companyId, user.id);
    await setCompanyHidden(deps, user.id, companyId, false);
    res.json({ hidden: false });
  });

  return router;
}
