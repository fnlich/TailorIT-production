import { categorizeTitle } from '../jobs/infer';
import {
  JOB_CATEGORIES,
  NEW_CATEGORY_IDS_V33,
  OTHER_CATEGORY_ID,
  isJobCategoryId,
  subcategoryParent,
  type JobCategoryId,
  type JobSubcategoryId,
} from '../jobs/taxonomy';

// v33 ROLES (F4): the role families. A family is the kind of work a person does or a job asks for, coarser than a job
// category: the AI prompts, the tailoring numbers, the editor's words and the Jobs page's "My field" follow it. Each of
// the 36 job categories belongs to exactly one family; a family named on a subcategory overrides its parent's (a data
// engineer is technical, a data analyst data-analytics). The table is SP\v33\design-roles-prompts.md §(g), the numbers
// PLAN F5's.
//
// Family ids and job category ids are different things that often share a spelling ('healthcare', 'design'): a
// RoleFamilyId is branded, so a category id never passes for one. Make one with `asRoleFamilyId` (or the constants).

/** How a family's resumes read, and so how they are tailored: four archetypes. */
export const ROLE_ARCHETYPES = ['technical', 'professional', 'hands-on', 'care'] as const;
export type RoleArchetype = (typeof ROLE_ARCHETYPES)[number];

/** The ids of the 26 families, in the order the Field select lists them (general last). */
export const ROLE_FAMILY_KEYS = [
  'technical',
  'data-analytics',
  'qa-testing',
  'it-support',
  'design',
  'product-project',
  'sales',
  'marketing',
  'writing-media',
  'customer-service',
  'administrative',
  'finance',
  'people-hr',
  'legal',
  'business-operations',
  'logistics-transportation',
  'healthcare',
  'education',
  'social-services',
  'trades-facilities',
  'manufacturing',
  'engineering-physical',
  'science-research',
  'hospitality-retail',
  'protective-services',
  'general',
] as const;
/** A family id as plain text (record keys, switch cases). Values passed around are `RoleFamilyId`s. */
export type RoleFamilyKey = (typeof ROLE_FAMILY_KEYS)[number];

declare const roleFamilyBrand: unique symbol;
/** A role family's id: branded, so a job category id (often spelled the same) is never taken for one. */
export type RoleFamilyId = RoleFamilyKey & { readonly [roleFamilyBrand]: true };

/** The header a tailored resume gets: the job's main tools, its specialties, or its specialties and held licences. */
export const ROLE_HEADER_STYLES = ['tools', 'specialties', 'specialties-licences'] as const;
export type RoleHeaderStyle = (typeof ROLE_HEADER_STYLES)[number];

/** The numbers tailoring works to for one archetype (PLAN F5's table; technical's are v3.2's constants). */
export interface RoleTailoring {
  /** Size of the finished resume's hard and soft skills lists. */
  readonly hardSkills: { readonly min: number; readonly max: number };
  readonly softSkills: { readonly min: number; readonly max: number };
  /** The most bullets a role keeps, newest role first; older roles keep `olderRoleBullets`. */
  readonly bulletsPerRole: readonly number[];
  readonly olderRoleBullets: number;
  /** The fewest bullets a role is written with, newest role first; older roles `olderRoleMinBullets`. */
  readonly minBulletsPerRole: readonly number[];
  readonly olderRoleMinBullets: number;
  /** The most bullets on the whole resume. */
  readonly maxTotalBullets: number;
  /** The resume score's weights (percent; they add up to 100). */
  readonly atsWeights: { readonly hardSkills: number; readonly softSkills: number; readonly searchability: number };
  /** The header after the person's title: "| <the job's tools>", "| <specialties>", or specialties and held licences. */
  readonly header: RoleHeaderStyle;
  /**
   * The sections the score's searchability checks for: Education; or, when the job asks for a licence or a
   * certification, Licences/Certifications in its place (hands-on) or as well (care). v33 FIX-1: only when asked.
   */
  readonly searchabilitySection: 'education' | 'licences' | 'education-licences';
}

