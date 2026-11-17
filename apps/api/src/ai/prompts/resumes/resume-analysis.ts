import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RESUME_READING_VERSION } from '@tailorit/shared';
import { MAX_EXTRACTED_TEXT } from '../../../features/resumes/upload';
import { definePrompt } from '../types';

// v30 ST1: moved word for word from features/resumes/analysis/prompt.ts (its grounding, finishResumeAnalysis, is
// features/resumes/analysis/grounding.ts). The `resume_analysis` prompt: Claude reads an uploaded resume's extracted
// text (never the file, never anything else) for its skills, roles, certifications, industries, dates and the person's
// name. The rule is the editable copy's: copy, never infer. Then every item is grounded in the same text
// (`finishResumeAnalysis`): what the text does not say is dropped, so an invented skill, title or year never reaches
// the stored reading. Bump RESUME_READING_VERSION (packages/shared/src/resume/analysis.ts) whenever the wording or the
// shape changes, so uploads are read again.

/** Characters of resume text sent to the model (all of an upload's stored text). */
export const MAX_RESUME_PROMPT_TEXT = MAX_EXTRACTED_TEXT;

export interface ResumeAnalysisPromptInput {
  text: string;
}

const SYSTEM = `You read one resume and list what it says about the person, for a job-search site that picks the best
of a person's resumes for each job they save. Every item you list is checked word for word against the resume text,
and anything the text does not say is thrown away.

THE RULE: copy, never infer. Take every item from the resume text exactly as it is written there. Never add what a job
title, a project, an employer or another skill implies, and never what a person like this probably knows. A resume
that says little gets a short answer; an empty list is a correct answer.

What to list:
- personName: the person's name as the resume writes it at the top; null when it gives none.
- roles: the job titles the person has held, exactly as written. The headline under the name first, when the resume
  has one; then each role's title in the order the resume lists them. Titles only: no employer, dates or location.
  At most 8.
- hardSkills: every technical skill the resume names: languages, frameworks, libraries, tools, platforms, databases,
  cloud services and methods, spelled as the resume spells them. At most 60.
- softSkills: the soft skills the resume states, such as communication, mentoring or stakeholder management, as
  written. Never a technical skill. At most 40.
- certifications: the certifications and licences the resume says the person holds, by the names it uses. Never a
  degree, a course or a skill. At most 10.
- industries: the industries the resume itself names for the person's work, in its words (fintech, healthcare,
  e-commerce, logistics). Never guess one from an employer's name. At most 5.
- experience: every paid role, in the order the resume lists them, each with its title, company, startDate and
  endDate. Dates: MM/YYYY when the resume gives a month and a year; a year alone stays a year; "Present" for a current
  role; an empty string when the resume gives none. Never estimate a date. Leave out education, projects and
  volunteering.
- totalYearsExperience: a total of years of experience only when the resume itself states one ("8+ years of
  experience" is 8). Never add up dates yourself; null when the resume states no total.

Answer with this shape:
{"personName":null,"roles":[],"hardSkills":[],"softSkills":[],"certifications":[],"industries":[],
 "experience":[{"title":"","company":"","startDate":"","endDate":""}],"totalYearsExperience":null}`;

/** The prompt text's hash, stored with each of Claude's readings (an audit of which wording produced it). */
export const RESUME_ANALYSIS_PROMPT_HASH = createHash('sha256').update(SYSTEM).digest('hex').slice(0, 16);

/** A list of strings, read leniently: other items are dropped, null is empty, a long list is cut. The key must be there. */
function stringList(max: number) {
  return z
    .array(z.unknown())
    .nullable()
    .transform((items) =>
      (items ?? [])
        .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
        .map(String)
        .slice(0, max),
    );
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

export interface ResumeAnalysisOutputEntry {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
}

export const ResumeAnalysisOutputSchema = z.object({
  personName: z.unknown().transform((value) => (typeof value === 'string' ? value : null)),
  roles: stringList(30),
  hardSkills: stringList(150),
  softSkills: stringList(80),
  certifications: stringList(30),
  industries: stringList(20),
  experience: z
    .array(z.unknown())
    .nullable()
    .transform((items): ResumeAnalysisOutputEntry[] =>
      (items ?? [])
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .slice(0, 60)
        .map((item) => ({
          title: asText(item.title),
          company: asText(item.company),
          startDate: asText(item.startDate),
          endDate: asText(item.endDate),
        })),
    ),
  totalYearsExperience: z.unknown().transform((value) => {
    const years = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/\+$/, '')) : NaN;
    return Number.isFinite(years) && years >= 0 && years <= 80 ? years : null;
  }),
});
export type ResumeAnalysisOutput = z.infer<typeof ResumeAnalysisOutputSchema>;

export const resumeAnalysisPrompt = definePrompt<ResumeAnalysisPromptInput, ResumeAnalysisOutput>({
  area: 'resumes',
  name: 'resume-analysis',
  version: RESUME_READING_VERSION,
  description: "Lists what an uploaded resume's text says about the person (skills, roles, certifications, dates, name).",
  kind: 'resume_analysis',
  system: () => SYSTEM,
  user: (input) =>
    `RESUME TEXT (between the markers):\n<<<RESUME\n${input.text.slice(0, MAX_RESUME_PROMPT_TEXT)}\nRESUME>>>`,
  output: ResumeAnalysisOutputSchema,
});
