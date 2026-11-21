import { GENERAL_FAMILY_ID, personSideFamily, type RoleFamilyId } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { jobFamilyOf, profileFamilyOf } from '../roles/index';

// v33 PROMPTS (F5): the field a person-side AI task writes in (TailorIT's letters, the autofill drafts and answers):
// the person's, from the resume the task reads (its Field, else what TailorIT read from it; the default resume when
// none is named), else the job's when the person's is general (nothing known about them). Tailor resolves its two
// families itself (service.ts), as the MCP steps do (mcp/job.ts personFitOf).

/** The family a person-side task for `job` is written in, from the resume it reads (`resumeId`; null: the default). */
export async function writtenFamily(
  deps: AppDeps,
  userId: string,
  resumeId: string | null | undefined,
  job: { jobId?: number | null; title?: string | null },
): Promise<RoleFamilyId> {
  const person = (await profileFamilyOf(deps, userId, resumeId ?? null)).familyId;
  return person === GENERAL_FAMILY_ID ? personSideFamily(person, await jobFamilyOf(deps, job)) : person;
}