/** The tailoring numbers per archetype. Technical's equal the v3.2 pipeline's constants (a test pins them). */
export const ARCHETYPE_TAILORING: Readonly<Record<RoleArchetype, RoleTailoring>> = {
  technical: {
    hardSkills: { min: 20, max: 25 },
    softSkills: { min: 8, max: 12 },
    bulletsPerRole: [7, 6, 4],
    olderRoleBullets: 3,
    minBulletsPerRole: [5, 4, 3],
    olderRoleMinBullets: 2,
    maxTotalBullets: 18,
    atsWeights: { hardSkills: 65, softSkills: 15, searchability: 20 },
    header: 'tools',
    searchabilitySection: 'education',
  },
  professional: {
    hardSkills: { min: 12, max: 18 },
    softSkills: { min: 6, max: 10 },
    bulletsPerRole: [6, 5, 4],
    olderRoleBullets: 3,
    minBulletsPerRole: [4, 3, 3],
    olderRoleMinBullets: 2,
    maxTotalBullets: 16,
    atsWeights: { hardSkills: 60, softSkills: 20, searchability: 20 },
    header: 'specialties',
    searchabilitySection: 'education',
  },
  'hands-on': {
    hardSkills: { min: 8, max: 14 },
    softSkills: { min: 5, max: 8 },
    bulletsPerRole: [5, 4, 3],
    olderRoleBullets: 2,
    minBulletsPerRole: [3, 2, 2],
    olderRoleMinBullets: 1,
    maxTotalBullets: 14,
    atsWeights: { hardSkills: 55, softSkills: 25, searchability: 20 },
    header: 'specialties-licences',
    searchabilitySection: 'licences',
  },
  care: {
    hardSkills: { min: 10, max: 16 },
    softSkills: { min: 6, max: 10 },
    bulletsPerRole: [6, 5, 4],
    olderRoleBullets: 3,
    minBulletsPerRole: [4, 3, 3],
    olderRoleMinBullets: 2,
    maxTotalBullets: 16,
    atsWeights: { hardSkills: 55, softSkills: 25, searchability: 20 },
    header: 'specialties-licences',
    searchabilitySection: 'education-licences',
  },
};

/** One role family. */
export interface RoleFamily {
  readonly id: RoleFamilyId;
  /** The Field select's and "Your field"'s words. */
  readonly label: string;
  /** One line on what it covers (the select's option help). */
  readonly blurb: string;
  readonly archetype: RoleArchetype;
  /** The job categories it covers (all their subcategories but the ones another family names). */
  readonly categories: readonly JobCategoryId[];
  /** Subcategories of another family's categories that belong here (they override their parent's family). */
  readonly subcategories: readonly JobSubcategoryId[];
  readonly tailoring: RoleTailoring;
  /** The skills section's heading in its words ("Technical Skills" for the technical fields, else "Skills"). */
  readonly skillsHeading: string;
}

interface FamilySpec {
  label: string;
  blurb: string;
  archetype: RoleArchetype;
  categories: readonly JobCategoryId[];
  subcategories?: readonly JobSubcategoryId[];
  skillsHeading?: string;
}

const TECHNICAL_SKILLS = 'Technical Skills';

