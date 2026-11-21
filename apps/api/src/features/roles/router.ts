import { Router } from 'express';
import type { RolesResponse } from '@tailorit/shared';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { profileFamilyOf } from '../resumes/role-family';

// v33 ROLES (F4): GET /api/roles, the person's field (their default resume's): Settings › Account's "Your field" and
// the Jobs page's My field chip. The families themselves are shared data (`@tailorit/shared/roles`).
export function createRolesRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', async (req, res) => {
    const field = await profileFamilyOf(deps, userOf(req).id);
    const body: RolesResponse = { field };
    res.json(body);
  });

  return router;
}
