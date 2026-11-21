import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Documents"; ROLES.md): the person's field is read off their default
// resume, so on a shared profile it is the owner's field, read with Documents' See (as the resumes' own Field routes:
// resumes/acting.ts RESUME_ROLE_FAMILY_ACTING).

/** /api/roles: GET /. */
export const ROLES_ACTING: ActingSpec = 'documents:view';
