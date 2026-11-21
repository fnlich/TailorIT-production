import { z } from 'zod';
import { definePrompt } from '../types';

// v30 ST1: moved word for word from features/resumes/ai/resumeImport.ts (which runs the task and saves the copy).
// "Make an editable copy": an uploaded resume's text read by the AI into a new resume document. The rule is
// free_tailor's, in TailorIT's words: copy, never infer.

/** A text field; a number (a phone, a year) is read as its digits. */
const text = z.preprocess((value) => (typeof value === 'number' ? String(value) : value), z.string().nullish());
const list = z.array(z.unknown()).nullish();

/** The model's answer: the resume document's shape, read leniently (the normaliser decides what is kept). */
export const ImportedResumeSchema = z
  .object({
    name: text,
    title: text,
    contact: z
      .object({ email: text, phone: text, location: text, linkedin: text, github: text, portfolio: text })
      .partial()
      .passthrough()
      .nullish(),
    summary: text,
    experience: list,
    // A flat list, or the resume's own grouping written as a { heading: [skills] } map.
    skills: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).nullish(),
    skillCategories: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).nullish(),
    softSkills: list,
    strengths: list,
    education: list,
    certifications: list,
    projects: list,
    languages: list,
    awards: list,
    publications: list,
    volunteering: list,
    courses: list,
    interests: list,
    references: list,
    otherSections: z.array(z.object({ title: text, entries: list }).passthrough()).nullish(),
  })
  .passthrough();
export type ImportedResume = z.infer<typeof ImportedResumeSchema>;

const SHAPE = `{
  "name": "", "title": "",
  "contact": { "email": "", "phone": "", "location": "", "linkedin": "", "github": "", "portfolio": "" },
  "summary": "",
  "experience": [{ "title": "", "company": "", "startDate": "", "endDate": "", "location": "", "description": "",
                   "achievements": [""], "skills": [""] }],
  "skills": [""],
  "skillCategories": [{ "category": "", "skills": [""] }],
  "softSkills": [""],
  "strengths": [{ "title": "", "description": "" }],
  "education": [{ "degree": "", "institution": "", "startDate": "", "endDate": "", "location": "", "gpa": "",
                  "achievements": [""] }],
  "certifications": [{ "name": "", "issuer": "", "date": "", "expiryDate": "", "credentialId": "" }],
  "projects": [{ "name": "", "role": "", "startDate": "", "endDate": "", "link": "", "description": "", "achievements": [""] }],
  "languages": [{ "language": "", "proficiency": "" }],
  "awards": [{ "title": "", "issuer": "", "date": "", "description": "" }],
  "publications": [{ "title": "", "publisher": "", "date": "", "link": "", "description": "" }],
  "volunteering": [{ "role": "", "organization": "", "startDate": "", "endDate": "", "location": "", "description": "",
                     "achievements": [""] }],
  "courses": [{ "name": "", "institution": "", "date": "" }],
  "interests": [""],
  "references": [{ "name": "", "title": "", "company": "", "email": "", "phone": "" }],
  "otherSections": [{ "title": "", "entries": [{ "heading": "", "subheading": "", "startDate": "", "endDate": "",
                      "location": "", "description": "", "achievements": [""] }] }]
}`;

const SYSTEM = `You copy the text of a resume into a structured resume document.

Copy, never infer. Every name, title, employer, date, figure, skill and sentence comes from the resume text exactly
as it is written there. A field the resume says nothing about stays empty (an empty string or an empty list); a
document that leaves a gap where the resume is silent is correct, and one that says something the resume does not
is wrong.

How to fill each part:
- name: the person's name. title: the headline written under the name; when there is none, the most recent job
  title as written.
- contact: the email, phone and location the resume shows, and its profile links (LinkedIn, GitHub, a portfolio or a
  website).
- summary: the resume's own summary or profile paragraph, word for word. When it has none, leave it empty; never
  write one.
- experience: every paid role, in the order the resume lists them, each with its title, company, dates, location,
  the resume's own sentence describing the role (if any) as description, every bullet under it as achievements
  (tidy the wording only if you must, never strengthen a claim, keep every figure exactly as stated) and the
  software, tools, equipment and methods that role names as skills.
- skills: every hard skill the resume names anywhere (software, tools, equipment, procedures, techniques, methods and
  standards), spelled as the resume spells it. Never add a skill because a job title, a project or another skill
  implies it.
- skillCategories: only when the resume itself groups its skills under headings: those headings with their skills.
  Otherwise an empty list.
- softSkills: soft skills the resume states itself (communication, mentoring, ownership); never put them in skills.
- strengths: only from a strengths or key-qualities section the resume actually has; otherwise an empty list.
- education: each degree with its institution, dates, location, GPA when stated, and honours or bullets.
- certifications, projects, languages, awards, publications, volunteering, courses, interests and references: only
  from sections the resume actually has; an empty list for any it lacks. A paid job is experience, never a project.
- otherSections: any other section the resume has (patents, talks, exhibitions), under its own title.
- Dates: MM/YYYY when the resume gives a month and a year; a year alone stays a year; "Present" for a current role;
  an empty string when the resume gives none. Never estimate a date.
- Never write a figure, a date, a team size, a duration or an outcome that the resume does not state.

The document's shape (every key present, lists may be empty):
${SHAPE}`;

export interface ResumeImportInput {
  text: string;
}

export const resumeImportPrompt = definePrompt<ResumeImportInput, ImportedResume>({
  area: 'resumes',
  name: 'resume-import',
  // v33 PROMPTS (F5): 2, the neutral wording (skills of every field, not only technical ones): its cached copies
  // (uploadReading.ts keys them by this version) are made again.
  version: 2,
  description: "Copies an uploaded resume's text into a resume document, field by field (Make an editable copy).",
  kind: 'resume_import',
  system: () => SYSTEM,
  user: (input) => `RESUME TEXT (between the markers):\n<<<RESUME\n${input.text}\nRESUME>>>`,
  output: ImportedResumeSchema,
});
