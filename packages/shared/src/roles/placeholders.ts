import type { SectionWordings } from '../resume/catalogue';
import type { ResumeTemplateId } from '../resume/templates';
import { TECHNICAL_FAMILY_ID, roleFamilyOf, type RoleArchetype, type RoleFamilyId, type RoleFamilyKey } from './families';

// v33 ROLES (F4, "other things that follow the field"): the editor's words for a person's field. The skills section is
// "Technical skills" only for the technical fields (printed templates already say "Skills"); the examples in the
// editor's boxes ("e.g. Registered Nurse") follow the field; the template pickers list the field's suggestions first.
// The technical family's words are the catalogue's defaults, word for word, so nothing changes for it.

/** The examples a field's editor boxes show. */
export interface FieldExamples {
  readonly jobTitle: string;
  readonly company: string;
  readonly degree: string;
  readonly institution: string;
  readonly certification: string;
  readonly issuer: string;
  /** "+ Skill"'s example. */
  readonly skill: string;
  /** A role's "Skills used" example. */
  readonly roleSkill: string;
}

/** v3.2's examples (resume/catalogue.ts and the phone editor): the technical family keeps them. */
const TECHNICAL_EXAMPLES: FieldExamples = {
  jobTitle: 'e.g. Senior Software Engineer',
  company: 'e.g. Northwind Payments',
  degree: 'e.g. M.S. Computer Science',
  institution: 'e.g. University of Washington',
  certification: 'e.g. AWS Certified Solutions Architect',
  issuer: 'e.g. Amazon Web Services',
  skill: 'e.g. TypeScript',
  roleSkill: 'e.g. Kubernetes',
};

const ARCHETYPE_EXAMPLES: Readonly<Record<RoleArchetype, FieldExamples>> = {
  technical: TECHNICAL_EXAMPLES,
  professional: {
    jobTitle: 'e.g. Operations Coordinator',
    company: 'e.g. Northwind Partners',
    degree: 'e.g. B.A. Business Administration',
    institution: 'e.g. University of Washington',
    certification: 'e.g. PMP',
    issuer: 'e.g. Project Management Institute',
    skill: 'e.g. Microsoft Excel',
    roleSkill: 'e.g. Budgeting',
  },
  'hands-on': {
    jobTitle: 'e.g. Warehouse Lead',
    company: 'e.g. Riverside Logistics',
    degree: 'e.g. High school diploma',
    institution: 'e.g. Lakeside Technical College',
    certification: 'e.g. OSHA 30',
    issuer: 'e.g. OSHA Training Institute',
    skill: 'e.g. Forklift operation',
    roleSkill: 'e.g. Inventory counts',
  },
  care: {
    jobTitle: 'e.g. Registered Nurse',
    company: 'e.g. Mercy General Hospital',
    degree: 'e.g. B.S. Nursing',
    institution: 'e.g. State University',
    certification: 'e.g. BLS',
    issuer: 'e.g. American Heart Association',
    skill: 'e.g. Patient care',
    roleSkill: 'e.g. Medication administration',
  },
};

