import { categorizeTitle } from '../jobs/infer';
import { OTHER_CATEGORY_ID } from '../jobs/taxonomy';
import { GENERAL_FAMILY_ID, familyOfCategory, type RoleFamilyId, type RoleFamilyKey } from './families';

// v33 ROLES (F4): a person's field, found without AI. It reads what TailorIT read from their resume (the roles, the
// headline first, newest first; the skills and certifications) and is stored with that reading, so the Resumes list
// never reads a whole document for it. The person can always choose another (the resume's Field).

/** What the detection reads: a resume's reading. */
export interface ProfileFamilyInput {
  /** Roles held, the headline first when there is one, then the newest role first (a reading's keywords.roles). */
  roles: readonly string[];
  hardSkills?: readonly string[];
  certifications?: readonly string[];
}

export interface DetectProfileFamilyOptions {
  /**
   * A skill's family, for the skill fallback (the API passes its skill library's: a library skill is technical), asked
   * for the skills the built-in signature skills below do not know.
   */
  skillFamily?: (skill: string) => RoleFamilyId | null;
}

/**
 * The weight of each title by its place: the first 3 (the headline, or the newest role when the resume has none or its
 * headline is the newest role's title, which a reading keeps once), the next 2, the rest 1. v33 FIX-1: by place, never
 * assuming a headline (v3.3's [3, 3, 2] gave a resume with no headline its second-newest role the newest one's weight,
 * so two older roles in another field always outvoted the newest: a new nurse after two retail jobs read as retail).
 */
export const DETECTION_ROLE_WEIGHTS: readonly number[] = [3, 2];
/** The skill fallback names a family only with at least this many of its skills. */
export const DETECTION_MIN_SKILLS = 2;

/** Skills and licences that say a field on their own (general knowledge, lower case). Never a technology's. */
const SIGNATURE_SKILLS: Readonly<Partial<Record<RoleFamilyKey, readonly string[]>>> = {
  healthcare: [
    'patient care', 'vital signs', 'phlebotomy', 'bls', 'acls', 'pals', 'cpr', 'medication administration',
    'wound care', 'triage', 'iv therapy', 'medical terminology', 'icd-10', 'cpt coding', 'telemetry', 'charting',
    'patient assessment', 'infection control', 'registered nurse', 'rn', 'lpn', 'cna', 'nclex', 'hipaa',
  ],
  education: [
    'lesson planning', 'classroom management', 'curriculum development', 'differentiated instruction', 'iep',
    'common core', 'student assessment', 'early childhood education', 'google classroom', 'teaching license',
    'teaching certificate', 'tutoring', 'special education',
  ],
  'trades-facilities': [
    'osha', 'osha 10', 'osha 30', 'blueprint reading', 'electrical wiring', 'plumbing', 'welding', 'carpentry',
    'power tools', 'preventive maintenance', 'epa 608', 'journeyman license', 'hvac',
  ],
  'logistics-transportation': [
    'forklift', 'forklift operation', 'cdl', 'cdl class a', 'cdl-a', 'pallet jack', 'rf scanner', 'shipping and receiving',
    'order picking', 'dot regulations', 'route planning', 'hazmat endorsement',
  ],
  'hospitality-retail': [
    'point of sale', 'pos systems', 'cash handling', 'food safety', 'servsafe', 'food preparation', 'merchandising',
    'visual merchandising', 'upselling', 'mixology', 'knife skills', 'menu planning', 'food handler',
  ],
  administrative: [
    'calendar management', 'data entry', 'filing', 'typing', 'office administration', 'travel arrangements',
    'meeting coordination', 'records management', 'multi-line phones', 'expense reports', 'microsoft office',
  ],
  finance: [
    'quickbooks', 'gaap', 'accounts payable', 'accounts receivable', 'account reconciliation', 'general ledger',
    'financial reporting', 'month-end close', 'tax preparation', 'cpa',
  ],
  'customer-service': ['customer service', 'zendesk', 'call handling', 'complaint resolution', 'phone etiquette'],
  sales: ['prospecting', 'cold calling', 'lead generation', 'pipeline management', 'quota attainment', 'b2b sales'],
  marketing: ['social media marketing', 'email marketing', 'content marketing', 'google ads', 'campaign management', 'sem'],
  'people-hr': ['recruiting', 'onboarding', 'hris', 'benefits administration', 'employee relations', 'talent acquisition'],
  legal: ['legal research', 'westlaw', 'lexisnexis', 'contract review', 'litigation', 'e-discovery', 'legal writing'],
  manufacturing: ['gmp', 'lean manufacturing', 'six sigma', 'iso 9001', 'quality control', 'cnc', 'machine operation', 'kaizen', '5s'],
  'engineering-physical': ['autocad', 'solidworks', 'revit', 'gd&t', 'finite element analysis', 'catia', 'creo', 'civil 3d'],
  'science-research': ['pcr', 'cell culture', 'hplc', 'western blot', 'elisa', 'microscopy', 'gc-ms', 'spectroscopy', 'glp', 'clinical trials'],
  'writing-media': ['ap style', 'copy editing', 'proofreading', 'video editing', 'adobe premiere', 'final cut pro', 'photography', 'journalism'],
  'protective-services': ['cctv', 'patrol', 'guard card', 'loss prevention', 'emergency response', 'report writing'],
  'social-services': ['case management', 'crisis intervention', 'motivational interviewing', 'community outreach', 'trauma-informed care'],
  'qa-testing': ['manual testing', 'test cases', 'regression testing', 'test planning', 'bug tracking', 'user acceptance testing'],
  'it-support': ['active directory', 'help desk', 'ticketing systems', 'hardware support', 'desktop support'],
};