/** The family ↔ category table (design-roles-prompts.md §(g)). */
const FAMILY_SPECS: Readonly<Record<RoleFamilyKey, FamilySpec>> = {
  technical: {
    label: 'Software & technology',
    blurb: 'Software, DevOps, security, AI and engineering management',
    archetype: 'technical',
    categories: ['software-engineering', 'devops-infrastructure', 'security', 'ai-ml', 'engineering-management'],
    subcategories: ['data-engineering', 'database-engineering', 'solutions-engineering', 'developer-relations', 'support-engineering'],
    skillsHeading: TECHNICAL_SKILLS,
  },
  'data-analytics': {
    label: 'Data & analytics',
    blurb: 'Data analysis, business intelligence and data science',
    archetype: 'professional',
    categories: ['data-analytics'],
    skillsHeading: TECHNICAL_SKILLS,
  },
  'qa-testing': {
    label: 'QA & testing',
    blurb: 'Manual and automated software testing',
    archetype: 'professional',
    categories: ['qa-testing'],
    skillsHeading: TECHNICAL_SKILLS,
  },
  'it-support': {
    label: 'IT & support',
    blurb: 'Help desk, systems and network administration',
    archetype: 'professional',
    categories: ['it-support'],
    skillsHeading: TECHNICAL_SKILLS,
  },
  design: {
    label: 'Design',
    blurb: 'Product, UX, visual design, illustration and animation',
    archetype: 'professional',
    categories: ['design'],
    subcategories: ['illustration-animation'],
  },
  'product-project': {
    label: 'Product & project management',
    blurb: 'Product management, business analysis, programs and projects',
    archetype: 'professional',
    categories: ['product'],
    subcategories: ['program-management', 'agile-delivery', 'project-management'],
  },
  sales: {
    label: 'Sales',
    blurb: 'Account executives, business development and real estate',
    archetype: 'professional',
    categories: ['sales-solutions', 'real-estate'],
  },
  marketing: {
    label: 'Marketing',
    blurb: 'Growth, content, brand and product marketing',
    archetype: 'professional',
    categories: ['marketing'],
  },
  'writing-media': {
    label: 'Writing & media',
    blurb: 'Writing, editing, journalism, video, photography and translation',
    archetype: 'professional',
    categories: ['writing-media'],
    subcategories: ['technical-writing', 'localization'],
  },
  'customer-service': {
    label: 'Customer service',
    blurb: 'Customer support, success and call centers',
    archetype: 'professional',
    categories: ['customer-success'],
  },
  administrative: {
    label: 'Administrative & office',
    blurb: 'Administrative and executive assistants, reception and office work',
    archetype: 'professional',
    categories: ['administrative-office'],
  },
  finance: {
    label: 'Finance & accounting',
    blurb: 'Accounting, financial analysis, banking and insurance',
    archetype: 'professional',
    categories: ['finance'],
  },
  'people-hr': {
    label: 'People & HR',
    blurb: 'Recruiting, people operations, payroll and training',
    archetype: 'professional',
    categories: ['people-hr'],
  },
  legal: {
    label: 'Legal',
    blurb: 'Lawyers, paralegals, compliance and contracts',
    archetype: 'professional',
    categories: ['legal'],
  },
  'business-operations': {
    label: 'Business operations',
    blurb: 'Operations, strategy, supply chain and purchasing',
    archetype: 'professional',
    categories: ['operations'],
  },
  'logistics-transportation': {
    label: 'Logistics & transportation',
    blurb: 'Warehouses, driving and aviation',
    archetype: 'hands-on',
    categories: ['logistics-warehouse', 'transportation'],
    // v33 FIX-1 (decision for the owner): supply chain, purchasing and buyers are office work, business operations'
    // (operations' subcategory, with its parent); v3.3 had filed them here, with hands-on numbers and wording.
  },
  healthcare: {
    label: 'Healthcare',
    blurb: 'Nursing, patient care, therapy, pharmacy and medical offices',
    archetype: 'care',
    categories: ['healthcare'],
  },
  education: {
    label: 'Education',
    blurb: 'Teaching, childcare, tutoring and school administration',
    archetype: 'care',
    categories: ['education'],
  },
  'social-services': {
    label: 'Social services & public sector',
    blurb: 'Social work, community programs, government and nonprofits',
    archetype: 'care',
    categories: ['social-public-sector'],
  },
  'trades-facilities': {
    label: 'Skilled trades & facilities',
    blurb: 'Electricians, plumbers, mechanics, maintenance, farming and energy',
    archetype: 'hands-on',
    categories: ['skilled-trades', 'facilities-services', 'agriculture-energy'],
  },
  manufacturing: {
    label: 'Manufacturing',
    blurb: 'Production, assembly, machining and quality control',
    archetype: 'hands-on',
    categories: ['manufacturing'],
  },
  'engineering-physical': {
    label: 'Engineering (non-software)',
    blurb: 'Mechanical, electrical, civil, chemical and other engineering',
    archetype: 'professional',
    categories: ['engineering-physical'],
  },
  'science-research': {
    label: 'Science & research',
    blurb: 'Laboratory, life sciences, chemistry and clinical research',
    archetype: 'professional',
    categories: ['science-research'],
  },
  'hospitality-retail': {
    label: 'Hospitality, retail & services',
    blurb: 'Restaurants, hotels, stores and personal care',
    archetype: 'hands-on',
    categories: ['hospitality-food', 'retail', 'personal-care-services'],
  },
  'protective-services': {
    label: 'Protective services',
    blurb: 'Security officers, law enforcement and fire and rescue',
    archetype: 'hands-on',
    categories: ['protective-services'],
  },
  general: {
    label: 'General',
    blurb: 'Any other kind of work',
    archetype: 'professional',
    categories: [OTHER_CATEGORY_ID],
  },
};

