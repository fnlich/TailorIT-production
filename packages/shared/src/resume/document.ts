import { z } from 'zod';
import { CUSTOM_KEY_PATTERN } from './catalogue';
import { ResumeDesignSchema } from './design';
import { ENTRY_ID_PATTERN } from './entryIds';
import { LayoutItemSchema } from './layout';
import { RESUME_TEMPLATE_IDS } from './templates';
import { HEADER_FIELDS } from './toggles';

// The resume document: free_tailor's `Resume` less its profile and tailoring fields (no profileId, ownerId, disabled,
// matchKeywords, resumePromptId, model choice or file-name templates). Stored as JSON in `resumes.data`; ids and
// times live on the row. `normalizeResumeDocument` is the only way a document should be built from input.

export const TECHNICAL_SKILLS_LAYOUTS = ['categorized', 'flat'] as const;
export type TechnicalSkillsLayout = (typeof TECHNICAL_SKILLS_LAYOUTS)[number];
/** The editor's words for the two layouts. */
export const TECHNICAL_SKILLS_LAYOUT_LABEL: Record<TechnicalSkillsLayout, string> = {
  categorized: 'Grouped',
  flat: 'Plain',
};
export const DEFAULT_TECHNICAL_SKILLS_LAYOUT: TechnicalSkillsLayout = 'categorized';

export const ResumeSettingsSchema = z.object({
  technicalSkillsLayout: z.enum(TECHNICAL_SKILLS_LAYOUTS),
  /** Print a Soft Skills section (off until turned on; the list is kept either way). */
  includeSoftSkills: z.boolean(),
  /** Print a Strengths section (off until turned on). */
  includeStrengths: z.boolean(),
});
export type ResumeSettings = z.infer<typeof ResumeSettingsSchema>;

export const ResumeContactSchema = z.object({
  phone: z.string(),
  email: z.string(),
  location: z.string(),
  linkedin: z.string().optional(),
  github: z.string().optional(),
  portfolio: z.string().optional(),
});
export type ResumeContact = z.infer<typeof ResumeContactSchema>;

const DatePartSchema = z.object({ y: z.number().int().min(1900).max(2200), m: z.number().int().min(1).max(12).optional() });
/**
 * A date range as the editor picks it (see period.ts). On an entry it sits beside `startDate` and `endDate`, which
 * stay as the canonical text of it for every older reader.
 */
export const ResumePeriodSchema = z.object({
  from: DatePartSchema.optional(),
  to: DatePartSchema.optional(),
  ongoing: z.boolean().optional(),
  ongoingText: z.string().max(20).optional(),
  raw: z.object({ start: z.string().max(100).optional(), end: z.string().max(100).optional() }).optional(),
});

/** What the on-page editor adds to every entry: a stable id, and the keys of the fields it hides (see toggles.ts). */
const entryMeta = {
  id: z.string().regex(ENTRY_ID_PATTERN).optional(),
  hidden: z.array(z.string()).optional(),
};

export const ExperienceEntrySchema = z.object({
  ...entryMeta,
  title: z.string(),
  company: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  period: ResumePeriodSchema.optional(),
  location: z.string(),
  description: z.string(),
  achievements: z.array(z.string()),
  /** "Skills used". */
  skills: z.array(z.string()),
});
export type ExperienceEntry = z.infer<typeof ExperienceEntrySchema>;

export const StrengthEntrySchema = z.object({ ...entryMeta, title: z.string(), description: z.string() });
export type StrengthEntry = z.infer<typeof StrengthEntrySchema>;

export const EducationEntrySchema = z.object({
  ...entryMeta,
  degree: z.string(),
  institution: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  period: ResumePeriodSchema.optional(),
  location: z.string(),
  gpa: z.string().optional(),
  achievements: z.array(z.string()).optional(),
});
export type EducationEntry = z.infer<typeof EducationEntrySchema>;

export const CertificationEntrySchema = z.object({
  ...entryMeta,
  name: z.string(),
  issuer: z.string(),
  date: z.string(),
  expiryDate: z.string().optional(),
  credentialId: z.string().optional(),
});
export type CertificationEntry = z.infer<typeof CertificationEntrySchema>;

export const ProjectEntrySchema = z.object({
  ...entryMeta,
  name: z.string(),
  role: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  period: ResumePeriodSchema.optional(),
  /** As typed; templates print only http(s) links. */
  link: z.string(),
  description: z.string(),
  achievements: z.array(z.string()),
});
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;

export const LanguageEntrySchema = z.object({
  ...entryMeta,
  language: z.string(),
  /** The label as printed ("Fluent"); the dots are `level`. */
  proficiency: z.string(),
  /** The proficiency dots, 1 to 5. */
  level: z.number().int().min(1).max(5).optional(),
});
export type LanguageEntry = z.infer<typeof LanguageEntrySchema>;

export const AwardEntrySchema = z.object({
  ...entryMeta,
  title: z.string(),
  issuer: z.string(),
  date: z.string(),
  description: z.string(),
});
export type AwardEntry = z.infer<typeof AwardEntrySchema>;

export const PublicationEntrySchema = z.object({
  ...entryMeta,
  title: z.string(),
  publisher: z.string(),
  date: z.string(),
  link: z.string(),
  description: z.string(),
});
export type PublicationEntry = z.infer<typeof PublicationEntrySchema>;