const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#&./ -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const SIGNATURE_FAMILY = new Map<string, RoleFamilyId>();
for (const [key, skills] of Object.entries(SIGNATURE_SKILLS) as Array<[RoleFamilyKey, readonly string[]]>) {
  for (const skill of skills) SIGNATURE_FAMILY.set(fold(skill), key as RoleFamilyId);
}

/** The built-in signature family of a skill or licence, or null. */
export function signatureSkillFamily(skill: string): RoleFamilyId | null {
  return typeof skill === 'string' ? (SIGNATURE_FAMILY.get(fold(skill)) ?? null) : null;
}

/** The family a title names, or null when the title rules know nothing of it ("Analyst", "Engineer"). */
export function familyOfTitle(title: string): RoleFamilyId | null {
  const read = categorizeTitle(title);
  return read.categoryId === OTHER_CATEGORY_ID ? null : familyOfCategory(read.categoryId, read.subcategoryIds);
}

/** The family with the most votes; a tie goes to the one voted first. Null for no votes or fewer than `min`. */
function winner(votes: ReadonlyArray<readonly [RoleFamilyId, number]>, min: number): RoleFamilyId | null {
  const totals = new Map<RoleFamilyId, number>();
  for (const [family, weight] of votes) totals.set(family, (totals.get(family) ?? 0) + weight);
  let best: RoleFamilyId | null = null;
  let bestTotal = 0;
  for (const [family, total] of totals) {
    if (total > bestTotal) {
      best = family;
      bestTotal = total;
    }
  }
  return best && bestTotal >= min ? best : null;
}

/**
 * A person's field from their resume's reading: each role title by the title rules, the first (the headline, else the
 * newest role) weighing 3, the next 2, the rest 1 (a tie goes to the newer: the newest role and the two before it in
 * another field tie, so a career changer keeps the newest). When no title names a field, the skills and
 * certifications vote (at least DETECTION_MIN_SKILLS of one field's). General when nothing says.
 */
export function detectProfileFamily(input: ProfileFamilyInput, options: DetectProfileFamilyOptions = {}): RoleFamilyId {
  const roles = (input.roles ?? []).filter((role): role is string => typeof role === 'string' && role.trim() !== '');
  const titleVotes: Array<readonly [RoleFamilyId, number]> = [];
  roles.forEach((role, index) => {
    const family = familyOfTitle(role);
    if (family && family !== GENERAL_FAMILY_ID) titleVotes.push([family, DETECTION_ROLE_WEIGHTS[index] ?? 1]);
  });
  const byTitle = winner(titleVotes, 1);
  if (byTitle) return byTitle;
  const skillVotes: Array<readonly [RoleFamilyId, number]> = [];
  for (const skill of [...(input.certifications ?? []), ...(input.hardSkills ?? [])]) {
    if (typeof skill !== 'string' || !skill.trim()) continue;
    const family = signatureSkillFamily(skill) ?? options.skillFamily?.(skill) ?? null;
    if (family && family !== GENERAL_FAMILY_ID) skillVotes.push([family, 1]);
  }
  return winner(skillVotes, DETECTION_MIN_SKILLS) ?? GENERAL_FAMILY_ID;
}
