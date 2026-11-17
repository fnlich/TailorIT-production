// tailor_builder0's types (backend/src/types/profile.ts and template.ts), as its tailoring code reads them. Ported with
// the owner's permission of 2026-11-09 (the owner's own earlier project, ISC licence). `mapping.ts` converts a TailorIT
// ResumeDocument to a Profile and the tailored content back.

export interface Contact {
  phone: string;
  email: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  location: string;
}

export interface Experience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface Strength {
  title: string;
  description: string;
}

export interface Education {
  degree: string;
  institution: string;
  startDate: string;
  endDate: string;
  location: string;
  gpa?: string;
  achievements?: string[];
}

export interface Certification {
  name: string;
  issuer: string;
  date: string;
  expiryDate?: string;
  credentialId?: string;
}

/** The candidate. tailor_builder0's ids, timestamps and template choice are not needed here and are optional. */
export interface Profile {
  id?: string;
  name: string;
  title: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  contact: Contact;
  summary: string;
  experience: Experience[];
  strengths: Strength[];
  skills: string[];
  education: Education[];
  certifications?: Certification[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * One keyword an applicant tracking system will search a resume for, in the
 * posting's exact wording. Hard keywords are tools, certifications, and
 * competency phrases ("Capacity planning"); soft keywords are traits.
 */
export interface AtsKeyword {
  term: string;
  type: 'hard' | 'soft';
  kind: 'tool' | 'competency' | 'certification' | 'soft';
  /** True for must_have and strong keywords; false for nice_to_have. */
  required: boolean;
  /**
   * How much the posting leans on the keyword: named in the title, required or stated
   * as a must (must_have); in the responsibilities (strong); preferred, "familiarity
   * with", or only in the stack description (nice_to_have). Absent in older analyses.
   */
  priority?: KeywordPriority;
}

export type KeywordPriority = 'must_have' | 'strong' | 'nice_to_have';

export interface JobAnalysis {
  jobMeta: {
    title: string;
    seniority: string;
    industry: string;
    department: string;
  };
  skills: {
    required: string[];
    preferred: string[];
    tools: string[];
    technologies: string[];
  };
  responsibilities: string[];
  domainKnowledge: string[];
  softSkills: string[];
  keywords: {
    actionVerbs: string[];
    buzzwords: string[];
    mustInclude: string[];
  };
  /** Raw job description this analysis was produced from; used for keyword counts. */
  sourceJobDescription?: string;
  /** The ATS keyword list the tailoring and scoring steps work from. */
  atsKeywords?: AtsKeyword[];
}

export interface TailoredContent {
  title: string;
  summary: string;
  experience: TailoredExperience[];
  skills: string[];
  hardSkills: string[];
  softSkills: string[];
  // Optional fields from job analysis merged into tailored content
  requiredSkills?: string[];
  preferredSkills?: string[];
  strengths: TailoredStrength[];
  /** Cover letter body (content between "Dear Hiring Manager" and "Best regards") */
  coverLetter?: string;
}

export interface TailoredExperience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface TailoredStrength {
  title: string;
  description: string;
}