/** A family's own examples, over its archetype's. */
const FAMILY_EXAMPLES: Readonly<Partial<Record<RoleFamilyKey, Partial<FieldExamples>>>> = {
  'data-analytics': { jobTitle: 'e.g. Data Analyst', skill: 'e.g. SQL', roleSkill: 'e.g. Tableau', certification: 'e.g. Google Data Analytics', issuer: 'e.g. Google' },
  'qa-testing': { jobTitle: 'e.g. QA Tester', skill: 'e.g. Test planning', roleSkill: 'e.g. Regression testing', certification: 'e.g. ISTQB Foundation Level', issuer: 'e.g. ISTQB' },
  'it-support': { jobTitle: 'e.g. IT Support Specialist', skill: 'e.g. Active Directory', roleSkill: 'e.g. Ticketing', certification: 'e.g. CompTIA A+', issuer: 'e.g. CompTIA' },
  design: { jobTitle: 'e.g. Graphic Designer', skill: 'e.g. Adobe Illustrator', roleSkill: 'e.g. Brand identity' },
  'product-project': { jobTitle: 'e.g. Project Manager', skill: 'e.g. Roadmapping', roleSkill: 'e.g. Stakeholder updates' },
  sales: { jobTitle: 'e.g. Account Executive', skill: 'e.g. Prospecting', roleSkill: 'e.g. CRM', certification: 'e.g. Real estate license', issuer: 'e.g. State licensing board' },
  marketing: { jobTitle: 'e.g. Marketing Coordinator', skill: 'e.g. Email marketing', roleSkill: 'e.g. Google Ads' },
  'writing-media': { jobTitle: 'e.g. Copy Editor', skill: 'e.g. AP style', roleSkill: 'e.g. Proofreading' },
  'customer-service': { jobTitle: 'e.g. Customer Service Representative', skill: 'e.g. Complaint resolution', roleSkill: 'e.g. Zendesk' },
  administrative: { jobTitle: 'e.g. Administrative Assistant', skill: 'e.g. Calendar management', roleSkill: 'e.g. Data entry', certification: 'e.g. Microsoft Office Specialist', issuer: 'e.g. Microsoft' },
  finance: { jobTitle: 'e.g. Staff Accountant', skill: 'e.g. QuickBooks', roleSkill: 'e.g. Reconciliations', certification: 'e.g. CPA', issuer: 'e.g. State Board of Accountancy' },
  'people-hr': { jobTitle: 'e.g. HR Generalist', skill: 'e.g. Onboarding', roleSkill: 'e.g. Benefits administration', certification: 'e.g. SHRM-CP', issuer: 'e.g. SHRM' },
  legal: { jobTitle: 'e.g. Paralegal', degree: 'e.g. Paralegal certificate', skill: 'e.g. Legal research', roleSkill: 'e.g. Westlaw', certification: 'e.g. Certified Paralegal', issuer: 'e.g. NALA' },
  'business-operations': { jobTitle: 'e.g. Operations Manager', skill: 'e.g. Process improvement', roleSkill: 'e.g. Vendor management' },
  'logistics-transportation': { jobTitle: 'e.g. Warehouse Lead', certification: 'e.g. CDL Class A', issuer: 'e.g. State DMV' },
  education: {
    jobTitle: 'e.g. Third Grade Teacher',
    company: 'e.g. Lincoln Elementary School',
    degree: 'e.g. B.A. Elementary Education',
    certification: 'e.g. State teaching license',
    issuer: 'e.g. State Department of Education',
    skill: 'e.g. Lesson planning',
    roleSkill: 'e.g. Classroom management',
  },
  'social-services': {
    jobTitle: 'e.g. Case Manager',
    company: 'e.g. Riverside Family Services',
    degree: 'e.g. B.S.W. Social Work',
    certification: 'e.g. LSW',
    issuer: 'e.g. State Board of Social Work',
    skill: 'e.g. Case management',
    roleSkill: 'e.g. Crisis intervention',
  },
  'trades-facilities': { jobTitle: 'e.g. Journeyman Electrician', company: 'e.g. Brightline Electric', degree: 'e.g. Electrical apprenticeship', skill: 'e.g. Blueprint reading', roleSkill: 'e.g. Conduit bending' },
  manufacturing: { jobTitle: 'e.g. Production Lead', company: 'e.g. Northfield Manufacturing', skill: 'e.g. Quality inspection', roleSkill: 'e.g. Lean manufacturing' },
  'engineering-physical': { jobTitle: 'e.g. Mechanical Engineer', degree: 'e.g. B.S. Mechanical Engineering', skill: 'e.g. SolidWorks', roleSkill: 'e.g. GD&T', certification: 'e.g. EIT', issuer: 'e.g. NCEES' },
  'science-research': { jobTitle: 'e.g. Research Associate', degree: 'e.g. B.S. Biology', skill: 'e.g. Cell culture', roleSkill: 'e.g. PCR', certification: 'e.g. GLP training', issuer: 'e.g. Your institution' },
  'hospitality-retail': { jobTitle: 'e.g. Shift Supervisor', company: 'e.g. Harbor Street Cafe', skill: 'e.g. Cash handling', roleSkill: 'e.g. Point of sale', certification: 'e.g. ServSafe Food Handler', issuer: 'e.g. ServSafe' },
  'protective-services': { jobTitle: 'e.g. Security Officer', company: 'e.g. Sentinel Security', skill: 'e.g. Patrol', roleSkill: 'e.g. Incident reports', certification: 'e.g. Guard card', issuer: 'e.g. State licensing board' },
};

