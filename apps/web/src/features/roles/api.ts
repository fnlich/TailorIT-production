import {
  GENERAL_FAMILY_ID,
  ResumeFieldSchema,
  RolesResponseSchema,
  type PersonField,
  type ResumeField,
  type RoleFamilyId,
} from '@tailorit/shared/roles';
import { ApiError, api } from '@/lib/api';

// v33 ROLES (F4): the person's field (GET /api/roles) and one resume's field (GET/PUT /api/resumes/:id/role-family).
// Read leniently, like the other answers: an answer outside the contract reads as "no field known".

export const MY_FIELD_QUERY_KEY = ['roles', 'field'] as const;
export const resumeFieldQueryKey = (resumeId: string) => ['roles', 'resume', resumeId] as const;

const NO_FIELD: PersonField = { familyId: GENERAL_FAMILY_ID, source: 'none', resumeId: null };

/** GET /api/roles: the person's field (their default resume's). */
export async function fetchMyField(signal?: AbortSignal): Promise<PersonField> {
  const parsed = RolesResponseSchema.safeParse(await api.get('/api/roles', { signal }));
  return parsed.success ? parsed.data.field : NO_FIELD;
}

/** GET /api/resumes/:id/role-family; null when the resume is not there (404) or the answer does not read. */
export async function fetchResumeField(resumeId: string, signal?: AbortSignal): Promise<ResumeField | null> {
  try {
    const parsed = ResumeFieldSchema.safeParse(await api.get(`/api/resumes/${encodeURIComponent(resumeId)}/role-family`, { signal }));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** PUT /api/resumes/:id/role-family: the person's choice, or null to detect it again. */
export async function saveResumeField(resumeId: string, roleFamily: RoleFamilyId | null): Promise<ResumeField> {
  return ResumeFieldSchema.parse(await api.put(`/api/resumes/${encodeURIComponent(resumeId)}/role-family`, { roleFamily }));
}
