import type { Feature } from '../../core/feature';
import { recategorizeJobsStep } from './recategorize-pass';
import { ROLES_ACTING } from './acting'; // v33 SHARE-6
import { createRolesRouter } from './router';

// v33 ROLES (F3, F4): role families. The module map:
// - router.ts: GET /api/roles, the person's field (their default resume's);
// - job-family.ts: jobFamilyOf, a stored job's family (or a title's) through the shared resolver;
// - recategorize-pass.ts: the one-time re-categorization of the jobs stored before v3.3's categories (a daily step,
//   stamped with TITLE_RULES_VERSION, so it runs once; nothing on an empty database).
// A resume's field (GET/PUT /api/resumes/:id/role-family) and `profileFamilyOf` live with the resumes
// (features/resumes/role-family.ts); the families, the detection and the editor's words are shared
// (`@tailorit/shared/roles`).
export { profileFamilyOf, resumeFieldOf, type ProfileFamily } from '../resumes/role-family';
export { jobFamilyOf } from './job-family';

export const rolesFeature: Feature = {
  name: 'roles',
  routes: [{ path: '/api/roles', router: createRolesRouter, acting: ROLES_ACTING /* v33 SHARE-6 */ }],
  daily: [recategorizeJobsStep],
};
