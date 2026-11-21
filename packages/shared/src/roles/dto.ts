import { z } from 'zod';
import { ROLE_FAMILY_KEYS, type RoleFamilyId } from './families';

// v33 ROLES (F4): the contracts of the person's field. A resume's field (GET/PUT /api/resumes/:id/role-family) is the
// person's choice when there is one, else what TailorIT detected from the resume's reading; the person's field (GET
// /api/roles) is their default resume's.

/** A role family id on the wire: one of the 26 (a job category id is refused), read as a RoleFamilyId. */
export const RoleFamilyIdSchema = z.enum(ROLE_FAMILY_KEYS).transform((id) => id as RoleFamilyId);

/** Where a field comes from: the person chose it, TailorIT detected it, or there is no resume to read. */
export const ROLE_FIELD_SOURCES = ['chosen', 'detected', 'none'] as const;
export type RoleFieldSource = (typeof ROLE_FIELD_SOURCES)[number];

/** GET and PUT /api/resumes/:id/role-family: one resume's field. */
export const ResumeFieldSchema = z.object({
  resumeId: z.string(),
  /** The field in use: `chosen`, else `detected`. */
  familyId: RoleFamilyIdSchema,
  /** The person's choice; null is "Detect automatically". */
  chosen: RoleFamilyIdSchema.nullable(),
  /** What TailorIT read from the resume (general when it could not tell). */
  detected: RoleFamilyIdSchema,
});
export type ResumeField = z.infer<typeof ResumeFieldSchema>;

/** PUT /api/resumes/:id/role-family: the person's choice, or null to detect it again. */
export const SetResumeFieldBodySchema = z.object({ roleFamily: RoleFamilyIdSchema.nullable() }).strict();
export type SetResumeFieldBody = z.input<typeof SetResumeFieldBodySchema>;

/** The person's field: their default resume's (Settings › Account's "Your field", the Jobs page's My field). */
export const PersonFieldSchema = z.object({
  familyId: RoleFamilyIdSchema,
  source: z.enum(ROLE_FIELD_SOURCES),
  /** The resume it is read from (the default resume); null without one. */
  resumeId: z.string().nullable(),
});
export type PersonField = z.infer<typeof PersonFieldSchema>;

/** GET /api/roles. */
export const RolesResponseSchema = z.object({ field: PersonFieldSchema });
export type RolesResponse = z.infer<typeof RolesResponseSchema>;
