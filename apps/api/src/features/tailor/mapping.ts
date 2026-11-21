import {
  documentPlainText,
  effectiveLayout,
  enableSection,
  escapeInline,
  newEntryId,
  normalizeResumeDocument,
  printedDocument,
  RESUME_TEMPLATES,
  type ResumeDocument,
  type ResumeTemplateId,
  type StrengthEntry,
} from '@tailorit/shared';
import { getTailoredResumeText } from './ats';
import { buildSkillGroups } from './skills/groups';
import { loadSkillsReference, referenceSkillsInText, type SkillsReference } from './skills/reference';
import type { Profile, TailoredContent } from './types';

// Between TailorIT's resume document and tailor_builder0's Profile (decision 15).
//
// To the Profile: the document as it prints (switched-off sections empty, hidden details blank), as plain words
// (plainRichFields), so the model reads what the resume says. Entries stay one for one, so a tailored role is the
// source role at the same position.
//
// Back to a document: the source document with the tailored words laid over it. Only the words the model writes
// change: the headline, the summary, each role's description and bullets, the skills, the soft skills and the
// strengths. Everything else is the source's own, so the profile's facts are protected by construction: every role
// keeps its id, employer, title, dates and their period, place and "skills used"; education, certifications and every
// other section are copied as they are. The text is escaped (the document holds inline markup), the skills are
// grouped by tailor_builder0's skill library when the source groups its skills, and the document is drawn on the chosen
// template.

/** The facts tailoring never changes, as plain values: what a test (and keptFacts) compares. */
export function protectedFactsOf(document: ResumeDocument) {
  return {
    experience: document.experience.map(({ id, title, company, startDate, endDate, period, location, skills }) => ({
      id,
      title,
      company,
      startDate,
      endDate,
      period,
      location,
      skills,
    })),
    education: document.education,
    certifications: document.certifications ?? [],
    projects: document.projects ?? [],
    languages: document.languages ?? [],
    awards: document.awards ?? [],
    publications: document.publications ?? [],
    volunteering: document.volunteering ?? [],
    courses: document.courses ?? [],
    references: document.references ?? [],
    customSections: document.customSections ?? [],
    name: document.name,
    contact: document.contact,
  };
}

/** True when `tailored` keeps every protected fact of `source` (employers, titles, dates, education...). */
export function keptFacts(source: ResumeDocument, tailored: ResumeDocument): boolean {
  return JSON.stringify(protectedFactsOf(source)) === JSON.stringify(protectedFactsOf(tailored));
}

/** The person's details the resume lacks, from the account (as the cover letters fill them). */
export interface ProfileFallback {
  name: string;
  email: string;
  phone: string;
  location: string;
}

/** tailor_builder0's Profile from a resume document: what prints, as plain words. */
export function profileFromDocument(stored: ResumeDocument, fallback?: Partial<ProfileFallback>): Profile {
  const document = documentPlainText(printedDocument(stored));
  const contact = document.contact;
  const or = (value: string | undefined, other: string | undefined) => (value?.trim() ? value.trim() : (other ?? '').trim());
  return {
    name: or(document.name, fallback?.name),
    title: document.title.trim(),
    ...(document.totalYearsExperience !== undefined ? { totalYearsExperience: document.totalYearsExperience } : {}),
    contact: {
      phone: or(contact.phone, fallback?.phone),
      email: or(contact.email, fallback?.email),
      location: or(contact.location, fallback?.location),
      ...(contact.linkedin ? { linkedin: contact.linkedin } : {}),
      ...(contact.github ? { github: contact.github } : {}),
      ...(contact.portfolio ? { portfolio: contact.portfolio } : {}),
    },
    summary: document.summary,
    experience: document.experience.map((entry) => ({
      title: entry.title,
      company: entry.company,
      startDate: entry.startDate,
      endDate: entry.endDate,
      location: entry.location,
      description: entry.description,
      achievements: entry.achievements.filter((bullet) => bullet.trim()),
    })),
    strengths: document.strengths.map((entry) => ({ title: entry.title, description: entry.description })),
    skills: [...document.skills],
    education: document.education.map((entry) => ({
      degree: entry.degree,
      institution: entry.institution,
      startDate: entry.startDate,
      endDate: entry.endDate,
      location: entry.location,
      ...(entry.gpa ? { gpa: entry.gpa } : {}),
      ...(entry.achievements?.length ? { achievements: entry.achievements } : {}),
    })),
    certifications: (document.certifications ?? []).map((entry) => ({
      name: entry.name,
      issuer: entry.issuer,
      date: entry.date,
      ...(entry.expiryDate ? { expiryDate: entry.expiryDate } : {}),
      ...(entry.credentialId ? { credentialId: entry.credentialId } : {}),
    })),
  };
}