const asId = (key: RoleFamilyKey) => key as RoleFamilyId;

/** The 26 families, in ROLE_FAMILY_KEYS' order. */
export const ROLE_FAMILIES: readonly RoleFamily[] = ROLE_FAMILY_KEYS.map((key) => {
  const spec = FAMILY_SPECS[key];
  return {
    id: asId(key),
    label: spec.label,
    blurb: spec.blurb,
    archetype: spec.archetype,
    categories: spec.categories,
    subcategories: spec.subcategories ?? [],
    tailoring: ARCHETYPE_TAILORING[spec.archetype],
    skillsHeading: spec.skillsHeading ?? 'Skills',
  };
});

export const ROLE_FAMILY_IDS: readonly RoleFamilyId[] = ROLE_FAMILIES.map((family) => family.id);
export const TECHNICAL_FAMILY_ID: RoleFamilyId = asId('technical');
export const GENERAL_FAMILY_ID: RoleFamilyId = asId('general');

const FAMILY_BY_ID = new Map<string, RoleFamily>(ROLE_FAMILIES.map((family) => [family.id, family]));
const FAMILY_OF_CATEGORY = new Map<string, RoleFamilyId>();
const FAMILY_OF_SUBCATEGORY = new Map<string, RoleFamilyId>();
for (const family of ROLE_FAMILIES) {
  for (const category of family.categories) FAMILY_OF_CATEGORY.set(category, family.id);
  for (const sub of family.subcategories) FAMILY_OF_SUBCATEGORY.set(sub, family.id);
}

export function isRoleFamilyId(value: unknown): value is RoleFamilyId {
  return typeof value === 'string' && FAMILY_BY_ID.has(value);
}

/** The family id `value` names, or null (anything else, a job category id that is no family's included). */
export function asRoleFamilyId(value: unknown): RoleFamilyId | null {
  return isRoleFamilyId(value) ? value : null;
}

/** A family by id (an unknown id gives general). */
export function roleFamilyOf(id: RoleFamilyId | null | undefined): RoleFamily {
  return (id && FAMILY_BY_ID.get(id)) || FAMILY_BY_ID.get(GENERAL_FAMILY_ID)!;
}

/** A family's label ('' for an unknown id). */
export function roleFamilyLabel(id: string | null | undefined): string {
  return (id && FAMILY_BY_ID.get(id)?.label) || '';
}

/** A family's archetype (general's, professional, for an unknown id). */
export function roleArchetypeOf(id: RoleFamilyId | null | undefined): RoleArchetype {
  return roleFamilyOf(id).archetype;
}

/** A family's tailoring numbers. */
export function roleTailoringOf(id: RoleFamilyId | null | undefined): RoleTailoring {
  return roleFamilyOf(id).tailoring;
}

/** The family a subcategory belongs to: the family that names it, else its parent's. Null for an unknown id. */
export function familyOfSubcategory(subcategoryId: string | null | undefined): RoleFamilyId | null {
  if (!subcategoryId) return null;
  const named = FAMILY_OF_SUBCATEGORY.get(subcategoryId);
  if (named) return named;
  const parent = subcategoryParent(subcategoryId);
  return parent ? (FAMILY_OF_CATEGORY.get(parent) ?? null) : null;
}

/**
 * The family of a job category and its subcategories: the first subcategory (of that category) another family names
 * ("Data Engineering" under Data & Analytics is technical), else the category's family. A subcategory list alone (no
 * category) is read under the first one's parent. General for nothing known.
 */
