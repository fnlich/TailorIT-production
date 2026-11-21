import {
  TECHNICAL_FAMILY_ID,
  asRoleFamilyId,
  detectProfileFamily,
  type ResumeAnalysisData,
  type RoleFamilyId,
} from '@tailorit/shared';
import { getSkillLibrary } from '../../../core/skills-vocabulary';

// v33 ROLES (F4): the field a resume's reading shows (shared roles/detect.ts), stored with the reading
// (resume_analyses.role_family) so the Resumes list never reads a whole document for it.

/** A skill that this many fields or more share says nothing about a person's field. */
const SHARED_SKILL_FAMILIES = 4;

/**
 * A skill's family for the detection's skill fallback, from skills.json v2's `families` (v33 SKILLS): the technical
 * library's skills are technical (as all of v3.2's were); another field's skill is its home family's when at most
 * SHARED_SKILL_FAMILIES - 1 fields name it ("Phlebotomy", "Copywriting"); a skill most fields share (Microsoft Excel,
 * First Aid) or none names is null. Pure; the library's lookup is built once.
 */
export function librarySkillFamily(skill: string): RoleFamilyId | null {
  const entry = getSkillLibrary().entryByKey.get(skill.trim().toLowerCase());
  if (!entry?.families) return null;
  if (entry.families.includes(TECHNICAL_FAMILY_ID)) return TECHNICAL_FAMILY_ID;
  return entry.families.length < SHARED_SKILL_FAMILIES ? (entry.families[0] ?? null) : null;
}

/** The field one reading shows: its roles (the headline first), its certifications and its skills. */
export function readingFamilyOf(data: Pick<ResumeAnalysisData, 'keywords' | 'hardSkills'>): RoleFamilyId {
  return detectProfileFamily(
    { roles: data.keywords.roles, certifications: data.keywords.certifications, hardSkills: data.hardSkills },
    { skillFamily: librarySkillFamily },
  );
}

/** A stored family (a column), or null when it names none of the families (a reading stored before v3.3). */
export function storedFamilyOf(value: string | null | undefined): RoleFamilyId | null {
  return asRoleFamilyId(value);
}