export const VolunteeringEntrySchema = z.object({
  ...entryMeta,
  role: z.string(),
  organization: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  period: ResumePeriodSchema.optional(),
  location: z.string(),
  description: z.string(),
  achievements: z.array(z.string()),
});
export type VolunteeringEntry = z.infer<typeof VolunteeringEntrySchema>;

export const CourseEntrySchema = z.object({ ...entryMeta, name: z.string(), institution: z.string(), date: z.string() });
export type CourseEntry = z.infer<typeof CourseEntrySchema>;

export const ReferenceEntrySchema = z.object({
  ...entryMeta,
  name: z.string(),
  title: z.string(),
  company: z.string(),
  email: z.string(),
  phone: z.string(),
});
export type ReferenceEntry = z.infer<typeof ReferenceEntrySchema>;

export const CustomSectionEntrySchema = z.object({
  ...entryMeta,
  heading: z.string(),
  subheading: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  period: ResumePeriodSchema.optional(),
  location: z.string(),
  description: z.string(),
  achievements: z.array(z.string()),
});
export type CustomSectionEntry = z.infer<typeof CustomSectionEntrySchema>;

/** A section the person titles. `key` is client-minted ("cs-" + 8 hex) and referred to as `custom:<key>`. */
export const CustomSectionSchema = z.object({
  key: z.string().regex(CUSTOM_KEY_PATTERN),
  title: z.string(),
  entries: z.array(CustomSectionEntrySchema),
});
export type CustomSection = z.infer<typeof CustomSectionSchema>;

/** One heading of Technical Skills and the skills under it. */
export const SkillCategoryGroupSchema = z.object({ category: z.string(), skills: z.array(z.string()) });
export type SkillCategoryGroup = z.infer<typeof SkillCategoryGroupSchema>;

/** The header of the on-page editor: which details it hides, the name in capitals, and the photo. */
export const HEADER_PHOTO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HEADER_PHOTO_SHAPES = ['round', 'square'] as const;
export type HeaderPhotoShape = (typeof HEADER_PHOTO_SHAPES)[number];
export const ResumeHeaderSchema = z.object({
  hidden: z.array(z.enum(HEADER_FIELDS)),
  uppercaseName: z.boolean().optional(),
  /** A photo is hidden until one is added; `photoId` names a row of the account's photos. */
  photo: z.object({ photoId: z.string().regex(HEADER_PHOTO_ID_PATTERN), shape: z.enum(HEADER_PHOTO_SHAPES) }).optional(),
});
export type ResumeHeader = z.infer<typeof ResumeHeaderSchema>;

/**
 * A normalized resume. Every list is present (empty when there is nothing) except `skillCategories` (absent: the
 * renderer works the grouping out from the skill library) and `sectionOrder` (absent: the template's own order).
 * The optional markers let files written by free_tailor validate as well. The fields from `templateId` on belong to
 * the on-page editor and sit beside the older ones; a document without them is a legacy document and reads as before.
 */
export const ResumeDocumentSchema = z.object({
  /** The person's name, printed on the resume. */
  name: z.string(),
  /** The headline under the name. */
  title: z.string(),
  /** Not printed by itself; given to Write with AI. */
  totalYearsExperience: z.number().nonnegative().optional(),
  /** Template id ('' = none chosen: drawn with the default template). */
  preferredTemplate: z.string(),
  resumeSettings: ResumeSettingsSchema,
  contact: ResumeContactSchema,
  summary: z.string(),
  experience: z.array(ExperienceEntrySchema),
  strengths: z.array(StrengthEntrySchema),
  /** Every technical skill, flat; every grouped skill is also here. */
  skills: z.array(z.string()),
  skillCategories: z.array(SkillCategoryGroupSchema).optional(),
  softSkills: z.array(z.string()).optional(),
  education: z.array(EducationEntrySchema),
  certifications: z.array(CertificationEntrySchema).optional(),
  projects: z.array(ProjectEntrySchema).optional(),
  languages: z.array(LanguageEntrySchema).optional(),
  awards: z.array(AwardEntrySchema).optional(),
  publications: z.array(PublicationEntrySchema).optional(),
  volunteering: z.array(VolunteeringEntrySchema).optional(),
  courses: z.array(CourseEntrySchema).optional(),
  interests: z.array(z.string()).optional(),
  references: z.array(ReferenceEntrySchema).optional(),
  customSections: z.array(CustomSectionSchema).optional(),
  /** Kind ids and `custom:<key>` refs, as the person arranged them. */
  sectionOrder: z.array(z.string()).optional(),
  /** The template the editor draws with; absent on a legacy document (`preferredTemplate` is mapped instead). */
  templateId: z.enum(RESUME_TEMPLATE_IDS).optional(),
  /** Every section with its column, switch and settings; absent: worked out from `sectionOrder` and the include flags. */
  layout: z.array(LayoutItemSchema).optional(),
  header: ResumeHeaderSchema.optional(),
  /** Only what the person changed in Design & Font. */
  design: ResumeDesignSchema.optional(),
  /** 1: rich-text fields hold inline markup (inline.ts). Absent: every string is literal text. */
  markupVersion: z.literal(1).optional(),
});
export type ResumeDocument = z.infer<typeof ResumeDocumentSchema>;

/**
 * A document as a request carries it: any object. Fields are read leniently by `normalizeResumeDocument` (an omitted
 * field keeps the stored value, a list given replaces it), so the schema only insists on an object.
 */
export const ResumeDocumentInputSchema = z.record(z.string(), z.unknown());
export type ResumeDocumentInput = z.infer<typeof ResumeDocumentInputSchema>;