export function familyOfCategory(
  categoryId: string | null | undefined,
  subcategoryIds: readonly string[] | null | undefined = [],
): RoleFamilyId {
  const subs = (subcategoryIds ?? []).filter((id): id is string => typeof id === 'string');
  const parent = isJobCategoryId(categoryId) ? categoryId : (subs.map(subcategoryParent).find(Boolean) ?? null);
  if (!parent) return GENERAL_FAMILY_ID;
  for (const sub of subs) {
    if (subcategoryParent(sub) !== parent) continue;
    const named = FAMILY_OF_SUBCATEGORY.get(sub);
    if (named) return named;
  }
  return FAMILY_OF_CATEGORY.get(parent) ?? GENERAL_FAMILY_ID;
}

const NEW_PARENTS = new Set<string>(NEW_CATEGORY_IDS_V33);
const usableCategory = (id: string | null | undefined): id is JobCategoryId => isJobCategoryId(id) && id !== OTHER_CATEGORY_ID;

/** What `resolveJobFamily` reads of a job. */
export interface JobFamilyInput {
  /** The AI analysis's category ('other' and unknown ids are ignored). */
  aiCategoryId?: string | null;
  aiSubcategoryIds?: readonly string[] | null;
  /** The job's stored category (its source's field or the title rules at ingest). */
  categoryId?: string | null;
  subcategoryIds?: readonly string[] | null;
  /** Its title, read by the title rules when no category says (the extension may have only a title). */
  title?: string | null;
}

/**
 * A job's family, the one resolver every caller uses (Tailor, own-AI tailoring, the MCP step texts, the extension's
 * tailoring): the job's AI category, then its stored category, then `categorizeTitle(title)`, then general. A stored
 * v3.3 category beats an AI answer that names none of v3.3's parents: v3.2's AI could not file a nurse as healthcare.
 */
export function resolveJobFamily(job: JobFamilyInput): RoleFamilyId {
  const ai = usableCategory(job.aiCategoryId) ? job.aiCategoryId : null;
  const stored = usableCategory(job.categoryId) ? job.categoryId : null;
  if (ai && (!stored || NEW_PARENTS.has(ai) || !NEW_PARENTS.has(stored))) return familyOfCategory(ai, job.aiSubcategoryIds);
  if (stored) return familyOfCategory(stored, job.subcategoryIds);
  if (job.title) {
    const read = categorizeTitle(job.title);
    if (read.categoryId !== OTHER_CATEGORY_ID) return familyOfCategory(read.categoryId, read.subcategoryIds);
  }
  return GENERAL_FAMILY_ID;
}

/**
 * The family a person-side AI task writes in (tailor-resume, revise, letters, autofill answers): the person's, or the
 * job's when the person's is general (nothing known about them).
 */
export function personSideFamily(person: RoleFamilyId, job: RoleFamilyId): RoleFamilyId {
  return person === GENERAL_FAMILY_ID ? job : person;
}

/**
 * The Jobs filter of a family ("My field"): its categories and the subcategories it names elsewhere. A job in one of
 * its categories under a subcategory another family names (a program manager under Engineering Management for the
 * technical field) is in it too: accepted. Empty for general (no My field chip).
 */
export function familyJobFilter(id: RoleFamilyId): { categories: JobCategoryId[]; subcategories: JobSubcategoryId[] } {
  if (id === GENERAL_FAMILY_ID) return { categories: [], subcategories: [] };
  const family = roleFamilyOf(id);
  return { categories: [...family.categories], subcategories: [...family.subcategories] };
}

/** Every category and subcategory id with its family (for tests and the docs table). */
export function familyTable(): Array<{ categoryId: JobCategoryId; familyId: RoleFamilyId; subcategories: Array<{ id: JobSubcategoryId; familyId: RoleFamilyId }> }> {
  return JOB_CATEGORIES.map((category) => ({
    categoryId: category.id,
    familyId: familyOfCategory(category.id),
    subcategories: category.subcategories.map((sub) => ({ id: sub.id, familyId: familyOfSubcategory(sub.id)! })),
  }));
}