/** The examples of a field's editor boxes (the technical family's are v3.2's). */
export function fieldExamplesOf(family: RoleFamilyId | null | undefined): FieldExamples {
  const archetype = roleFamilyOf(family).archetype;
  const key = (family ?? '') as RoleFamilyKey;
  return { ...ARCHETYPE_EXAMPLES[archetype], ...(Object.hasOwn(FAMILY_EXAMPLES, key) ? FAMILY_EXAMPLES[key] : {}) };
}

/** The editor's words for a field. */
export interface RoleEditorCopy {
  readonly familyId: RoleFamilyId;
  /** The skills card's label: "Technical skills" for the technical fields, "Skills" for the others. */
  readonly skillsLabel: string;
  /** A role's "Skills used" "?": where its skills go. */
  readonly roleSkillsHelp: string;
  readonly examples: FieldExamples;
  /** The sections' words over the catalogue's (resume/catalogue.ts `sectionKindIn`); {} for the technical family. */
  readonly sections: SectionWordings;
}

const sentenceCase = (heading: string) => heading.charAt(0) + heading.slice(1).toLowerCase();

/** The editor's words for a field; null or unknown reads as technical (v3.2's words), the default the editor had. */
export function editorCopyFor(family: RoleFamilyId | null | undefined): RoleEditorCopy {
  const id = family ?? TECHNICAL_FAMILY_ID;
  const known = roleFamilyOf(id);
  const skillsLabel = sentenceCase(known.skillsHeading);
  const examples = fieldExamplesOf(id);
  const technical = known.id === TECHNICAL_FAMILY_ID;
  return {
    familyId: known.id,
    skillsLabel,
    roleSkillsHelp: `Not printed; each skill also joins your ${skillsLabel}.`,
    examples,
    sections: technical
      ? {}
      : {
          skills: { label: skillsLabel },
          experience: { placeholders: { title: examples.jobTitle, company: examples.company } },
          education: { placeholders: { degree: examples.degree, institution: examples.institution } },
          certifications: { placeholders: { name: examples.certification, issuer: examples.issuer } },
        },
  };
}

// ------------------------------------------------------------------------------------------ suggested templates

/**
 * The templates a field's pickers list first (New resume, the Templates panel), most suited first: dense two-column
 * pages for technical resumes, clean one-column ones for the others, the plainest for hands-on work.
 */
export const SUGGESTED_TEMPLATES: Readonly<Record<RoleArchetype, readonly ResumeTemplateId[]>> = {
  technical: ['double-column', 'compact', 'modern', 'ats-plain'],
  professional: ['one-column-slate', 'single-column', 'modern', 'ivy-league'],
  'hands-on': ['ats-plain', 'single-column', 'one-column-timeline'],
  care: ['one-column-slate', 'single-column', 'one-column-timeline', 'ats-plain'],
};

/** The templates suggested for a field (none without a field: the pickers keep their own order). */
export function suggestedTemplatesFor(family: RoleFamilyId | null | undefined): readonly ResumeTemplateId[] {
  return family ? SUGGESTED_TEMPLATES[roleFamilyOf(family).archetype] : [];
}

/** `ids` with the field's suggested templates first (in suggestion order), the rest in their own order. */
export function templatesInFieldOrder<T extends string>(ids: readonly T[], family: RoleFamilyId | null | undefined): T[] {
  const suggested = suggestedTemplatesFor(family) as readonly string[];
  const first = suggested.filter((id) => (ids as readonly string[]).includes(id)) as T[];
  return [...first, ...ids.filter((id) => !first.includes(id))];
}