/**
 * Whether the source groups its technical skills: the skills section shows group names unless the person turned
 * them off ("Plain"), which every template of the on-page editor prints.
 */
export function sourceGroupsSkills(document: ResumeDocument): boolean {
  const options = effectiveLayout(document).find((item) => item.ref === 'skills')?.options;
  return options?.showGroupNames !== false && document.resumeSettings.technicalSkillsLayout !== 'flat';
}

/**
 * The skill groups tailor_builder0 prints for a tailored resume (its renderDataForTemplate): the finished hard skills,
 * topped up only from the candidate's own skills (the profile's list, and library skills the resume's text names).
 * Null when the list is too short to group.
 */
export function tailoredSkillGroups(tailored: TailoredContent, profile: Profile, skills: SkillsReference = loadSkillsReference()) {
  const text = getTailoredResumeText({ ...tailored, title: '', hardSkills: [], softSkills: [], skills: [] });
  return buildSkillGroups(tailored.hardSkills, [...profile.skills, ...referenceSkillsInText(text, 'hard', skills)], skills);
}

/** New strengths take the source's entry ids by position, and fresh ones past them. */
function strengthEntries(source: ResumeDocument, strengths: TailoredContent['strengths']): StrengthEntry[] {
  const taken = source.strengths.map((entry) => entry.id).filter((id): id is string => Boolean(id));
  return strengths.map((strength, index) => {
    let id = source.strengths[index]?.id;
    if (!id) {
      id = newEntryId(undefined, taken);
      taken.push(id);
    }
    return { id, title: strength.title, description: escapeInline(strength.description) };
  });
}

/**
 * The tailored resume: `source` (a document of the on-page editor: an older one is upgraded first) with the tailored
 * words laid over it, on `templateId`. `tailored` null (a posting with too little text to tailor to): the source's
 * own words on the chosen template.
 */
export function tailoredDocument(
  source: ResumeDocument,
  tailored: TailoredContent | null,
  // v33 PROMPTS (F5): `skills`, the tailoring's skill library (its family's; missing: tailor_builder0's).
  options: { templateId: ResumeTemplateId; profile: Profile; skills?: SkillsReference },
): ResumeDocument {
  const spec = RESUME_TEMPLATES[options.templateId];
  if (!tailored) return normalizeResumeDocument({ ...source, templateId: options.templateId });

  let layout = effectiveLayout(source);
  if (tailored.softSkills.length > 0) layout = enableSection(layout, 'softSkills', spec);
  if (tailored.strengths.length > 0) layout = enableSection(layout, 'strengths', spec);

  const grouped = sourceGroupsSkills(source) ? tailoredSkillGroups(tailored, options.profile, options.skills) : null;
  const skillCategories = grouped?.map((group) => ({ category: group.title, skills: [...group.items] }));
  const skills = [...new Set([...tailored.hardSkills, ...(skillCategories ?? []).flatMap((group) => group.skills)])];

  const experience = source.experience.map((entry, index) => {
    const role = tailored.experience[index];
    if (!role) return entry;
    return {
      ...entry,
      description: escapeInline(role.description),
      achievements: role.achievements.map(escapeInline),
    };
  });

  const document: ResumeDocument = {
    ...source,
    title: tailored.title.trim() || source.title,
    summary: tailored.summary.trim() ? escapeInline(tailored.summary) : source.summary,
    experience,
    strengths: tailored.strengths.length > 0 ? strengthEntries(source, tailored.strengths) : source.strengths,
    skills,
    softSkills: [...tailored.softSkills],
    resumeSettings: {
      ...source.resumeSettings,
      ...(skillCategories ? { technicalSkillsLayout: 'categorized' as const } : {}),
    },
    templateId: options.templateId,
    layout,
    markupVersion: 1,
  };
  if (skillCategories) document.skillCategories = skillCategories;
  else delete document.skillCategories;
  return normalizeResumeDocument(document);
}
